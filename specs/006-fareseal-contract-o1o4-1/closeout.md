# Closeout: fareseal-contract-o1o4-1 (FR-010)

Branch `crew/fareseal-contract-o1o4-1` at HEAD `ed98127`, on main `6825c30`. Written by T010 (2026-11-13) at `2d680f1`; updated by R003 (2026-11-13) on `ed98127` (section 9). Updated by R004 (2026-11-13) on `7f87051` (section 10); the branch head is then `7f87051` plus the R004 commit.

Short names: CF = `packages/cloudflare/src/index.ts`, HONO = `packages/hono/src/index.ts`, PIPE = `packages/core/src/pipeline.ts`, LEDGER = `packages/core/src/ledger.ts`, PS = `packages/cloudflare/test/pages-settle.test.ts`, GOLD = `packages/cloudflare/test/contract-golden.test.ts`, BUDGET = `packages/cloudflare/test/settle-budget.test.ts`. Line numbers in sections 1 to 8 are as T010 wrote them, at `2d680f1`; R001 to R003 have moved CF and PS lines since. Line numbers in section 9 are at `ed98127` plus the R003 change. Line numbers in section 10 are at `7f87051` plus the R004 change.

Every run below was made on 2026-11-13. Runs on changed source were made in throwaway copies (`~/agent-crew/bin/crew-scratch`), never in the worktree.

**Two things for the reviewer, before the detail:**

1. **Finding (section 3).** The golden file run on main's source fails on 2 entries, not 1: `held` (row A2, expected) and `fourth concurrent payment (A1)`. The second is the 27th entry, added by T004 for row A1; it is not one of the 26 shapes in FR-001. Of the 26, only `held` fails, and only by the `retry-after` header. SC-002 as written ("fails only on the held-repeat entry") is not met by the file as a whole. Nothing was loosened.
2. **spec.md's per-nonce bound: corrected by R003.** R-O4 "Bound" (spec.md line 51) and US4 (line 90) now state both bounds as ruled at T005, on the supervisor's R003 brief (section 9).
3. **For the owner: row A7 is now bounded (R003, section 9).** A hold's due pass survives at most 3 operator-fault answers. The cap of 3 is a choice; the owner may prefer a different cap or none.
4. **For the owner: this branch also fixes behaviour main has today (R004, section 10).** On main, on a cold isolate, requests that arrive during the first state build each build their own state: 5 concurrent copies of one payment make 5 settle calls, 100 concurrent fresh payments from one payer make 100. After this change they make 1 and 3. It is not one of the spec's rows; the second review found it (L6) on main and head alike.

## 1. Rows A1–A8 and T1: code and pinning test

Test names are quoted as they stand in the file (`$row` and `$path` are `it.each` placeholders).

