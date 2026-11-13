# Spec: fareseal-pay-lows-2 — the lows left open by the second review 3 of fareseal-pay-lows-1

**Source:** Josh's prompt (2026-11-13), brought from another chat: "fix the low findings left open by the independent second review of tollbooth#14 (Fareseal payment path lows). Stripe stays: remove no Stripe code."
**Findings file:** `~/.crew/coord/fix5/fareseal-pay-lows-1-second-review-3.md` (PASS with lows, on dd35fc2). It is the same review as `specs/003-fareseal-pay-lows-1/second-review-dd35fc2.md`.
**Base:** main `705cc57`. dd35fc2 is an ancestor; `git log dd35fc2..705cc57 -- packages/cloudflare/src/index.ts packages/cloudflare/test/pages-settle.test.ts` is empty, so every line number below is the same on main as in the review.

## Intent

Close every low from the second review that can be closed without a change a caller or operator would notice, each with a test that fails before the fix and passes after. Lows that need a behaviour change, a new header or a decision go to GATE 0 with the options, and nothing ships to anyone: one DRAFT PR comes back to Josh.

Key sentences from the prompt:
- "first RE-VERIFY each low against current main with file:line: a low already fixed, or no longer true, is listed as such and not touched."
- "the smallest fix that closes it, with a test that fails before and passes after (for a surviving mutant: a test that kills it)."
- "A low that cannot be fixed without a behaviour change an operator or caller would notice, a format change, a key or a deploy is NOT fixed: it is written up at a planner gate (GATE 0, coordinator) with the options."
- "No refactor, no new dependency, no change outside what the lows need. Existing tests stay unedited unless a low is about that test."
- "Invariants that must not move ...: signed bytes, receipt and log formats, exit codes, public API shapes."
- "Do not merge, do not deploy, no migration, no flag switched on, no key or secret generated or read, no host access, no network beyond loopback in tests."

## Re-verification against main 705cc57 (planner, 2026-11-13)

CF = `packages/cloudflare/src/index.ts`, PS = `packages/cloudflare/test/pages-settle.test.ts`, README = `packages/cloudflare/README.md`.

