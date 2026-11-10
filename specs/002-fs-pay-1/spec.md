# Spec: fs-pay-1 — the payment-path bugs in Fareseal's 402 flow

**Source:** Josh's prompt "fs-pay-1: the four payment bugs (review 06-tollbooth.md §C "402 flow", top fixes 1-4)", and the 2026-11-10 code review `~/.crew/coord/review-2026-11-10/06-tollbooth.md` §C4 (C-1 to C-4) and §C5 rows 1–4, plus roadmap D #8 ("Fail loudly at startup on an unknown network (S3)").
**Base:** origin/main `1b566a6` (fareseal-rename-1 merged as PR #12; this branch `crew/fs-pay-1` is at that commit).

## Intent

Fix the bugs a real payer would hit in Fareseal's x402 payment path: the settle transaction id that never reaches the payer, rejection reasons that are thrown away, zero clock-skew tolerance, operator-side settle failures charged to the payer, and a network typo that fails open. In Josh's words, every failure today answers "X-PAYMENT header is required", and "a typo in `toll.x402.network` … must fail loudly at startup/config validation, not throw per request and fail open."

Key sentences from the prompt:
- "Accept both names (`transaction` first, then `tx`), and fail the settle as "no transaction id" when neither is present."
- "Return the real reason in the 402 body in the x402 v1 `error` field … without leaking internals."
- "allow a small configurable skew (default stated in the README) so a client clock one second ahead is not rejected."
- "Operator-side settle failures (facilitator timeout, 5xx, missing credentials) are not cached and not counted against the payer … A payer-side failure is still cached."
- "Tests and their fix go in ONE task. Existing behaviour not named here stays byte-identical."

## Finding check against origin/main (done by the planner, 2026-11-10)

| Finding | Prompt cite (pre-rename) | origin/main location | Still present? |
|---|---|---|---|
| T001 tx vs transaction | `packages/cloudflare/src/index.ts ~279` | `packages/cloudflare/src/index.ts:283-285` (`typeof data.transaction === "string"`); data-api `api/routes/tollbooth-settle.js` (origin/main `0400d01`) returns `{settled, payer, tx, network, receipt_logged}` | Yes |
| T002 reasons discarded | `packages/hono/src/index.ts ~648` | `packages/hono/src/index.ts:654` (`error: "X-PAYMENT header is required"`); `payment` captured at `:781-799`, never read by `offerResponse` (`:640`) | Yes |
| T003 zero skew | `packages/adapter-x402/src/index.ts ~257` | `packages/adapter-x402/src/index.ts:256-262` (`validAfter > nowS`, `validBefore < nowS`, `validBefore - nowS > MAX_TIMEOUT_SECONDS`) | Yes |
| T004 operator failures charged to payer | `packages/cloudflare/src/index.ts ~284-291` | `packages/cloudflare/src/index.ts:291-297` (every `settled:false` → `remember(seenPayments…)` + `payerFails` +1); a non-2xx with a non-`data` JSON body (data-api `apiError` 401/503) also lands there as `settle-failed` | Yes |
| T005 network typo fails open | (S3; `adapter-x402/src/index.ts:116-123`) | `packages/core/src/config.ts:50` (`network: z.string().min(1)`); `networkOf` throws inside `buildOffer` per request; the catch in `packages/hono/src/index.ts:948-962` hands the request to the origin → content served free. With a verify-only adapter the typo trips the misleading "refused on mainnet" error instead | Yes |

None is already fixed. "Wrong asset" has no config key: the asset is derived from the network (`NETWORKS` in `packages/adapter-x402/src/index.ts:27-46`) and is not a field of an x402 v1 `exact` payload; a payment signed for another asset's EIP-712 domain recovers a different signer and is rejected as `signer-mismatch`. So "unknown asset" (T005) is covered by "unknown network", and "wrong asset" (T002) is reported as the invalid-signature reason.

## User Scenarios

### US-1 — A payer gets its transaction id (P1)
An agent pays a tolled page on a site using the Cloudflare binding and the data-api settle route.
- **AC-1.1** Given the settle endpoint answers `{settled:true, payer, tx:"0xTX"}`, when the agent retries with `X-PAYMENT`, then it gets 200 and `X-PAYMENT-RESPONSE` decodes to `{success:true, transaction:"0xTX", network, payer}`.
- **AC-1.2** Given the endpoint answers with `transaction:"0xA"` and `tx:"0xB"`, then `transaction` is `"0xA"`.
- **AC-1.3** Given the endpoint answers `{settled:true}` with neither name (or a non-string / empty value), then the request gets the 402 with `error` naming "no transaction id", content is not served, and the payment is remembered so it is never relayed to settle twice.

### US-2 — A rejected payer learns why (P1)
- **AC-2.1** Given an `X-PAYMENT` header that fails for reason R (table in FR-004), then the 402 body's `error` is exactly the public string for R; every other byte of the 402 body and headers is unchanged.
- **AC-2.2** Given no `X-PAYMENT` header, then `error` is still `"X-PAYMENT header is required"` (byte-identical to today).
- **AC-2.3** Given a settle reason containing internal text (`verify-error: fetch failed at https://…`), then the `error` contains none of that text.

### US-3 — A client clock slightly ahead still pays (P2)
- **AC-3.1** Given default config and a client whose clock is 1 s ahead (`validBefore = now + 301`, `validAfter = now + 1`), then `verifyProof` returns ok.
- **AC-3.2** At the edge: `validBefore = now + 300 + skew` passes, `+ skew + 1` fails `window-too-long`; `validAfter = now + skew` passes, `+ skew + 1` fails `not-yet-valid`.
- **AC-3.3** With `skew_tolerance = "0s"` the old checks hold exactly (`+301` fails).

### US-4 — The operator's fault is not the payer's (P1)
- **AC-4.1** Given the settle endpoint fails on the operator's side (classes in FR-008), then the payment is not cached, the payer's failure count is unchanged, the 402 `error` says the fault is the operator's and the same payment may be retried, and an immediate retry of the same `X-PAYMENT` reaches the settle endpoint again.
- **AC-4.2** Given four operator-side failures in a row for one payer, then the payer is not put on cooldown.
- **AC-4.3** Given a payer-side failure (`{settled:false, reason:"insufficient_funds"}`), then behaviour is today's: cached, counted, cooldown after 3.

### US-5 — A network typo stops the deploy, not the toll (P1)
- **AC-5.1** Given `[toll.x402] network = "base-mainnet"` (or any name not in the supported set), when the config is parsed, then `parseConfig` throws a `ConfigError` whose message names `toll.x402.network` and lists the supported networks.
- **AC-5.2** Given `createPagesMiddleware` with that config, then the first request fails at state build instead of serving content untolled.

## Functional Requirements

- **FR-001** `makeSettlingVerify` takes the transaction id from `data.transaction` if it is a non-empty string, else from `data.tx` if it is a non-empty string.
- **FR-002** On `settled:true` with no transaction id, the result is `{ok:false, payer:null, reason:"no-transaction-id"}`; the payment key is remembered (money may have moved, never re-settle) and the payer's failure count is not incremented (the fault is the settle endpoint's).
- **FR-003** The 402 body's `error` carries the public reason when an `X-PAYMENT` header was presented and rejected; otherwise `"X-PAYMENT header is required"`. Applies to both 402 paths in `packages/hono/src/index.ts` (the `offer` decision and the no-maze consequence fallback).
- **FR-004** Public reasons are a fixed table (no free text from internals passes through):

