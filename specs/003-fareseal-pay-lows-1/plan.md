# Plan: fareseal-pay-lows-1

## Constitution check (`constitution.md`, Fareseal)

- **Art. I** (zero infrastructure): caches stay in-isolate `Map`s. No store, no service. Pass.
- **Art. II §5** (offer before consequence): F6 strengthens it. An agent that presented a payment and was failed by *us* has not ignored the offer, so it is not counted toward the consequence. Art. II §6 (humans): untouched, because humans never reach step 6. Pass.
- **Art. III §9**: the 402 `error` still comes from the fixed `paymentError` table. F3 returns the fixed `not-yet-valid`, not the facilitator text. Pass.
- **Art. IV §13** (clock skew is a fault, not a forgery): F3 applies it to the facilitator's validAfter reject. Pass.
- **Art. V §15**: README states the classification table. It makes no settlement-status claim. Pass.
- **Art. VII §20/§21/§23**: no new config key. Every FR maps to a test (tasks.md). No new dependency. Pass.
- **Art. VII §24** (ADR before contradicting `plan.md`): root `plan.md` says `offer_grace = 3 # distinct 402s before consequence`. ADR-004 (`docs/adr/004-cloudflare-batteries-included.md:32-37`) says "an exact payment already seen (settled or failed) is rejected … Transport/config failures are the operator's own and are never [damped]". F1 and F3 refine *which* failures are the operator's. F6 refines which 402s count. Neither contradicts a decision, and fs-pay-1 T004 made the same kind of refinement without an ADR. **No ADR, no gate.** The README table and the CHANGELOG record it. If the reviewer reads F6 as contradicting "distinct 402s before consequence", the fix is a one-paragraph ADR-007 at GATE F, not a code change.
- Prompt rules: no Stripe file is touched (`packages/adapter-stripe` is not in any task). Tests use the existing stub fetchers only.

## Where the change goes (main `514bb79`)

| Task | Fix | Files |
|---|---|---|
| T001 | F7 | `packages/core/src/config.ts:59` (comment only) |
| T002 | F2 | `packages/adapter-x402/src/index.ts` (`verifyProof` `:213`; a `MAX_X_PAYMENT_CHARS = 8192` check before the `atob` at `:226`), `packages/adapter-x402/test/x402.test.ts`, `packages/cloudflare/test/pages-settle.test.ts` (zero-settle case), `packages/adapter-x402/README.md`, `packages/cloudflare/CHANGELOG.md` |
| T003 | F5 | `packages/cloudflare/src/index.ts:286-294` (`txId` selection), `packages/cloudflare/test/pages-settle.test.ts`, plus the stubs that change: `pages-settle.test.ts` (25 `"0xTX"` occurrences), `packages/cloudflare/test/receipts-waituntil.test.ts:26`, `packages/cloudflare/test/pages-binding.test.ts:184`, `CHANGELOG.md` |
| T004 | F4 | `packages/cloudflare/src/index.ts:286` (`resp.ok && data.settled === true`), `pages-settle.test.ts`, `CHANGELOG.md` |
| T005 | F1 | `packages/cloudflare/src/index.ts:315-332` (classification), `packages/hono/src/index.ts:617-629` (`paymentError` 401/403/429 rows), `packages/hono/test/payment-errors.test.ts` (new rows only), `pages-settle.test.ts`, `packages/cloudflare/README.md` (the FR-001 table, after the "Facilitator damping" paragraph at `:63-66`), `CHANGELOG.md` |
| T006 | F3 | `packages/cloudflare/src/index.ts` (row 5), `pages-settle.test.ts`, README table row, `CHANGELOG.md` |
| T007 | F6 | `packages/core/src/pipeline.ts` (`VerifyPayment` `:90-94` gains `reason?: string`; `isOperatorFault` exported; step 6 `:322-330`), `packages/core/src/index.ts` (export), `packages/hono/src/index.ts` (`paymentError` uses `isOperatorFault`), `packages/core/test/pipeline-payment.test.ts` (or `pipeline-consequence.test.ts`, new cases only), `packages/hono/test/payment-errors.test.ts` (one middleware case), `CHANGELOG.md` |
| T008 | FR-009 | the seven `packages/*/package.json` `version` fields, `packages/cloudflare/CHANGELOG.md` heading |
| T009 | closeout | `specs/003-fareseal-pay-lows-1/closeout.md` |

## Approach