| Low | Still true on main? | Evidence | Plan |
|---|---|---|---|
| N1 per-payer limit not atomic | Yes | CF:261 reads `fails = payerFails.get(payer)` before the `await routedFetch` (CF:275); the writes at CF:374-377 (row 5) and CF:386-389 (rows 6/7) use that old snapshot, so N concurrent failures all write `n = old + 1` | Part (a) fixed in T002: re-read the entry at write time, so N concurrent failures count N (the README's "three fresh failures inside ten minutes", README:66-67, becomes true for concurrent requests too). Part (b), reserving in-flight attempts before the await, refuses a payer before any failure: an honest caller would notice → GATE 0, option O1 |
| N2 surviving mutant M13 | Yes | CF:375 `fails && now < fails.untilMs ? fails.n : 0`; no test makes a row-5 reject after an expired window and checks the count restarted. The test at PS:1516 ("remembered map is capped") steps 600_001 ms, but its check happens after each window has expired, so it passes under M13 too | Fixed in T001: a test that kills M13 |
| N3 no Retry-After on `settle-throttled` / held `not-yet-valid` | Yes | `grep -rni retry-after packages/*/src` finds nothing | Adding a header changes the 402 shape callers see → GATE 0, option O2. Not fixed |
| N4 held repeats stretch the offer grace | Yes, and not recorded | README:95-104 "Known costs" does not name it | The fact is recorded in README Known costs and CHANGELOG (T003, docs only). Capping held repeats per agent key changes when a verified agent is mazed → GATE 0, option O3 |
| N5 recorded costs (A16 clock-fast funded payer; A17 facilitator clock behind) | Already recorded | README:99-104 names both | No change. The "let a due hold through a cooldown" softening changes behaviour → GATE 0, option O4 |
| N6 cooldown map eviction is amnesty | Already recorded | README:67 "Eviction is amnesty." | No change; the review says "No change asked" |
| Could not determine: live facilitator reason string and clock; real Pages runtime (per-isolate budgets); hung settle route; 5xx from a locally valid payload | Not decidable in this repo without network or a deploy | README:91-93 already records the no-timeout cost | Owner items (O001), not agent work |
| Could not determine: CI, `bun examples/bun-hono/check.ts`, bench check not run | Decidable | `.github/workflows/ci.yml` | This run's verify command runs all of them every task; GATE F requires CI green |

## User Scenarios

### US1 — a cooldown window that has expired does not carry its count (N2)
A payer gets one row-5 (`valid_after`) reject, then waits past the 600 s cooldown window, then gets two more row-5 rejects on fresh nonces.
- **Given** that history, **when** the payer sends one more payment, **then** it reaches settle (4 settle calls in all), it does not get `payer-cooldown`.
- **Given** the M13 mutant (CF:375 written `fails ? fails.n : 0`), **then** that test fails.

### US2 — concurrent failures from one payer all count (N1, part a)
One payer sends 3 fresh unfunded payments at the same time (`Promise.all`); all 3 reach settle and fail (`insufficient_funds`).
- **When** the same payer sends a 4th payment afterwards, **then** it is answered `payer-cooldown` with no settle call (settle calls stay 3).
- On main it reaches settle (4 calls), because all 3 concurrent writes stored `n = 1`.

### US3 — the docs say what held repeats cost (N4)
An operator reading README "Known costs" learns that a verified unfunded agent can stay on the offer (402) longer than three requests by sending held early payments from throwaway payer keys, and what bounds it (no content, no settle call per held repeat, mazed once three first attempts are recorded).

## Functional Requirements

- **FR-001** (N2) A row-5 reject whose payer's previous cooldown window has expired starts the count at 1 again. A test in PS pins this and fails on the M13 mutant.
- **FR-002** (N1a) Rows 5, 6 and 7 compute the new count from `payerFails.get(payer)` read after the settle answer, not from the snapshot taken before the await. No other behaviour changes: same reasons, same `PAYER_FAIL_LIMIT` (3), same `PAYER_COOLDOWN_MS` (600 000), same caps.
- **FR-003** (N4) README "Known costs" and the 2.3.0 CHANGELOG entry state the held-repeat cost in one or two sentences, with the review's measured numbers (121 × 402 at 1 request/s before the first 302; main: 3; 5 settle calls in 280 s) marked as measured by the second review on dd35fc2.
- **FR-004** `specs/005-fareseal-pay-lows-2/closeout.md` has the table: low → closed (file:line + test) / already fixed or recorded / not fixed (why, which GATE 0 option the owner decides).
- **FR-005** No Stripe file, no `packages/core/src/voucher.ts`, no lockfile, no workflow and no `package.json` changes. No existing test is edited.

## Success Criteria

- **SC-001** The full verify command (plan.md) exits 0 at the end of every task.
- **SC-002** The T001 test fails when CF:375 is changed to `fails ? fails.n : 0` and passes on the real code (the coder shows both runs in the task note; the mutant is reverted).
- **SC-003** The T002 test fails on main (shown in the task note: 4 settle calls, reason `insufficient_funds`) and passes after.
- **SC-004** `git diff main --stat` at the end names only: PS, CF, README, `packages/cloudflare/CHANGELOG.md`, and files under `specs/005-fareseal-pay-lows-2/`.
- **SC-005** `git diff main -- packages | grep -iE '^[+-].*(stripe|voucher)'` prints nothing.

## Edge Cases

- The T002 re-read must not change the single-request path: for one request the re-read equals the snapshot, so every existing sequential test (PS:1354, :1371, :1387, :1407, row tables) passes unedited. If any existing test fails, the task stops and the case goes to GATE 0; the test is not edited.
- A successful settle between the snapshot and the write deletes the entry (CF:319); the re-read then starts at 1, which is what a fresh failure after a success should do.
- The row-5 hold (`notYetValid`) is unchanged; only the count expression moves.
- Concurrent tests must not depend on wall time: mock `Date.now` as the existing M1 tests do.

## Assumptions

- "tollbooth#14" is the merged fareseal-pay-lows-1 PR; the repo slug is still `tollbooth` (memory: rename PRs in flight).
- No version bump: 2.3.0 is still "Unreleased" in the CHANGELOG, so the new bullet goes under it.
- The coordinator passes GATE 0 by checking that each not-fixed low has its options written below; the choices are Josh's and travel with the draft PR. None of T001–T004 depends on the choice.

## Open Questions (GATE 0 — options for the owner; the tasks do not wait on them)

- **O1 (N1b)** Reserve per-payer in-flight attempts before the settle await (refuse when failures + in flight ≥ 3; release on success or operator fault). Gain: one payer cannot take the whole settle bucket (20 calls) with one concurrent burst. Cost: an honest payer with 3 payments in flight gets `payer-cooldown` on a 4th before any has failed. Options: (a) leave it, keys are free and rotation reaches the same ceiling (A11b, 315 calls); (b) reserve, with a new reason text or reuse `payer-cooldown`; (c) reserve only for nonces that are failing.
- **O2 (N3)** Add `Retry-After` to the `settle-throttled` 402 (`1`) and to the held `not-yet-valid` 402 (seconds until `validAfter`). It is a new header on a public response shape. Options: (a) leave it; (b) add both; (c) add only on held, where the number is exact.
- **O3 (N4)** Cap held repeats per agent key (count a held repeat toward the offer after N), or accept and keep the README record T003 writes. Changes when a verified agent is mazed.
- **O4 (N5)** When a hold comes due, let that payment's one attempt through a payer cooldown (it was already counted once), so each nonce costs at most 2 calls and an honest fast-clock funded payer is served. Changes the cooldown contract.

## Out of Scope

- Any Stripe code (`packages/adapter-stripe/**`, `packages/core/src/voucher.ts`).
- Any refactor of `makeSettlingVerify`, any new dependency, any change to reasons, 402 texts, headers, receipts, logs, signed bytes or exit codes.
- Live facilitator, workerd or deploy measurements (owner).
- A version bump, a publish, a merge.