| Row | Code at HEAD | Pinning test |
|---|---|---|
| A1 | CF:296-297 (live failures + in-flight ≥ 3 → `payer-cooldown`), CF:314 (reserve after the token), CF:465-467 (release in `finally`) | PS:2015 `100 concurrent fresh payments from one payer → 3 settle calls, 97 x 402 payer-cooldown`; PS:2043 `an honest funded payer with 3 in flight: the 4th is payer-cooldown with no settle call; after they land it and a 5th are served`; PS:2122 `released after $path: 3 concurrent settles start again (Pages middleware)`; GOLD:262 `fourth concurrent payment (A1)` (the 402 bytes) |
| A2 | CF:273-279 (held return carries `retryAfterS: Number(early - nowS)`), HONO:724-730 (`retry-after` header) | PS:1264 `held at T0, repeated at T0+10 s → 402 with retry-after: 45; the first answer has none`; PS:1286 `the settle-throttled 402 has no retry-after`; GOLD:158 `held`; `packages/hono/test/payment-errors.test.ts`:290 `a rejected result with retryAfterS 45 -> 402 with retry-after: 45` and :321 `a 302 consequence carries none` |
| A3 | PIPE:102 (`HELD_REPEATS_FREE = 60`), PIPE:394-400 (step 6), LEDGER:70-75 (`recordHeld`), LEDGER:49-55 (`roll`), LEDGER:86 (reset in `recordPaid`) | `packages/core/test/pipeline-payment.test.ts`:249 `held repeats: 60 record no offer, the 61st does, then the grace runs out`; :275 `held repeats from an anonymous agent are never ledgered`; `packages/core/test/ledger.test.ts`:56 `recordHeld rolls with the window like recordOffer`; BUDGET:515 `a verified agent at 10 req/s on one held payment → 302 by request 64`; BUDGET:531 `an honest agent polling 1/s for 60 s on one held payment is never mazed, then served` |
| A4 | CF:268 (`due`), CF:297 (`!due &&` skips the refusal), CF:311 (hold deleted when the token is taken) | PS:2277 `(a) L3, row A4: 3 early payments at once from a funded payer 55 s fast, each repeated after validAfter → all 3 served, 6 settle calls`; PS:2382 `(e) rows A4/US5: 20 concurrent copies of a due payment → 1 settle call, 1 x 200` |
| A5 | CF:419-420 (row 5 holds only while `validAfter` is still ahead of our clock, so a due attempt is not held again) | PS:2296 `(b) row A5: a due attempt answered not-yet-valid again is not held again; the cooled-down payer's next retry is payer-cooldown with no call (2 calls for the nonce)`; PS:2323 `row A5, ruling: a lone early nonce against a lagging facilitator costs exactly 3 settle calls, then payer-cooldown`; PS:1335 `a not-yet-valid answer to the due attempt is not held again (row A5)` |
| A6 | CF:305-306 (`settle-throttled` returns before CF:311, so the hold stays) | PS:2344 `(c) row A6: a due attempt that meets an empty bucket is settle-throttled with no call; after a refill the retry is still the due attempt and is served` |
| A7 | CF:459-460 (hold put back when a due attempt ends in an operator fault) | PS:2364 `(d) row A7: a due attempt answered settle 503 is put back; the retry is the due attempt again and is served`; bounded by R003, see section 9 |
| A8 | CF:426 and CF:429 (row 5), CF:441 and CF:444 (rows 6/7): `const t = Date.now()` at write, `untilMs: t + PAYER_COOLDOWN_MS` | PS:1719 `L2: a held $row failure landing at 5 s cools the payer until 605 s, not 600 s` (runs for row 5 and row 6) |
| T1 | HONO:79 (`retryAfterS?: number`), LEDGER:12 (`heldInWindow`), LEDGER:70 (`recordHeld`), CF:209-218 and CF:470-478 (`_sizes()`, `@internal`) | `packages/hono/test/payment-errors.test.ts`:290 (as A2); `packages/core/test/ledger.test.ts`:45 `recordHeld counts 1..n and records no offer` and :88 `recordPaid resets the held count`; PS:2162 `_sizes() counts payers with a settle in flight, not settles`; PS:2134 `released after $path: _sizes().payerInflight is 0` |

One difference from the spec's wording, same behaviour for row A5: R-O4 says the row-5 hold is "skipped when `due`". The code at CF:419 instead holds only when `BigInt(validAfter) > nowS`. A due attempt always has `validAfter <= nowS`, so it is never held again. The condition also covers a first attempt whose `validAfter` is already past by our clock (facilitator clock behind ours); the comment at CF:413-418 gives the reason, and the README states it.

## 2. L1, L2, L4, L5: closed

Re-run today in one scratch copy. Each mutant was applied alone to CF with `sed` on the line named, then `CI=true pnpm exec vitest run packages/cloudflare` (9 files, 253 tests), then CF was restored from the saved original. Baseline without a mutant: **253 passed, 0 failed**.

| Low | Mutant | Line changed (HEAD → mutant) | Red / green | Tests that go red |
|---|---|---|---|---|
| L1 | m01 row 5 counts from the pre-await snapshot | CF:428 `cur && t < cur.untilMs ? cur.n : 0` → `fails && t < fails.untilMs ? fails.n : 0` | 8 / 245 | PS `L1: three concurrent early payments from one payer cool it down`, and 7 more (below) |
| L4 | m04 rows 6/7 ignore the window | CF:443 → `n: (cur ? cur.n : 0) + 1` | 2 / 251 | PS `L4: a row-6 count from an expired cooldown window restarts at 1`; `L4: a 'row 6' failure written exactly at untilMs starts at 1` |
| L4 | m09 row 5 keeps the old `untilMs` | CF:429 → `untilMs: cur && t < cur.untilMs ? cur.untilMs : t + PAYER_COOLDOWN_MS` | 2 / 251 | PS `L4: 'row 5' failures at t, t+1 s, t+300 s cool the payer until t+900 s`; `L2: a held 'row 5' failure landing at 5 s cools the payer until 605 s, not 600 s` |
| L4 | m10 rows 6/7 keep the old `untilMs` | CF:444, same change | 2 / 251 | the same two tests for `'row 6'` |
| L4 | m19 row 5 `<=` | CF:428 `t < cur.untilMs` → `t <= cur.untilMs` | 1 / 252 | PS `L4: a 'row 5' failure written exactly at untilMs starts at 1` |
| L4 | m20 rows 6/7 `<=` | CF:443, same change | 1 / 252 | PS `L4: a 'row 6' failure written exactly at untilMs starts at 1` |
| L4 | m21 row 5 max(snapshot, re-read) | CF:428 → `n: Math.max(live, cur && t < cur.untilMs ? cur.n : 0) + 1` | 1 / 252 | PS `L4 (P2d): a success landing before an in-flight 'row 5' failure clears the count that failure adds to` |
| L4 | m22 rows 6/7 max(snapshot, re-read) | CF:443, same change | 1 / 252 | the same test for `'row 6'` |
| L2 | row 5 stamped with the pre-await clock (the code before T003) | CF:426 `const t = Date.now()` → `const t = now` | 1 / 252 | PS `L2: a held 'row 5' failure landing at 5 s cools the payer until 605 s, not 600 s` |
| L2 | rows 6/7 stamped with the pre-await clock | CF:441, same change | 1 / 252 | PS `L2: a held 'row 6' failure landing at 5 s cools the payer until 605 s, not 600 s` |