1. **F7**: rewrite one comment. No test (trivial).
2. **F2**: `if (xPayment.length > MAX_X_PAYMENT_CHARS) return fail("malformed");` as the first line of `verifyProof`. hono already maps `malformed` to `malformed X-PAYMENT header`. Red test: a valid signed payment with a junk field, base64 > 8192 chars, that decodes. On main it reaches settle (1 call). See spec US-2 for the `atob` trap: a bare 8193-char string is already malformed on main.
3. **F5**: `const TX_HASH = /^0x[0-9a-fA-F]{64}$/; const txId = [data.transaction, data.tx].map(v => typeof v === "string" ? v.trim() : "").find(v => TX_HASH.test(v)) ?? null;`. Test stubs get one shared constant `TX = "0x" + "ab".repeat(32)`.
4. **F4**: guard the settled branch with `resp.ok`. A non-2xx `settled:true` falls into the classifier.
5. **F1**: replace the `!resp.ok || …` condition with the FR-001 rows 3 → 4 → (5, T006) → 6/7, in that order. `const operatorStatus = resp.status >= 500 || [401, 403, 429].includes(resp.status)`. Row 7 (non-2xx, not operator) is cached and counted like row 6. hono: the status branch at `:621-623` maps 401/403/429 to `OPERATOR_FAULT` too. The README gets the FR-001 table verbatim.
6. **F3**: before the payer-fault `remember`: `if (reason.includes("valid_after")) return { ok:false, payer:null, reason:"not-yet-valid" };`.
7. **F6**: `isOperatorFault(reason?: string): boolean` in core with the FR-006 set. In `decide` step 6: `if (!paid.ok && isOperatorFault(paid.reason)) return { action: "offer", identity, body: buildOfferBody(cfg) };`. The cloudflare classifier keeps its own data-api-specific rows (route `network-mismatch` is ours, but adapter-local `network-mismatch` is the payer's, so it is NOT in the core set). hono `paymentError` calls `isOperatorFault` for its operator-fault branch so the two lists cannot drift.
8. **Versions**: `2.2.0` → `2.3.0` in all seven, minor because behaviour changes. The site vendored `514bb79` as 2.2.0, so a new number tells the next vendor refresh apart. The lockfile records `workspace:` links, not versions. The coder confirms `pnpm install --frozen-lockfile` still passes.

Order: T001 [P] is independent. T002 → T003 → T004 → T005 → T006 share `makeSettlingVerify` and `pages-settle.test.ts`, so they run in that order. T007 after T005, because both edit `paymentError`. T008 and T009 come last.

## Existing tests that change (FR-008, "say which and why")

- **T003**: every `"0xTX"` stub expecting 200 or asserting the surfaced id becomes the valid constant `TX`. Files: `packages/cloudflare/test/pages-settle.test.ts`, `receipts-waituntil.test.ts:26`, `pages-binding.test.ts:184`. Why: F5 makes `"0xTX"` an invalid id by design. The assertions keep their meaning (the id served equals the id answered).
- **T005**: no existing assertion changes. The T004 parametrised cases (`HTTP 401 {ok:false,error}`, `HTTP 503`, `HTTP 502 non-JSON body`, …) stay operator faults under rows 3/4. `payment-errors.test.ts` rows `settle-failed(400)` and `verify-failed(402)` keep `settle failed`. If the coder finds an existing test with a non-2xx status other than 401/403/429/5xx that expects `settle-retryable`, the task note names it. That case moves to row 7 per the prompt.
- **T004**: if an existing stub answers non-2xx with `settled:true` and expects 200, it changes, and the note says why. None was found at planning time.
- The unpaid 402 shape tests (`toll-x402.test.ts:63` and the no-header cases) stay unchanged.

## Risks

- **404 is a payer fault (row 7).** A wrong `settle.url` answers 404 on every payment, so payers get cached and cooled down for our misconfiguration. The prompt's list is explicit: only 5xx/401/403/429. Left as written. GATE F can add 404 to row 4 (one token).
- **`valid_after` substring.** If the facilitator names the code differently, F3 silently does not apply, and behaviour stays as on main (cached, counted). This direction is safe for the operator.
- **F5 strictness.** A non-EVM network would need another id shape. Only `base` and `base-sepolia` are supported (`X402_NETWORKS`), so this holds today. A hash in another format from a future facilitator becomes a cached 402 (row 2), as review 4 L-G notes, even though the money may have moved. Same fail-closed choice as fs-pay-1 T001.
- **F6 opens a maze bypass?** An agent can only claim an operator fault by making *our* settle fail. Rows 3/4 are data-api answers, which the client cannot forge. Row 0c (transport) and 0b (bucket) are ours. After F1, a client-caused 4xx is a payer fault and is recorded. So the bypass needs our outage, which is the intent.

## Verify (every task)

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check
```

This is the CI job in `.github/workflows/ci.yml`, step for step.