| internal reason (source) | public `error` |
|---|---|
| `malformed` (adapter) | `malformed X-PAYMENT header` |
| `network-mismatch` (adapter, settle route) | `wrong network` |
| `wrong-recipient` (adapter) | `wrong payTo` |
| `insufficient-value` (adapter) | `amount too low` |
| `expired` (adapter) | `authorization expired` |
| `not-yet-valid` (adapter) | `authorization not yet valid` |
| `window-too-long` (adapter) | `authorization validity window too long` |
| `bad-signature`, `signer-mismatch` (adapter) | `invalid signature (wrong signer or wrong asset)` |
| `already-settled` (cloudflare) | `nonce already used` |
| `payer-cooldown` (cloudflare) | `payer cooling down after repeated failures; retry later` |
| `no-transaction-id` (cloudflare, FR-002) | `settle failed: no transaction id` |
| `settle-failed`, `settle-failed(<status>)`, `verify-failed(<status>)` with status < 500 | `settle failed` |
| operator-side (FR-008), incl. today's `settle-throttled`, `settlement-unconfigured`, `settle-unreachable` | `settlement unavailable (operator fault); retry the same payment` |
| any other string matching `^[a-z0-9_]{1,64}$` (a facilitator `invalidReason` / `errorReason` code passed through by the settle route) | `facilitator rejected: <code>` |
| anything else | `payment rejected` |