The names with `'row 5'` / `'row 6'` are how vitest prints the `it.each` tests at PS:1612, PS:1643, PS:1670 and PS:1719 (`$row` in the file).

m01's other 7 red tests, all in PS: `L2: a held 'row 5' failure landing at 5 s cools the payer until 605 s, not 600 s`, `L4 (P2d): a success landing before an in-flight 'row 5' failure clears the count that failure adds to`, and the five R-O4 tests (a)–(e) at PS:2277-2382. m01 and m21/m22 are still killed after R-O1 (SC-004).

**L5** closed by T009: `git diff main -- specs/005-fareseal-pay-lows-2/closeout.md`

```
-Branch `crew/fareseal-pay-lows-2` at HEAD `825f88a`, on main `705cc57`. Written by T004 (2026-11-13).
+Branch `crew/fareseal-pay-lows-2` at HEAD `f24a66e`, on main `705cc57`. Written by T004 (2026-11-13).
```

## 3. Golden test against main's source (SC-002)

In a scratch copy: every file under `packages/*/src` replaced with `git show main:<path>`, HEAD's tests and snapshot kept, then `pnpm exec tsc -b` (the cloudflare tests import core and hono from their built `dist/`, so main's source had to be rebuilt), then `CI=true pnpm exec vitest run packages/cloudflare/test/contract-golden.test.ts`.

```
--- src now differs from main in:
--- src differs from HEAD in:
 packages/cloudflare/src/index.ts | 105 +++++++--------------------------------
 packages/core/src/ledger.ts      |  28 ++---------
 packages/core/src/pipeline.ts    |  20 +-------
 packages/hono/src/index.ts       |  16 ------
 4 files changed, 21 insertions(+), 148 deletions(-)
tsc -b exit: 0

 ❯ packages/cloudflare/test/contract-golden.test.ts (27 tests | 2 failed) 5365ms
     × held 20ms
     × fourth concurrent payment (A1) 5004ms

 FAIL  packages/cloudflare/test/contract-golden.test.ts > golden contract (spec 006 FR-001) > held
Error: Snapshot `golden contract (spec 006 FR-001) > held 1` mismatched

- Expected
+ Received

@@ -8,14 +8,10 @@
      [
        "content-type",
        "application/json",
      ],
      [
-       "retry-after",
-       "55",
-     ],
-     [
        "x-payment-required",
        "{"scheme":"exact","network":"base-sepolia",…}",
      ],
    ],
    "status": 402,

 FAIL  packages/cloudflare/test/contract-golden.test.ts > golden contract (spec 006 FR-001) > fourth concurrent payment (A1)
Error: Test timed out in 5000ms.

  Snapshots  1 failed
             1 obsolete
             ↳ packages/cloudflare/test/contract-golden.test.ts
               · golden contract (spec 006 FR-001) > fourth concurrent payment (A1) 1

 Test Files  1 failed (1)
      Tests  2 failed | 25 passed (27)
```

(The `x-payment-required` value is cut short here with `…`; it is a context line, the same on both sides.)

What this shows:

- **`held` (A2):** the one snapshot mismatch. The only differing lines are the `retry-after` / `55` header pair. Status, body and every other header are the same.
- **`fourth concurrent payment (A1)` — the finding.** T004 added this entry for row A1 (tasks.md T004: "Add the A1 shape … as a new golden entry"). It holds three settles open and expects the fourth payment to be refused at once. On main the fourth payment goes to settle (row A1 "before"), the stub never answers it, and the test times out. It never reaches its snapshot, which is why vitest lists that snapshot as obsolete. This is row A1's before/after difference seen through a test written for the "after" side. It is not one of the 26 shapes of FR-001.
- **The other 25 pass on main's source** unchanged. So among the 26 shapes only `held` differs, and only by its headers.

