# Plan: fareseal-pay-lows-2

## Constitution check (`constitution.md`)

- Art. I (zero infrastructure, in-memory state): unchanged; the fix reads an in-memory map that already exists. Pass.
- Art. II (offer before consequence): no change to when an offer is recorded or when the maze fires. N3/N4/N5 options that would move this are at GATE 0, not built. Pass.
- Art. III / IV (receipts, crypto): no receipt, signature or key touched. Pass.
- Art. V (honest enforcement claims): T003 adds an honest known-cost line; T002 makes the README's "three fresh failures" claim true for concurrent requests. Pass.
- Art. VII.21 (every FR has a test): FR-001 → T001 test, FR-002 → T002 test, FR-003/FR-004 are docs. Pass.
- Art. VII.23 (dependency budget): no dependency. Art. VII.24 (ADR before a change that contradicts plan.md): nothing here contradicts the root `plan.md`; no ADR, no ADR gate.

## Where the change goes

- `packages/cloudflare/src/index.ts` `makeSettlingVerify`: the two `remember(payerFails, payer, { n: (fails && now < fails.untilMs ? fails.n : 0) + 1, ... })` writes at :374-377 (row 5) and :386-389 (rows 6/7). T002 replaces `fails` in those two expressions with a fresh `payerFails.get(payer)`. The check at :261-263 stays on the snapshot. Nothing else in the file moves.
- `packages/cloudflare/test/pages-settle.test.ts`: two new `it(...)` blocks inside the describe that defines `earlyPayment` (:1207), `stubbed` (:1217) and `facilitator` (:1297), next to the M1 tests (:1354-1420). Reuse those helpers and the `vi.spyOn(Date, "now")` pattern; no new helper file.
- `packages/cloudflare/README.md` "Known costs" (:95-104) and `packages/cloudflare/CHANGELOG.md` "2.3.0 — Unreleased": one known-cost sentence (N4) and one bullet (N1a).
- `specs/005-fareseal-pay-lows-2/closeout.md`: the closeout table.

## Approach

1. T001, test only: kill mutant M13. One payer, `Date.now` mocked: one fresh early payment (row 5, 1 call); advance 600_001 ms; two fresh early payments (calls 2, 3); one more fresh payment reaches settle (call 4, not `payer-cooldown`). Show it red with CF:375 mutated to `fails ? fails.n : 0`, green on the real code, mutant reverted.
2. T002, test then fix: 3 concurrent fresh unfunded payments from one payer (`Promise.all` through `facilitator()`), then a 4th → `payer-cooldown`, calls 3. Red on main (calls 4, `insufficient_funds`). Fix: re-read the entry in both writes. All existing tests pass unedited.
3. T003, docs: README Known costs + CHANGELOG.
4. T004, closeout.

## Risks

- A concurrent test that does not actually interleave (all three settle before the next reads) would pass on main and prove nothing; the red run on main in the task note is the guard.
- The re-read could change an existing test's numbers. Every existing count test is sequential, where snapshot = re-read, so none should move; if one does, stop and raise it at GATE 0 rather than edit the test.
- The tests sign with secp256k1 and are slow on a loaded host; give new loops the same 30_000 ms timeout the M1 tests use if they loop.

## Verify (every task)

From `.github/workflows/ci.yml` (job `ci`), in order:

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check
```

`pnpm test` = `vitest run`; `pnpm lint` = `biome check .`; `pnpm typecheck` = `tsc -b && tsc -p tsconfig.tests.json`. The tests use in-process stubs and one loopback socket (examples/node), no other network.

## Invariants (pinned by tests that already exist, not edited)

Reasons and 402 texts (PS "README table" test, hono `payment-errors.test.ts`), the sequential cooldown numbers (PS:1354, :1371, :1387, :1407), receipts/signed bytes (core tests), exit codes (cli tests). No Stripe file in the diff.
