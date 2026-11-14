# Plan: fareseal-contract-o1o4-1

## Constitution check (`constitution.md`)

- Art. I (zero infrastructure; state in-process, LRU allowed): the new state is in-process. It is a per-payer in-flight counter, deleted at 0 and so bounded by running settles, plus one more field on the existing bounded `OfferLedger` entry. Pass.
- Art. II (offer before consequence): O3 makes held repeats after the 60th count as offers. The agent has already had the offer 402 every time, so a maze still comes only after offers. O1's refusal records an offer, as `payer-cooldown` does today; the cost is in spec OQ3. Humans are never on this path. Pass, with the cost written down.
- Art. III / IV (receipts, crypto): no receipt field, no signed byte, no key change. Receipt `count` values come from `offersInWindow`, which O3 can raise. The format does not change. Pass.
- Art. V.14/16 (honest claims, numbers from a committed script): every number in the docs comes from the committed budget suite (FR-008) or is marked as the second review's measurement. Pass.
- Art. VII.20 (no `any` in exported surfaces): the new optional fields are typed. Art. VII.21 (every FR has a test): FR-001…FR-008 each name their tests. FR-009/010 are docs. Art. VII.23: no dependency.
- Art. VII.24 (ADR before a decision that contradicts `plan.md`): the root `plan.md` says nothing on cooldown, reservation or `Retry-After`. ADR-004 (`docs/adr/004-cloudflare-batteries-included.md:32-37`) says "a payer with repeated fresh failures gets a cooldown". O4 adds an exception to it and does not contradict it. **No ADR planned.** GATE 0 decides; if it wants one, an ADR task goes in before T004.
- Prompt gate: "GATE 0 (coordinator) before any code". The rules R-O1…R-O4, the before/after table and the defaults OQ1–OQ4 are in spec.md. GATE 0 is the first line of tasks.md.

## Where the change goes

- `packages/cloudflare/src/index.ts` `makeSettlingVerify` (CF:204-408):
  - new `payerInflight` map next to `inflight` (CF:219);
  - hold check CF:243-250 sets `due` and no longer deletes;
  - cooldown check CF:260-263 becomes `live + inflightOf(payer) >= PAYER_FAIL_LIMIT`, skipped when `due`;
  - after `bucket.tokens -= 1` (CF:272): `if (due) notYetValid.delete(key)` and reserve;
  - row 5 (CF:370-382): skip `remember(notYetValid…)` when `due`, write with time at write (L2);
  - rows 6/7 (CF:388-395): time at write (L2);
  - `finally` (CF:403-405): release; on a due attempt whose result is `isOperatorFault`, put the hold back;
  - held return (CF:247-248) adds `retryAfterS`;
  - the return value gets an `@internal` `_sizes()` hook returning the five map sizes (`Object.assign`). `createPagesMiddleware` keeps using it as `verifyProof`.
- `packages/hono/src/index.ts`: `X402VerifyResult` (:67) gains `retryAfterS?: number`; `offerResponse` (:681) sets `retry-after`.
- `packages/core/src/ledger.ts`: `OfferState.heldInWindow`, `recordHeld()`, resets in `recordOffer`/`recordPaid`.
- `packages/core/src/pipeline.ts`: `HELD_REPEATS_FREE = 60` and step 6 (:383).
- Tests:
  - PS: L1/L4/L2 tests in the describe at PS:1194 (helpers `earlyPayment` :1207, `stubbed` :1217, `facilitator` :1297, `mazeApp`); O1/O4 handler tests there too.
  - New `packages/cloudflare/test/contract-golden.test.ts` + its `__snapshots__/` file (FR-001).
  - New `packages/cloudflare/test/settle-budget.test.ts` (FR-008).
  - `packages/hono/test/payment-errors.test.ts` (O2 unit).
  - `packages/core/test/pipeline-payment.test.ts` (:229-245 held tests) and the ledger test file (O3).
  - Reuse `settleBinding`/`settlingMw`/`envOf` (PS:72-103) and `ctx`/`agent` (`packages/cloudflare/test/helpers.ts`). No new helper module.
- Docs: `packages/cloudflare/README.md` (damping paragraph ~:63-66, table row 5, "Known costs" :95-113), `packages/hono/README.md`, `packages/cloudflare/CHANGELOG.md` `2.3.0 — Unreleased`.
- `specs/005-fareseal-pay-lows-2/closeout.md` line 3 (L5).
- `specs/006-fareseal-contract-o1o4-1/closeout.md`.

## Approach

Golden first, on untouched source, so every later diff to the snapshot is visible and must match a table row. Then the tests-only lows (L1, L4) on the current code. Then L2 (smallest source change). Then O1, because O4 has to bypass O1's check. Then O4, O2 and O3 (O3 is core-only, so it can go in parallel). Then the budget/bounds suite over the finished code, docs, and the closeout. Each behaviour task writes its test first and shows it red on the tree before the task.

## Risks

- **Golden snapshot drift.** Vitest writes missing snapshots locally but not in CI (`CI=true`), so the `.snap` file must be committed in T001. A task that edits an entry not named in its row is a QA reject. Snapshots must be deterministic: mock `Date.now`, use fixed tx ids (`TX`), the fixed test key and fixed nonces.
- **Breaking existing tests silently.** Sequential tests keep their numbers because the merged check equals the old one when nothing is in flight. Concurrent-copy tests (PS:355, :428) join before the check. If any existing test fails, the task must name it, give the A-row that explains it, and update it in the same task. A failure with no A-row means stop and go to GATE 0.
- **O4 opening a drain.** The bypass is consumed by the bucket token and is not held again on row 5, so it is at most once per nonce. The budget suite asserts the 6-per-window ceiling.
- **Order of `due`, token and delete.** The delete and the reservation must happen in the same synchronous run as `settle()` starting (before its first await), or two copies could both pass as due. A test with 20 concurrent copies of a due payment must show 1 call.
- **Slow signing.** Use the 30_000 ms timeout on loops (as PS M1 tests do).

## Verify (every task)

From `.github/workflows/ci.yml`, job `ci`, the same steps in the same order:

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check
```

`pnpm lint` = `biome check .`; `pnpm typecheck` = `tsc -b && tsc -p tsconfig.tests.json`; `pnpm test` = `vitest run`. Tests use in-process stubs and loopback only. No network, no facilitator, chain RPC or Stripe call.

## Invariants (must not move)

Reason strings and 402 texts (HONO `PAYMENT_ERRORS` :596-617, `packages/hono/test/payment-errors.test.ts`), the README classifier table test in PS, receipts and signed bytes (core tests), CLI exit codes, `packages/adapter-x402/**` (discovery), every golden entry except A2's headers. No Stripe line in the diff.