For the reviewer to decide: accept SC-002 as "of the 26 shapes, only A2's headers differ" (what the run shows), or move the A1 entry out of the golden file so the file as a whole fails on one entry.

## 4. T008 budget table: head against main

Head numbers are what BUDGET asserts at HEAD (green in the verify run, section 6). Main numbers were measured today by running the same BUDGET file on main's source in the scratch copy of section 3; the assertion failures print main's value.

| Scenario | SC-003 main | main measured | SC-003 head | head asserted (BUDGET line) | Differs from SC-003? |
|---|---|---|---|---|---|
| 100 sequential | 3 | 3 (test passes on main) | 3 | `toBe(3)` (:269) | no |
| 100 concurrent, one burst | 20 | 20 (`expected 20 to be 3`) | 3 | `toBe(3)` (:278) | no |
| 3 concurrent per second, 20 s | 9 | 9 (`expected 9 to be 3`) | 3 | `toBe(3)` (:288) | no |
| 20 concurrent every 4 s, 60 s | 60 | 60 (`expected 60 to be 3`) | 3 | `toBe(3)` (:298) | no |
| 10 per second, settle never answers, 30 s | 169 | 169 (`expected 169 to be 3`) | 3 | `toBe(3)` (:313) | no |
| many payers, 30 per second, 20 s | 115 | 115 | <= 115 | `toBeLessThanOrEqual(115)` (:338); measured 115 | no |
| OQ1 exception: stream of early nonces whose holds come due | 3 | 3 in the first 600 s (`expected 3 to be greater than 3`) | <= 6 per 600 s | `toBeLessThanOrEqual(6)` in every 600 s window, more than 3 in the first 600 s, and <= 2 per nonce (:367-379) | no |

No row differs from SC-003. The "many payers" value was read by changing that one assertion to `toBe(-1)` in a scratch copy: `expected 115 to be -1` on head's source and on main's source.

US3 (BUDGET:515, :531): a verified agent at 10 requests/s on one held payment gets its first 302 at request <= 64 (asserted as an upper bound: 1 + 60 free + 3 grace) with 1 settle call; an honest agent polling once a second for 60 s gets 60 × 402 then 200, never 302, with 2 settle calls. On main's source the first test fails with no 302 in 100 requests (`expected 0 to be greater than 0`).

**Bounds** (BUDGET:549 `1400 one-payment payers → seen 512, payerFails 512, notYetValid <= 512, nothing in flight; the same a year later`): after 1400 settle calls, `_sizes()` is seen 512, payerFails 512, notYetValid <= 512, inflight 0, payerInflight 0, and equal to itself after the clock moves 365 days and after one more pair of payments.

One difference from FR-008's wording, marked here: FR-008 says "700 payers and 1400 payments". The test uses 1400 payers with one payment each (700 pairs), because the fixtures sign one payment per fresh key (comment at BUDGET:559-562). So no payer has two settles in flight in this test; that release path is pinned in PS:2122 and PS:2134 instead.

## 5. Command outputs

