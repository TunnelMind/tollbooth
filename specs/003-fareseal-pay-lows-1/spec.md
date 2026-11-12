# Spec: fareseal-pay-lows-1 — the upstream payment-path lows from the tunnelmind-site#118 reviews

**Source:** Josh 2026-11-12: "Put the remaining lows on #118 into follow-up runs." These are the lows that belong upstream in Fareseal. The source is the four review reports, copied into this directory: `site-118-second-review.md` (LOW-1 to LOW-8), `-2.md` (M-1 Case A = LOW-9, L-2, L-3), `-3.md` and `-4.md` (wording only, nothing upstream).
**Base:** main `514bb79` (fs-pay-1 merged as PR #13; see `specs/002-fs-pay-1/`). Branch `crew/fareseal-pay-lows-1`.

## Intent

Close the low-severity holes the #118 reviews found in Fareseal's x402 settle path. A client-caused settle 4xx and an oversize header must not count as our fault. A clock-early authorization must not be burned. A non-2xx or a malformed tx id must not serve. A verified agent retrying during our outage must not be sent to the maze. In the prompt's words: "treat as operator fault only a settle-route HTTP 5xx, 401, 403 or 429, the existing `retryable` / not-configured / network-mismatch reasons, transport errors, and a facilitator answer reported as `(verify|settle)-failed(401|403|429|5xx)`; a settle-route 4xx caused by the client … is a payer fault: cached and counted."

Key sentences from the prompt:
- "Money path: every change is tests first, and each test must fail on the code before the change."
- "Cap X-PAYMENT at 8192 characters in `verifyProof` as `malformed X-PAYMENT header`, before any decode."
- "A transaction id must be a 0x-prefixed 64-hex string after trimming; anything else is `settle failed: no transaction id`."
- "the unpaid 402 shape and every existing test stay unchanged unless a fix above requires it (say which and why)."
- "Stripe stays: remove or gate no Stripe code. No call to a real facilitator, wallet or the live site in tests."

## Finding check against main `514bb79` (planner, 2026-11-11)

| Fix | Review id | Location on main | Present? |
|---|---|---|---|
| F1 | LOW-1, LOW-9 | `packages/cloudflare/src/index.ts:317-326`: `!resp.ok` makes every non-2xx an operator fault, and the regex `/^(verify\|settle)-failed\(5\d\d\)$/` makes 401/403/429 a payer fault. `packages/hono/src/index.ts:621-623` maps `(verify\|settle)-failed(<500)` to `settle failed` | Yes |
| F2 | LOW-8 | `packages/adapter-x402/src/index.ts:225-229`: `JSON.parse(atob(xPayment))` with no length check | Yes |
| F3 | LOW-2 | `packages/cloudflare/src/index.ts:327-332`: any facilitator `settled:false` reason, including `invalid_exact_evm_payload_authorization_valid_after`, is `remember`ed and counted | Yes |
| F4 | LOW-3 | `packages/cloudflare/src/index.ts:286`: `if (data.settled === true)` runs before any `resp.ok` test | Yes |
| F5 | L-2 (review 2) | `packages/cloudflare/src/index.ts:289-294`: any non-empty string id is accepted, so `" "` serves | Yes |
| F6 | LOW-5 | `packages/core/src/pipeline.ts:323-352`: a failed step-6 payment falls through to step 7 (consequence when `exhausted`) and step 8 (`recordOffer`) whatever the reason | Yes |
| F7 | L-3 (review 2) | `packages/core/src/config.ts:59` "Clock drift accepted on a proof's validAfter/validBefore" | Yes |
| F8 | LOW-4 | data-api settle route, not this repo | Record only |

## User Scenarios

### US-1 — A client-caused settle error is the payer's, and our faults stay ours (F1, P1)
- **AC-1.1** Given the settle route answers HTTP 400 (for example `{ok:false,error:"payment too large"}`), then the payment is cached for the nonce, the payer's failure count goes up by 1, the 402 `error` is `settle failed`, and a second identical `X-PAYMENT` does not reach settle (settle calls = 1). On main: not cached, settle calls = 2.
- **AC-1.2** Given three fresh payments from one payer that each get an HTTP 400 from the settle route, then the fourth fresh payment gets `payer-cooldown` without a settle call. On main: no cooldown.
- **AC-1.3** Given the settle route answers HTTP 401, 403, 429 or any 5xx, then the result is `settle-retryable`: not cached, not counted (as on main).
- **AC-1.4** Given HTTP 200 `{settled:false, reason:"verify-failed(401)"}` (or `settle-failed(403)`, `verify-failed(429)`), then the result is `settle-retryable`: not cached, not counted, and the 402 `error` is the operator-fault string. On main: cached and counted, `settle failed`.
- **AC-1.5** Every row of the FR-001 table has a passing test, and the table is in `packages/cloudflare/README.md`.

### US-2 — An oversize X-PAYMENT is refused before decode (F2, P1)
- **AC-2.1** Given an `X-PAYMENT` longer than 8192 characters, then `verifyProof` returns `malformed` without calling `atob` or `JSON.parse`, the 402 `error` is `malformed X-PAYMENT header`, and the settle stub records zero calls.
- **AC-2.2** Given a valid, correctly signed payment whose base64 is exactly 8192 characters (padded with an extra JSON field), then the local check passes.
- **Red-on-main note:** a header of exactly 8193 base64 characters is length ≡ 1 mod 4, and `atob` already throws on it, so it is `malformed` on main too. The red test must use a valid signed payment of more than 8192 characters that decodes: 8196 characters (an extra JSON field), or 8192 valid characters plus one trailing space (`atob` strips ASCII whitespace). On main that header reaches settle once. The 8193-character case from the prompt is kept as well, for the zero-settle assertion.

### US-3 — A clock-early authorization can be paid again seconds later (F3, P2)
- **AC-3.1** Given the facilitator rejects with a reason containing `valid_after` (for example `invalid_exact_evm_payload_authorization_valid_after`, HTTP 200 `settled:false`), then the payment is not cached, the payer's failure count is unchanged, and the 402 `error` is `authorization not yet valid`.
- **AC-3.2** Given the same `X-PAYMENT` is retried and the settle stub now answers `settled:true` with a valid tx, then it is served 200. On main: the retry gets 402 `facilitator rejected: …` and settle calls stay at 1.
- **AC-3.3** Given four such rejects in a row for one payer, then the payer is not put on cooldown.

### US-4 — A non-2xx is never proof of payment (F4, P1)
- **AC-4.1** Given HTTP 500 with `{data:{settled:true, tx:<valid>}}`, then the request gets 402 and is not served. On main: 200. It is classified by status like any other non-2xx (FR-001), so a 5xx is `settle-retryable`.
- **AC-4.2** Given HTTP 400 with `settled:true`, then the request gets 402 and is classified as a payer fault (FR-001 row 7).

### US-5 — Only a real transaction hash reaches the payer (F5, P1)
- **AC-5.1** Given `tx` (or `transaction`) is `" "`, `""`, `123`, `null`, `"0xTX"`, a 63- or 65-hex-digit value, or a hash without `0x`, then the result is 402 `settle failed: no transaction id`, remembered for the nonce, and the payer is not counted. On main: `" "` and `"0xTX"` serve 200.
- **AC-5.2** Given `tx: "  0x<64 hex>\n"`, then the request is served and `X-PAYMENT-RESPONSE.transaction` is the trimmed hash.
- **AC-5.3** Given both `transaction` and `tx` are valid, then `transaction` wins (existing test, still passing).

### US-6 — Our outage never sends a verified agent to the maze (F6, P1)
- **AC-6.1** Given a Web-Bot-Auth verified agent, `offer_grace = 3`, the maze enabled, and a payment that fails four times in a row with an operator-fault reason (`settle-retryable`, `settle-throttled`, `settlement-unconfigured` or `settle-unreachable`), then every attempt gets the 402 offer, none is recorded in the offer ledger, and none gets the consequence. On main: the 4th attempt is a `consequence` (`toll-ignored`).
- **AC-6.2** Given the same agent with a payer-fault reason (for example `expired`), then today's behaviour holds: recorded, and the consequence comes after the grace (existing tests unchanged).
- **AC-6.3** Given an agent that is already over the grace (`exhausted`) and then presents a payment that fails with an operator fault, then it gets the offer, not the consequence: it is paying, not ignoring the offer (Art. II §5).

### US-7 — The config comment says what the code does (F7, P3)
- **AC-7.1** The comment on `skew_tolerance` in `packages/core/src/config.ts` says the drift is tolerated by the local check only, and that the facilitator decides the rest.

## Functional Requirements

- **FR-001** `makeSettlingVerify` (`packages/cloudflare/src/index.ts`) classifies a settle answer by this table. The first row that matches wins:

| # | Settle answer | Class | Result reason | Cached for nonce | Counted to cooldown |
|---|---|---|---|---|---|
| 0a | no settle token configured | operator | `settlement-unconfigured` | no | no |
| 0b | the per-isolate settle bucket is empty | operator | `settle-throttled` | no | no |
| 0c | the settle call throws, or a 2xx body is not JSON | operator | `settle-unreachable` | no | no |
| 1 | HTTP 2xx and `data.settled === true` and a valid tx id (FR-005) | paid | — (served) | yes, `already-settled` | cleared |
| 2 | HTTP 2xx and `data.settled === true` and no valid tx id | settle-endpoint fault | `no-transaction-id` | yes | no |
| 3 | `data.retryable === true`; or `data.reason` is `settlement-not-configured` or `network-mismatch`, or starts with `verify-error:` / `settle-error:`, or matches `^(verify\|settle)-failed\((5\d\d\|401\|403\|429)\)$` | operator | `settle-retryable` | no | no |
| 4 | HTTP status 5xx, 401, 403 or 429 (whatever the body, including `settled:true`) | operator | `settle-retryable` | no | no |
| 5 | `data.reason` contains `valid_after` (F3) | payer clock, transient | `not-yet-valid` | no | no |
| 6 | HTTP 2xx `settled:false` with any other reason | payer | `data.reason`, else `settle-failed` | yes | yes |
| 7 | any other HTTP status (a 4xx the client caused, e.g. 400, 404, 413, 422), whatever the body, including `settled:true` | payer | `data.reason` if a string, else `settle-failed` | yes | yes |

- **FR-002** `paymentError` (`packages/hono/src/index.ts`) maps `(verify|settle)-failed(401|403|429)` to the operator-fault string. Every other `<500` status keeps `settle failed`. The existing rows `settle-failed(400)` and `verify-failed(402)` stay `settle failed`.
- **FR-003** `verifyProof` (`packages/adapter-x402/src/index.ts`) returns `malformed` when `xPayment.length > 8192`, before `atob`. The constant is named, it is the only size limit, and the README of adapter-x402 states it.
- **FR-004** A settle failure whose `data.reason` contains `valid_after` returns `not-yet-valid` (table row 5). It is neither remembered nor counted. It is not an operator fault for FR-006.
- **FR-005** A transaction id is valid when, after `.trim()`, it is a string matching `^0x[0-9a-fA-F]{64}$`. The id served is the first valid one of `data.transaction`, `data.tx`. The surfaced value is the trimmed string. No valid id gives table row 2.
- **FR-006** Core exports one predicate, `isOperatorFault(reason)`, from `packages/core/src/pipeline.ts`. It is true for `settle-retryable`, `settle-throttled`, `settlement-unconfigured`, `settlement-not-configured`, `settle-unreachable`, `(verify|settle)-error:*` and `(verify|settle)-failed(5xx|401|403|429)`. `VerifyPayment`'s result gains an optional `reason?: string`, which `X402VerifyResult` already carries. In `decide` step 6, a failed payment whose reason is an operator fault returns the offer immediately: it skips the step-7 consequence check and the step-8 `recordOffer`. `paymentError` in hono uses the same predicate for its operator-fault rows, so the two cannot drift.
- **FR-007** The `skew_tolerance` comment in `packages/core/src/config.ts` reads in substance: "Clock drift tolerated by the local check on validAfter/validBefore; the facilitator applies its own clock. Offers still advertise 300 s."
- **FR-008** The unpaid 402 (no `X-PAYMENT`) stays byte-identical. Existing tests stay unchanged except those listed in plan.md "Existing tests that change", each with its reason.
- **FR-009** CHANGELOG: one entry per fix in `packages/cloudflare/CHANGELOG.md` (the repo's single changelog). All seven `package.json` versions move together from 2.2.0 to 2.3.0 (`publish.yml` refuses mixed versions), and the `## Unreleased` heading becomes `## 2.3.0 — Unreleased`, following the `## 2.1.0 — Unreleased` precedent. Nothing is published.
- **FR-010** The closeout records LOW-4 as a follow-up for tunnelmind-data-api: on a spent nonce, the settle route returns the recorded settlement for payer+nonce once. Nothing is built for it here.

## Success Criteria

- **SC-001** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check` exits 0 after every task.
- **SC-002** `packages/cloudflare/test/pages-settle.test.ts` has one passing test per FR-001 row: ≥ 11 cases, counting rows 0a-0c, 1, 2, and rows 3/4 parametrised over 401, 403, 429 and 5xx in both the status and the reason form. Each task note shows its new tests failing on the pre-task code.
- **SC-003** An `X-PAYMENT` of more than 8192 characters gives 402 `malformed X-PAYMENT header` with the settle stub at 0 calls, and an exactly-8192-character valid payment passes `verifyProof`.
- **SC-004** A core pipeline test shows 4 operator-fault attempts with `offer_grace = 3` giving 4 offers, 0 consequences and 0 ledger offers. The existing consequence tests in `packages/core/test/pipeline-consequence.test.ts` pass unchanged.
- **SC-005** `grep -n "accepted" packages/core/src/config.ts` prints no line about clock drift.
- **SC-006** `git diff main --stat` touches only this repo. No `adapter-stripe` source changes. Every `packages/*/package.json` shows `"version": "2.3.0"`. No tag is created and nothing is published.
- **SC-007** No test calls a real facilitator, wallet or tunnelmind.ai. All settle calls go through the existing stub fetchers. Check: `grep -rn "https://" ` over the new test code finds only `example` / stub hosts.

## Edge Cases

- A non-2xx body that does not parse: `data` is `{}`, so the status decides (row 4 or row 7) and the reason is `settle-failed`.
- A `retryable:true` on a 400: row 3 wins, so it is an operator fault. The explicit flag beats the status.
- A `valid_after` reason on a 5xx: row 4 wins (operator).
- A 404 from the settle route is usually a wrong `settle.url`, which is the operator's config. The prompt's list makes it a payer fault (row 7). See plan Risks. The coordinator or Josh may move it at GATE F.
- `inflight` followers get the leader's reason, as today. For F3 that is `not-yet-valid`, and nothing is cached.
- F5: `transaction` is invalid and `tx` is valid → `tx` is served. Both are invalid → row 2.
- F2: a header of exactly 8192 characters is not refused by length. Whitespace counts toward the length.
- F6: an anonymous agent was never ledgered, so nothing changes for it. A human never reaches step 6.

## Assumptions

- The data-api settle route (clone `ed545f6`, `api/routes/fareseal-settle.js`) answers payer faults as HTTP 200 `settled:false`, uses 4xx only for malformed calls, and reports facilitator HTTP errors as `(verify|settle)-failed(<status>)` (review 2 M-1 Case A). It is not changed in this run.
- The CDP facilitator's not-yet-valid code contains `valid_after` (`invalid_exact_evm_payload_authorization_valid_after`, the x402 reference name). Review 1 says this is not verified against the live facilitator. The match is a substring, so close variants still hit.
- Rows 0a-0c keep their existing internal reason strings, so no consumer of those strings breaks.

## Out of Scope

- LOW-4 code (data-api), LOW-6 and LOW-7 (tunnelmind-site), L-1 (site test title), every wording finding of reviews 3 and 4.
- The site vendor refresh (a separate run), npm publish, git tags, GitHub repo rename, deploys.
- Any Stripe change. Any data-api or tunnelmind-site change.
- A shared nonce store across isolates (Art. I).