- **FR-005** `verifyProof`'s internal reason strings, `X402VerifyResult`'s shape and the report JSON are unchanged (no consumer outside the 402 body changes).
- **FR-006** New config key `toll.x402.skew_tolerance` (duration, default `"60s"`, same `duration()` helper as `wba_skew_tolerance`). `verifyProof` rejects `not-yet-valid` only when `validAfter > now + skew`, and `window-too-long` only when `validBefore − now > MAX_TIMEOUT_SECONDS + skew`. `expired` (`validBefore < now`) keeps no skew. `MAX_TIMEOUT_SECONDS` advertised in offers stays 300.
- **FR-007** README `[toll.x402]` section documents `skew_tolerance` and its 60 s default.
- **FR-008** Operator-side settle failures in `makeSettlingVerify` are: the settle response's HTTP status is not 2xx; `data.retryable === true`; `data.reason` is `settlement-not-configured` or `network-mismatch` (local verify already matched the site's network, so a mismatch at the route is the operator's config); `data.reason` starts with `verify-error:` or `settle-error:` (facilitator transport errors and timeouts); `data.reason` matches `^(verify|settle)-failed\(5\d\d\)$`. These return `reason:"settle-retryable"`, do not `remember` the payment and do not touch `payerFails`. The existing not-cached paths (`settle-throttled`, `settlement-unconfigured`, `settle-unreachable`) keep their internal strings and behaviour.
- **FR-009** Every other `settled:false` (payer-side) keeps today's caching and counting byte-for-byte.
- **FR-010** `toll.x402.network` is validated by the zod schema in `packages/core/src/config.ts` against one exported list of supported names (`["base-sepolia", "base"]`); `NETWORKS` in `packages/adapter-x402/src/index.ts` is typed so its keys must equal that list (a compile error if they drift).

## Success Criteria

- **SC-001** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check` exits 0 after every task.
- **SC-002** `packages/cloudflare/test/pages-settle.test.ts` has passing cases for `transaction` only, `tx` only, both (transaction wins), neither (402, settle called once across two tries).
- **SC-003** `packages/hono/test/toll-x402.test.ts` (or a new `payment-errors.test.ts`) has one passing case per row of the FR-004 table (≥14 cases) plus the no-header case.
- **SC-004** `packages/adapter-x402/test/x402.test.ts` has the four edge cases of AC-3.2, AC-3.1 and AC-3.3.
- **SC-005** `pages-settle.test.ts` has one passing case per FR-008 class (≥6) proving no cache + no count, and AC-4.3 still passes.
- **SC-006** `parseConfig` with `network = "mars"` throws a message matching `/toll\.x402\.network/`.
- **SC-007** `git diff origin/main --stat` touches no file outside this repo; no npm publish, no deploy.

## Edge Cases

- `transaction: ""` or a non-string: treated as absent (falls through to `tx`, then FR-002).
- A shared in-flight settle that ended `settle-retryable`: followers get the same reason (today's `leader.reason`), nothing cached.
- A `settle-retryable` payment retried after its `validBefore`: now fails locally as `expired` (payer-side, cheap, never reaches settle).
- Settle response body not JSON with a 5xx: today it throws into the catch (`settle-unreachable`, not cached); stays that way.
- `skew_tolerance` larger than the authorization window: allowed; the operator's choice.
- `x402.enabled = false` with an unknown network: still a config error (the key is validated regardless).

## Assumptions

- The data-api settle route (`api/routes/tollbooth-settle.js` on data-api origin/main `0400d01`) is not changed in this run (prompt: "no change to tunnelmind-data-api"). The middleware classifies by HTTP status and the reason strings that route emits today; `retryable` is honoured if a later route version sends it.
- `no-transaction-id` follows the prompt literally (fail, do not serve). The payment is remembered so it is never settled twice. See plan Risks.
- The public strings in FR-004 are new stable API; clients may match on them.
- No `x-fareseal-payment-error` header (the review suggested one; the prompt asks only for the body `error`).

## Out of Scope

- C-5 (redirect / trailing slash), C-6 (`PAID_UNSERVED`), C-7, C5 rows 5–10, x402 v2, CORS `Access-Control-Expose-Headers`, `mimeType`, `outputSchema`.
- Any change to tunnelmind-site, tunnelmind-data-api, npm publish, deploys, hosts, Cloudflare, Supabase, DNS.
- The first real mainnet payment, the re-vendor into the site and the npm publish (Josh's, see tasks O001).