`grep -rn "retry-after" packages/*/src` (SC-006: one hit, in hono's `offerResponse`):

```
packages/hono/src/index.ts:730:      c.header("retry-after", String(rejected.retryAfterS));
```

`git diff main -- packages/adapter-x402` : empty (0 bytes). Discovery unchanged.

`git diff main --stat -- packages/core/src/voucher.ts packages/adapter-x402` : empty (0 bytes).

`git diff main -- packages | grep -iE '^[+-].*(stripe|voucher)'` : prints nothing (grep exit 1). SC-005.

`git diff main --name-only | grep -E 'package\.json|lock|\.github'` : prints nothing (grep exit 1). No lockfile, workflow or `package.json` in the diff.

`git diff main --stat` (before this file was added):

```
 packages/cloudflare/CHANGELOG.md                   |  13 +-
 packages/cloudflare/README.md                      |  69 +-
 packages/cloudflare/src/index.ts                   | 105 ++-
 .../__snapshots__/contract-golden.test.ts.snap     | 594 ++++++++++++++++
 packages/cloudflare/test/contract-golden.test.ts   | 338 +++++++++
 packages/cloudflare/test/pages-settle.test.ts      | 779 ++++++++++++++++++++-
 packages/cloudflare/test/settle-budget.test.ts     | 600 ++++++++++++++++
 packages/core/src/ledger.ts                        |  28 +-
 packages/core/src/pipeline.ts                      |  20 +-
 packages/core/test/ledger.test.ts                  |  52 ++
 packages/core/test/pipeline-payment.test.ts        |  41 ++
 packages/hono/README.md                            |  11 +
 packages/hono/src/index.ts                         |  16 +
 packages/hono/test/payment-errors.test.ts          |  88 +++
 specs/005-fareseal-pay-lows-2/closeout.md          |   2 +-
 specs/006-fareseal-contract-o1o4-1/plan.md         |  63 ++
 specs/006-fareseal-contract-o1o4-1/spec.md         | 158 +++++
 specs/006-fareseal-contract-o1o4-1/tasks.md        |  19 +
 18 files changed, 2944 insertions(+), 52 deletions(-)
```

## 6. Full verify

`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check` at HEAD `2d680f1`, in the worktree. Tail:

```
$ tsc -b
$ vitest run

 RUN  v4.1.12 /home/o2k/.crew/work/fareseal-contract-o1o4-1/code


 Test Files  58 passed (58)
      Tests  774 passed (774)
   Start at  09:19:25
   Duration  46.00s (transform 12.52s, setup 0ms, import 39.22s, tests 120.52s, environment 18ms)

bun-hono example OK: human 200, agent 402, arrival 200
| scenario | p50 | p99 |
|---|---|---|
| baseline app, no fareseal | 0.024 ms | 0.111 ms |
| human pass-through | 0.021 ms | 0.153 ms |
| free path pass-through | 0.009 ms | 0.076 ms |
| agent 402 offer | 0.037 ms | 0.138 ms |
| voucher spend + re-sign (ed25519 x2) | 4.919 ms | 10.689 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.000 ms, added p99 0.042 ms)
EXIT CODE: 0
```

Exit code **0**. `pnpm lint` printed 1 warning and 4 infos, none an error, all in test files this branch does not touch (`packages/cloudflare/test/pages-arrival.test.ts:168` `noTemplateCurlyInString`; `packages/core/test/keyfile.test.ts` `useTemplate` × 4). They do not fail `biome check`. The bench timings are this machine's, this run's.

This is local verify only. GitHub CI on the draft PR is GATE F's check (SC-001).

## 7. Coordinator rulings used

- **GATE 0** (tasks.md, 2026-11-13): R-O1 to R-O4 and the table A1–A8, T1 confirmed as the rules to build.
  - **OQ1:** accepted. O4 lets a due attempt through a cooldown, so a stream of early nonces whose holds come due may cost up to 6 settle calls per payer per 600 s window, where main costs 3. Every other scenario costs no more than main (section 4). Pinned by BUDGET:350.
  - **OQ2:** `Retry-After` on the held 402 only (variant c). Whether `settle-throttled` should carry it too is the owner's question (section 8).
  - **OQ3:** every payer is reserved, and the refusal reuses `payer-cooldown`. Cost, in plain words: an honest payer's 4th payment at once is refused with a text that says "after repeated failures", and an offer is recorded for it.
  - **OQ4:** N = 60 held repeats per agent key per window, a constant (PIPE:102).
- **No ADR.** Constitution Art. VII.24 asks for an ADR before "any decision that contradicts `plan.md`". The root `plan.md` says nothing about cooldowns, reservations or `Retry-After`, so there is nothing in it to contradict. ADR-004 (`docs/adr/004-cloudflare-batteries-included.md`) says a payer with repeated fresh failures gets a cooldown. O1 counts in-flight settles toward that same limit, and O4 adds one exception (a due payment gets one attempt). Both refine ADR-004's rule; neither reverses it. The owner can overrule this and ask for an ADR; none of the code depends on the answer.
- **T005 ruling** (tasks.md T005, commit `e5d8b20`, option 1). Two per-nonce bounds, both as measured:
  - **3 settle calls** for a lone early nonce against a lagging facilitator: the first attempt, the due attempt, and one ordinary retry (the payer's third failure), then `payer-cooldown`. Pinned by PS:2323, which asserts exactly 3. This is no more than main for that case.
  - **2 settle calls** per nonce for a payer who is cooled down or reserved out: the first attempt and the due attempt. Pinned by PS:2296 (`f.per.get(xps[0])` is 2).
  - Row A5 is unchanged and the ordinary retry is not refused, as ruled. spec.md's R-O4 "Bound" line and US4 state both since R003.

## 8. Not done, and whose

All of these are the owner's (**O001**, Josh). No agent does them.

- Live facilitator measurements. Every settle answer in this work is an in-process stub.
- workerd / Pages measurements. The tests call `createPagesMiddleware` in Node under vitest.
- Deploy.
- npm publish. No version bump; the CHANGELOG entries are under `2.3.0 — Unreleased`.
- The merge word on the draft PR.
- The decision on `retry-after: 1` for `settle-throttled` (O2 variant b). Not built; spec OQ2 calls it a one-line follow-up.

Still open for the crew: **GATE F** (reviewer agent, verify, GitHub CI green on the draft PR), and the items at the top of this file.

## 9. R003: second review of 2abd077, lows L1 to L5

Written on `ed98127` (`git rev-parse --short HEAD`), with the R003 change in the worktree. Line numbers here are at that tree.

**L1, the bound on row A7.** A hold's due pass survives at most 3 operator-fault answers (`DUE_FAULT_LIMIT = 3`, CF:98-100). The hold entry carries a `faults` count (CF:240-241). An operator-fault answer to a due attempt puts the hold back with the count raised; the third one does not put it back (CF:499-514). The hold is then gone, so the next request is an ordinary attempt and meets the cooldown: `payer-cooldown`, no settle call. The payment is not cached, so it can be sent again once the cooldown ends. `settle-unconfirmed` and `no-transaction-id` are not put back, as before. Rows A5 and A6 are unchanged. No new reason string, 402 text or status code; the golden snapshot file is unchanged.

Measured (PS:2627): a cooled-down payer with one due hold, facilitator answering 503 on every call, 10 requests: exactly 3 settle calls (requests 1 to 3, operator-fault 402), requests 4 to 10 `payer-cooldown` with no call; with the facilitator healthy again the next request is still `payer-cooldown`. Before the bound, the review measured 100 calls in 100 requests (main: 0).

**For the owner.** The cap of 3 is a choice. The owner may prefer a different cap, or none (row A7 as first written, bounded only by the settle bucket). It is one constant. The README ("Known costs") says the same. It belongs in the PR text; that is R004's update.

**L4 and L5, the two mutant gaps, and L1's test.** Run in one throwaway copy (`~/agent-crew/bin/crew-scratch`), each change applied alone to CF, then `CI=true pnpm exec vitest run packages/cloudflare/test/pages-settle.test.ts` (178 tests), then CF restored. Baseline: **178 passed**.

| Finding | Source under test | Red / green | Test that goes red | Assertion |
|---|---|---|---|---|
| L1 | CF as at `ed98127` (no counter) | 1 / 177 | PS:2627 `row A7 bound: a cooled-down payer with one due hold against a 503 facilitator makes exactly 3 settle calls; the 4th and later requests are payer-cooldown with no call` | `expected 'settlement unavailable (operator faul…' to be 'payer cooling down after repeated fai…'` |
| L4 | M41: CF:350 `payerInflight.set(payer, [` → `if (!due) payerInflight.set(payer, [` | 1 / 177 | PS:2664 `R-O4: due attempts in flight are reserved: with 2 in flight and no failures, of 3 fresh payments 1 starts a settle call and 2 are payer-cooldown` | `expected 9 to be 7` (all 3 fresh payments started a settle call) |
| L5 | M26: CF:511 `isOperatorFault(result.reason) &&` → `(isOperatorFault(result.reason) \|\| result.reason === "settle-unconfirmed") &&` | 1 / 177 | PS:2647 `row A7: a due attempt answered 502 with settled:true (settle-unconfirmed) is not put back; the retry is payer-cooldown with no call` | `expected 'settlement status unconfirmed; do not…' to be 'payer cooling down after repeated fai…'` |

The red runs, as printed:

```
=== HEAD source (no counter), new tests
      Tests  1 failed | 177 passed (178)
     × row A7 bound: a cooled-down payer with one due hold against a 503 facilitator makes exactly 3 settle calls; the 4th and later requests are payer-cooldown with no call 34ms
AssertionError: expected 'settlement unavailable (operator faul…' to be 'payer cooling down after repeated fai…' // Object.is equality
=== M41 due attempt does not reserve
      Tests  1 failed | 177 passed (178)
     × R-O4: due attempts in flight are reserved: with 2 in flight and no failures, of 3 fresh payments 1 starts a settle call and 2 are payer-cooldown 1104ms
AssertionError: expected 9 to be 7 // Object.is equality
=== M26 put-back also for settle-unconfirmed
      Tests  1 failed | 177 passed (178)
     × row A7: a due attempt answered 502 with settled:true (settle-unconfirmed) is not put back; the retry is payer-cooldown with no call 35ms
AssertionError: expected 'settlement status unconfirmed; do not…' to be 'payer cooling down after repeated fai…' // Object.is equality
=== baseline
      Tests  178 passed (178)
```

**L2.** spec.md line 51 (R-O4 "Bound") and line 90 (US4) now state both bounds as ruled at T005: 3 settle calls for a lone early nonce against a lagging facilitator (first attempt, due attempt, one ordinary retry under row A5), 2 for a payer who is cooled down or reserved out. Same wording as the README and the CHANGELOG. Edited on the supervisor's R003 brief. spec.md line 50 (R-O4 "How it is counted") and table row A7 (line 70) now carry the cap too, in the README's words: the put-back happens at most twice, and the third operator-fault answer for one hold drops the hold. Rows A5 and A6 are unchanged.

**L3.** Line 3 of this file names `ed98127`, the head this update was written on. The R003 commit itself comes after it; its sha cannot be written inside it.

**Also changed, outside the brief's file list, on purpose.** `packages/cloudflare/CHANGELOG.md`, entry A7: the bound added, since the entry said the hold is put back with no limit. The supervisor has confirmed it stays.

**Full verify** (the section 6 command) on `ed98127` plus the R003 change, in the worktree, 2026-11-13: **58 test files, 790 tests passed**, bun-hono example OK, bench NFR-1 PASS, exit code **0**. `pnpm lint`: the same 1 warning and 4 infos as section 6, no error. `git status` shows no change to `packages/cloudflare/test/__snapshots__/contract-golden.test.ts.snap`. Section 6's tail is T010's run at `2d680f1`.

## 10. R004: second review of 2abd077, L6 (a fix for behaviour main has today)

Written on `7f87051` (`git rev-parse --short HEAD`), with the R004 change in the worktree. main is `6825c30`.

**What main does today.** `createPagesMiddleware` keeps one state per isolate (payment cache, in-flight join, settle bucket, per-payer counts and reservations). The first request builds it with `await buildState(...)`. Every request that arrived before that await finished saw no state and built its own. So for the first burst on a cold isolate none of the limits held. This is the same on main and on this branch before R004; rows A1 to A8 did not cause it. US1 and US5 say "warmed", and every test and the review's fuzz warmed the handler with one request first.

| First burst on a cold handler | main `6825c30` and head `7f87051` | With R004 |
|---|---|---|
| 5 concurrent copies of one payment, stub confirms every call | 5 settle calls (the review measured 5 x 200) | 1 settle call, 1 x 200 with `x-payment-response`, 4 x 402: the same answers as a warm handler |
| 100 concurrent fresh payments from one payer | 100 settle calls | 3 settle calls, 97 x 402 `payer-cooldown`; the 3 are served when answered |

The main column is the review's probe (second-review-2abd077.md, L6) and the red run below on `7f87051` source; CF's state build is the same code on main (the review's CF:704-707).

**The change.** CF:601-605 and CF:767-786. The build in progress is kept as one promise with its config key (`building`). A request that finds no state for its key starts the build or, if one for the same key is running, awaits that one. The state and its key are set when the build resolves. When the build settles either way its entry is cleared, so a rejected build is not kept and the next request builds again; the requests that waited on it get the error, handled as before (rethrown for `ConfigError` and `FaresealBindingMissingError`, failed open otherwise). A changed key still rebuilds, and a rebuild that fails still leaves the previous state in place for its own key, as before. A warm request takes the same path as before, with no added await.

Not changed: each isolate has its own state. Across isolates only the chain refuses a reused nonce.

**Tests** (PS:2445, `cold handler: the first burst shares one state (R004, L6)`; each uses a middleware that has answered nothing):

| Test | Asserts |
|---|---|
| PS:2459 `5 concurrent copies of one payment → 1 settle call, one receipt, as on a warm handler` | 1 settle call; one 200 with `x-payment-response`; 4 x 402; the sorted (status, receipt, error) list equals the same burst on a warmed handler |
| PS:2484 `100 concurrent fresh payments from one payer → 3 settle calls, 97 x 402 payer-cooldown` | 3 calls with 97 already answered; after the answers 3 x 200 with receipt, 97 x `payer-cooldown`, still 3 calls |
| PS:2513 `a failed build is not kept: the next request builds again` | 3 concurrent requests with an undecodable site key fail open (as before); then, same cache key, 3 copies of one payment: 1 x 200, 2 x 402, 1 settle call |

Red and green, in throwaway copies (`~/agent-crew/bin/crew-scratch`), `CI=true pnpm exec vitest run packages/cloudflare/test/pages-settle.test.ts` (181 tests):

```
=== CF as at 7f87051 (git show HEAD:packages/cloudflare/src/index.ts), R004 tests
AssertionError: expected 5 to be 1 // Object.is equality      (5 copies: settle calls)
AssertionError: expected 100 to be 3 // Object.is equality    (100 fresh: settle calls)
AssertionError: expected 3 to be 1 // Object.is equality      (after a failed build: 200s for 3 copies)
      Tests  3 failed | 178 passed (181)
=== mutant: a rejected build is kept (the entry is cleared only after a build that resolved)
 FAIL  ... > a failed build is not kept: the next request builds again
AssertionError: expected 3 to be 1 // Object.is equality
      Tests  1 failed | 180 passed (181)
=== R004 source
      Tests  181 passed (181)
```

On `7f87051` source the third test fails on its cold burst, not on a kept failure (that source keeps nothing). The mutant is what shows the test guards the retry.

**Golden comparison, re-run.** (a) On the R004 tree the golden file passes (27 tests) and `git status` shows no change to `packages/cloudflare/test/__snapshots__/contract-golden.test.ts.snap`: every entry is byte-identical. (b) Section 3's run repeated on the R004 tree (every `packages/*/src` file replaced with `git show main:<path>`, `pnpm exec tsc -b` exit 0, then the golden file): the same result as section 3.

```
  packages/cloudflare/test/contract-golden.test.ts (27 tests | 2 failed)
      held                              (snapshot mismatch: only the retry-after / 55 header pair)
      fourth concurrent payment (A1)    (Test timed out in 5000ms; its snapshot listed obsolete)
      Tests  2 failed | 25 passed (27)
```

**Fuzz, re-run.** The second review's harness (`zz-fuzz.test.ts` and `zzlib.ts`, read from the scratchpad its report names in section 6, copied into a throwaway copy of the R004 tree, never into the worktree), under `unshare -rn`, seeds 0 to 4199, the same assertions (a) to (d) as the report's section 2.1. Run twice: warmed as the review ran it, and cold (`FUZZ_COLD=1`, the harness's own switch: no warming request).

| Source | Handler | Schedules | Requests | Settle calls | 200 served | 302 | Violations | Failing seeds |
|---|---|---|---|---|---|---|---|---|
| R004 tree | warm | 4,200 | 223,918 | 55,014 | 11,705 | 2,611 | 0 | none |
| R004 tree | cold | 4,200 | 223,470 | 54,993 | 11,646 | 2,595 | 0 | none |
| `7f87051` CF, rest R004 tree | cold, seeds 0 to 19 only | 20 | 1,190 | 302 | 72 | not read | present | 1, 5, 7, 11, 16, 19 (`B1: concurrent settle calls for` one payment) |
| R004 tree | cold, seeds 0 to 19 only | 20 | 1,170 | 299 | 65 | 1 | 0 | none |

The review's cold failures (seeds 1, 5, 7) are reproduced on `7f87051` source and are gone with R004. The request and settle-call totals vary from run to run of the same harness on the same tree (QA's re-run on this tree gave warm 223,652 requests / 54,993 calls and cold 224,035 / 55,092), so only the violation count, 0 cold and 0 warm over seeds 0 to 4199, is the stable result. The totals also differ from the review's head row (223,843 requests, 54,540 calls, on `2abd077`); the cause of that difference was not determined. The review's other probe files (`zz-probe`, `zz-extra`, `zz-win`, `zz-golden`) were not re-run; only the fuzz was asked for.

**Also changed.** The six test comments that said "a cold burst builds one state per request" (PS x3, GOLD x2, BUDGET x1) now say the cold burst is covered by the R004 tests. The warming requests themselves stay, so every existing count and snapshot is taken as before. `packages/cloudflare/README.md` (new paragraph after the damping paragraph: one state per isolate, shared from the first request; a failed build is not kept), `packages/cloudflare/CHANGELOG.md` (one L6 entry under `2.3.0 — Unreleased`, saying it fixes behaviour 2.2.0 and main have today), and `pr-body.md` in this directory (new: there was no PR text file; it carries the L6 paragraph and section 9's A7 cap for the owner).

**Full verify** (the section 6 command) on `7f87051` plus the R004 change, in the worktree, 2026-11-13: **58 test files, 793 tests passed** (790 + the 3 above), bun-hono example OK, bench NFR-1 PASS (added p50 0.012 ms, p99 0.043 ms), exit code **0**. `pnpm lint`: the same 1 warning and 4 infos as section 6, no error.

**Could not determine.** Whether workerd delivers a cold isolate's first requests in the interleaving the tests use (several requests entering the handler before the first build's await resumes). No workerd here; the tests are Node under vitest, as in section 8. The shared build removes the fault whatever the interleaving.
