# Closeout: fareseal-contract-o1o4-1 (FR-010)

Branch `crew/fareseal-contract-o1o4-1`, on main `6825c30`. The head that review round 2 read is `7e81768` (second-review-7e81768.md). The R-task commits made after it (R012 onward) are listed by `git log 7e81768..HEAD`; a file cannot name the commit that carries it.

History of this file, not a head claim: written by T010 (2026-11-13) at `2d680f1`; section 9 by R003 on `ed98127`; section 10 by R004 on `7f87051`; sections 8a and 8b (R001 and R002) by R007 on `a2681ea`, with line numbers at that tree; sections 11 and 12 by R014 on `926bb12`; section 13, the re-run in section 3 and the corrected numbers in section 8b by R015 on `04828e6`.

Short names: CF = `packages/cloudflare/src/index.ts`, HONO = `packages/hono/src/index.ts`, PIPE = `packages/core/src/pipeline.ts`, LEDGER = `packages/core/src/ledger.ts`, PS = `packages/cloudflare/test/pages-settle.test.ts`, GOLD = `packages/cloudflare/test/contract-golden.test.ts`, BUDGET = `packages/cloudflare/test/settle-budget.test.ts`. Line numbers in sections 1 to 8 are as T010 wrote them, at `2d680f1`; R001 to R003 have moved CF and PS lines since. Line numbers in section 9 are at `ed98127` plus the R003 change. Line numbers in section 10 are at `7f87051` plus the R004 change. Line numbers in section 13, and those marked R015 in sections 3 and 8b, are at `04828e6`.

Every run below was made on 2026-11-13. Runs on changed source were made in throwaway copies (`~/agent-crew/bin/crew-scratch`), never in the worktree.

**Two things for the reviewer, before the detail:**

1. **Finding (section 3, re-run by R015 on `04828e6`).** The golden file run on main's source fails on 4 entries, not 1: `held` (row A2, expected), `no tx id` and `unconfirmed` (both since R012: the error-only 402, row A11) and `fourth concurrent payment (A1)`. The last is the 27th entry, added by T004 for row A1; it is not one of the 26 shapes in FR-001. Of the 26, three differ from main: `held` by the `retry-after` header only, `no tx id` and `unconfirmed` by body and headers. SC-002 as written ("fails only on the held-repeat entry") is not met. Nothing was loosened. When T010 wrote this file (`2d680f1`, before R012) the same run failed on `held` and the A1 entry only.
2. **spec.md's per-nonce bound: corrected by R003.** R-O4 "Bound" (spec.md line 51) and US4 (line 90) now state both bounds as ruled at T005, on the supervisor's R003 brief (section 9).
3. **For the owner: row A7 is now bounded (R003, section 9).** A hold's due pass survives at most 3 operator-fault answers. The cap of 3 is a choice; the owner may prefer a different cap or none.
4. **For the owner: this branch also fixes behaviour main has today (R004, section 10).** On main, on a cold isolate, requests that arrive during the first state build each build their own state: 5 concurrent copies of one payment make 5 settle calls, 100 concurrent fresh payments from one payer make 100. After this change they make 1 and 3. It is not one of the spec's rows; the second review found it (L6) on main and head alike.

## 1. Rows A1–A8 and T1: code and pinning test

Test names are quoted as they stand in the file (`$row` and `$path` are `it.each` placeholders).

| Row | Code at HEAD | Pinning test |
|---|---|---|
| A1 | CF:296-297 (live failures + in-flight ≥ 3 → `payer-cooldown`), CF:314 (reserve after the token), CF:465-467 (release in `finally`) | PS:2015 `100 concurrent fresh payments from one payer → 3 settle calls, 97 x 402 payer-cooldown`; PS:2043 `an honest funded payer with 3 in flight: the 4th is payer-cooldown with no settle call; after they land it and a 5th are served`; PS:2122 `released after $path: 3 concurrent settles start again (Pages middleware)`; GOLD:262 `fourth concurrent payment (A1)` (the 402 bytes) |
| A2 | CF:273-279 (held return carries `retryAfterS: Number(early - nowS)`), HONO:724-730 (`retry-after` header) | PS:1264 `held at T0, repeated at T0+10 s → 402 with retry-after: 45; the first answer has none`; PS:1286 `the settle-throttled 402 has no retry-after`; GOLD:158 `held`; `packages/hono/test/payment-errors.test.ts`:290 `a rejected result with retryAfterS 45 -> 402 with retry-after: 45` and :321 `a 302 consequence carries none` |
| A3 | PIPE:102 (`HELD_REPEATS_FREE = 60`), PIPE:394-400 (step 6), LEDGER:93-102 (`recordHeld`, which opens the held window), LEDGER:62-69 (`roll`, which clears the held count when the offer window rolls), LEDGER:109-115 (`recordPaid`, which clears it on payment) | `packages/core/test/pipeline-payment.test.ts`:249 `held repeats: 60 record no offer, the 61st does, then the grace runs out`; :364 `held repeats from an anonymous agent are never ledgered`; `packages/core/test/ledger.test.ts`:59 `recordHeld never rolls the offer window (H1)` and :80 `the held count expires with its own window, not the offer window`; BUDGET:515 `a verified agent at 10 req/s on one held payment → 302 by request 64`; BUDGET:531 `an honest agent polling 1/s for 60 s on one held payment is never mazed, then served` |
| A4 | CF:268 (`due`), CF:297 (`!due &&` skips the refusal), CF:311 (hold deleted when the token is taken) | PS:2277 `(a) L3, row A4: 3 early payments at once from a funded payer 55 s fast, each repeated after validAfter → all 3 served, 6 settle calls`; PS:2382 `(e) rows A4/US5: 20 concurrent copies of a due payment → 1 settle call, 1 x 200` |
| A5 | CF:419-420 (row 5 holds only while `validAfter` is still ahead of our clock, so a due attempt is not held again) | PS:2296 `(b) row A5: a due attempt answered not-yet-valid again is not held again; the cooled-down payer's next retry is payer-cooldown with no call (2 calls for the nonce)`; PS:2323 `row A5, ruling: a lone early nonce against a lagging facilitator costs exactly 3 settle calls, then payer-cooldown`; PS:1335 `a not-yet-valid answer to the due attempt is not held again (row A5)` |
| A6 | CF:305-306 (`settle-throttled` returns before CF:311, so the hold stays) | PS:2344 `(c) row A6: a due attempt that meets an empty bucket is settle-throttled with no call; after a refill the retry is still the due attempt and is served` |
| A7 | CF:459-460 (hold put back when a due attempt ends in an operator fault) | PS:2364 `(d) row A7: a due attempt answered settle 503 is put back; the retry is the due attempt again and is served`; bounded by R003, see section 9 |
| A8 | CF:426 and CF:429 (row 5), CF:441 and CF:444 (rows 6/7): `const t = Date.now()` at write, `untilMs: t + PAYER_COOLDOWN_MS` | PS:1719 `L2: a held $row failure landing at 5 s cools the payer until 605 s, not 600 s` (runs for row 5 and row 6) |
| T1 | HONO:79 (`retryAfterS?: number`), LEDGER:12 (`heldInWindow`), LEDGER:93 (`recordHeld`), CF:209-218 and CF:470-478 (`_sizes()`, `@internal`) | `packages/hono/test/payment-errors.test.ts`:290 (as A2); `packages/core/test/ledger.test.ts`:45 `recordHeld counts 1..n and records no offer` and :161 `recordPaid resets the held count`; PS:2162 `_sizes() counts payers with a settle in flight, not settles`; PS:2134 `released after $path: _sizes().payerInflight is 0` |

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

**Re-run by R015 on `04828e6`** (main `6825c30`), after R012 changed two golden entries. The result T010 recorded here at `2d680f1` (two entries failing: `held` and the A1 entry; 25 of 27 passing) is replaced by this run. Command, from the repo root: `~/agent-crew/bin/crew-scratch -- sh r015-golden.sh`, where the script is:

```sh
for f in $(git ls-files 'packages/*/src/*'); do git cat-file -e main:$f 2>/dev/null || { echo "not on main, removed: $f"; rm -f $f; }; done
for f in $(git ls-tree -r --name-only main -- packages | grep '^packages/[^/]*/src/'); do mkdir -p $(dirname $f); git show main:$f > $f; done
echo "--- src now differs from main in:"; git diff --stat main -- 'packages/*/src/*'
echo "--- src differs from HEAD in:"; git diff --stat HEAD -- 'packages/*/src/*'
pnpm exec tsc -b; echo "tsc -b exit: $?"
CI=true pnpm exec vitest run packages/cloudflare/test/contract-golden.test.ts 2>&1
```

Summary lines of its output (the three snapshot diffs are described below, not pasted):

```
--- src now differs from main in:
--- src differs from HEAD in:
 packages/cloudflare/src/index.ts | 313 +++++----------------------------------
 packages/core/src/ledger.ts      |  67 +--------
 packages/core/src/pipeline.ts    |  20 +--
 packages/hono/src/index.ts       |  49 +-----
 4 files changed, 47 insertions(+), 402 deletions(-)
tsc -b exit: 0

 ❯ packages/cloudflare/test/contract-golden.test.ts (27 tests | 4 failed) 5589ms
     × held 22ms
     × no tx id 25ms
     × unconfirmed 21ms
     × fourth concurrent payment (A1) 5006ms

 FAIL  packages/cloudflare/test/contract-golden.test.ts > golden contract (spec 006 FR-001) > held
Error: Snapshot `golden contract (spec 006 FR-001) > held 1` mismatched
 FAIL  packages/cloudflare/test/contract-golden.test.ts > golden contract (spec 006 FR-001) > no tx id
Error: Snapshot `golden contract (spec 006 FR-001) > no tx id 1` mismatched
 FAIL  packages/cloudflare/test/contract-golden.test.ts > golden contract (spec 006 FR-001) > unconfirmed
Error: Snapshot `golden contract (spec 006 FR-001) > unconfirmed 1` mismatched
 FAIL  packages/cloudflare/test/contract-golden.test.ts > golden contract (spec 006 FR-001) > fourth concurrent payment (A1)
Error: Test timed out in 5000ms.

  Snapshots  3 failed
             1 obsolete
             ↳ packages/cloudflare/test/contract-golden.test.ts
               · golden contract (spec 006 FR-001) > fourth concurrent payment (A1) 1

 Test Files  1 failed (1)
      Tests  4 failed | 23 passed (27)
```

The empty list under "src now differs from main in" shows the copy's source is main's. No file was reported "not on main".

What this shows. Four entries differ from main:

- **`held` (A2):** a snapshot mismatch. The only differing lines are the `retry-after` / `55` header pair, present at HEAD and absent on main. Status, body and every other header are the same.
- **`no tx id` (A11, R012):** a snapshot mismatch. HEAD answers the error-only 402: body `{"x402Version":1,"error":"settle failed: no transaction id"}`, headers `cache-control` and `content-type`. Main answers the full offer: the body also carries `v`, `price_usd`, `options` and `accepts`, and there is an `x-payment-required` header. Status 402 and the error text are the same.
- **`unconfirmed` (A11, R012):** a snapshot mismatch, the same difference in shape as `no tx id`, and the error text differs too: HEAD `settlement status unconfirmed; do not sign a new payment; the same payment may be retried, or contact the operator`, main `settlement status unconfirmed; do not pay again, contact the operator`. Status 402 is the same.
- **`fourth concurrent payment (A1)` — the finding.** T004 added this entry for row A1 (tasks.md T004: "Add the A1 shape … as a new golden entry"). It holds three settles open and expects the fourth payment to be refused at once. On main the fourth payment goes to settle (row A1 "before"), the stub never answers it, and the test times out. It never reaches its snapshot, which is why vitest lists that snapshot as obsolete. This is row A1's before/after difference seen through a test written for the "after" side. It is not one of the 26 shapes of FR-001.
- **The other 23 pass on main's source** unchanged. So among the 26 shapes three differ: `held` by its headers only, `no tx id` and `unconfirmed` by body and headers.

For the reviewer to decide: SC-002 as written ("fails only on the held-repeat entry") no longer describes the file. Either accept it as "of the 26 shapes, A2's headers and A11's two maybe-paid 402s differ, each a listed change" (what the run shows), or change SC-002. The A1 entry could still be moved out of the golden file; that would leave three failing entries, not one.

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

 RUN  v4.1.12 <worktree>


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
  - **OQ4:** N = 60 held repeats per agent key per held window (`toll.window` long, opened by the first held repeat, cleared when the offer window rolls or the key pays), a constant (PIPE:102).
- **No ADR.** Constitution Art. VII.24 asks for an ADR before "any decision that contradicts `plan.md`". The root `plan.md` says nothing about cooldowns, reservations or `Retry-After`, so there is nothing in it to contradict. ADR-004 (`docs/adr/004-cloudflare-batteries-included.md`) says a payer with repeated fresh failures gets a cooldown. O1 counts in-flight settles toward that same limit, and O4 adds one exception (a due payment gets one attempt). Both refine ADR-004's rule; neither reverses it. The owner can overrule this and ask for an ADR; none of the code depends on the answer.
- **T005 ruling** (tasks.md T005, commit `e5d8b20`, option 1). Two per-nonce bounds, both as measured:
  - **3 settle calls** for a lone early nonce against a lagging facilitator: the first attempt, the due attempt, and one ordinary retry (the payer's third failure), then `payer-cooldown`. Pinned by PS:2323, which asserts exactly 3. This is no more than main for that case.
  - **2 settle calls** per nonce for a payer who is cooled down or reserved out: the first attempt and the due attempt. Pinned by PS:2296 (`f.per.get(xps[0])` is 2).
  - Row A5 is unchanged and the ordinary retry is not refused, as ruled. spec.md's R-O4 "Bound" line and US4 state both since R003.

## 8. Not done, and whose

All of these are the owner's (**O001**). No agent does them.

- Live facilitator measurements. Every settle answer in this work is an in-process stub.
- workerd / Pages measurements. The tests call `createPagesMiddleware` in Node under vitest.
- Deploy.
- npm publish. No version bump; the CHANGELOG entries are under `2.3.0 — Unreleased`.
- The merge word on the draft PR.
- The decision on `retry-after: 1` for `settle-throttled` (O2 variant b). Not built; spec OQ2 calls it a one-line follow-up.

Still open for the crew: **GATE F** (reviewer agent, verify, GitHub CI green on the draft PR), and the items at the top of this file.

## 8a. R001: second review, H1 (held repeat rolls the offer window)

Written by R007 (2026-11-13) on `a2681ea`; every line number in 8a and 8b was checked at that tree. The fix is commit `376f65c`. The red/green and mutation counts are quoted from the commit messages of `376f65c` and `ed98127` (the QA's record); R007 did not run them again.

**The fix.** `recordHeld` (LEDGER:93-102) no longer rolls the offer window and never writes `windowStart` or `offersInWindow`. The held count has its own window: `heldStart` (LEDGER:24), a `WeakMap` beside the entry, since row T1 fixes the shape of `OfferState`. It has the same length as the offer window and is opened by the first held repeat (LEDGER:95-99). The count is cleared when `recordOffer` rolls the offer window (`roll`, LEDGER:62-69) and on payment (LEDGER:113-114). An entry only held repeats have written has no offer window: it is never exhausted (`heldOnly`, LEDGER:57-59 and :128), and its first offer opens the window (LEDGER:74).

**The rule changed.** It was "60 free held repeats per offer window". It is now **60 per held window** (`cfg.toll.window` long, starting at the first held repeat). `HELD_REPEATS_FREE = 60` is unchanged.

**Pinning tests.**

| Test | What it pins |
|---|---|
| `packages/core/test/ledger.test.ts`:59 `recordHeld never rolls the offer window (H1)` | the reviewer's t=1203 case (:65-66); replaces `recordHeld rolls with the window like recordOffer` |
| :80 `the held count expires with its own window, not the offer window` | the held window |
| :109 `the held window edge: exactly windowMs old still counts, 1 ms more restarts` | the edge |
| :120-121 `recordHeld leaves offers alone at every t across the edge (seeded=%s)` | the sweep across the window edge |
| :149 `recordOffer's window roll clears the held count`; :161 `recordPaid resets the held count` | the two resets |
| `packages/core/test/pipeline-payment.test.ts`:280-281 `a held repeat after the window expired does not restart it (H1, seeded=%s)` | at t=1203 the answer is the maze (:312), as on main |
| :322 `held repeats spread over two windows: 50 + 11 record no offer (main's answers)` | old repeats stop counting |

Red/green as recorded in `376f65c`: **7 red** on HEAD's ledger, **63 green** on the diff with the golden test. The snapshot file is unchanged.

**Acceptance check 2, a reading the reviewer must confirm.** The check said `heldInWindow` is reset only in `roll()` and `recordPaid`. It is also reset in `recordHeld` when the held window has expired (LEDGER:96-99). So the check is met in intent, not to the letter. Without that reset the 50 + 11 schedule records an offer that main does not: the mutation run in `376f65c` shows 3 tests red with it removed.

**Open points.**

1. **Receipt window start: open at R001, closed since by R005 (`e9adf06`).** After R001, for a key whose only ledger entry came from a held repeat, the hono receipt read the first held time where main uses the current second. The receipt now reads the ledger through `usableState` (LEDGER:144-147, HONO:887-888), so such a key gets the current second (HONO:895). Test: `packages/hono/test/reporter-wiring.test.ts`:132 `R005: a held-only ledger entry does not set the receipt window`.
2. **LRU side effect: open, not fixed.** `recordHeld` still calls `touch()` (LEDGER:94). On a full ledger a held repeat from a new key evicts the oldest key (LEDGER:33-36), and a held repeat from a known key refreshes its place. Main writes nothing for a held repeat. R-O3 (spec.md line 42) mandates the touch.
3. **Docs that stated the old rule: README, CHANGELOG and this file resolved by R008; spec.md resolved by R011.**
   - Resolved by R008: `packages/cloudflare/README.md`:107-110 and :152 now state the held-window rule.
   - Resolved by R008: `packages/cloudflare/CHANGELOG.md`:10 (A3) now states the held-window rule.
   - Resolved by R008: this file's row A3 (line 24), row T1 (line 30) and the OQ4 line in section 7 now cite the current `ledger.ts` lines, test names and rule. The rest of sections 1 to 8 stands as T010 wrote it at `2d680f1`.

## 8b. R002: second review, M1 (reservation has no time limit)

The fix is commit `ed98127`. Line numbers are at `a2681ea`, so they include what R003, R004 and R006 moved.

**Reservations.** Each reservation is its own object with a start time, `{ atMs }` (CF:257, made at CF:350-354). The cooldown check counts only those younger than `RESERVATION_TTL_MS` (`liveReservations`, CF:259-266; the check, CF:329). The limit is checked on read; there is no timer. Every new reservation sweeps the whole map (CF:349). The `finally` removes only its own reservation (CF:523-533), so a late answer leaves newer ones alone. The per-nonce `inflight` join (CF:313-321) is untouched.

**The numbers.**

Corrected by R015. Both values were changed by R013 (commit `926bb12`); the two lines below give the current values, with line numbers at `04828e6`. History: R002 (`ed98127`) set a 10 s timeout and a 30 s limit, as judgment only. Review round 2 (M1) found 10 s below the settle route's own worst successful case. Detail in section 13.

- `SETTLE_TIMEOUT_MS = 25_000` (CF:106). The settle fetch passes `AbortSignal.timeout(SETTLE_TIMEOUT_MS)` (CF:434). Why 25 s: reasoned from the route budget (verify 10 s + settle 10 s + receipt write), NOT measured; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured (the comment at CF:92-104, and `pr-body.md` "Choices for the owner"). No latency data shows how long the data-api settle route really takes with its on-chain wait. If it takes longer than 25 s, the payer is answered `settle-unconfirmed` and not served, while the transfer may already have confirmed. Without a limit a settle route that never answers holds the request, its reservation and its `inflight` entry for the life of the isolate.
- `RESERVATION_TTL_MS = 45_000` (CF:115). Why 45 s: the settle timeout plus a 20 s margin, so a reservation does not expire while its own settle can still be running (CF:107-113). NOT measured; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured.
- **Changed since R002:** at `ed98127` a timeout landed in the existing catch as `settle-unreachable`. Since R006 (`a2681ea`) it is answered `settle-unconfirmed` (row 3a; CF:497-498), because the transfer may have been broadcast before the abort. Not cached, not counted.

**`waitUntil`: not built.** R002(b) asked to run the settle and its release under `ctx.waitUntil` where a context exists. The verifier is built once per isolate, inside `buildState` (`makeSettlingVerify`, CF:686), not per request. hono calls it with only `{ nowS, resource }` (HONO:862-865); it passes no context. Wiring `waitUntil` would mean changing `packages/hono`. So liveness rests on the reservation limit (45 s since R013):

- A settle that hangs is aborted at the timeout (25 s since R013), and its `finally` releases the reservation.
- **Where there is no context (every settle today):** a client disconnect can cancel the request, and then the `finally` never runs. The reservation stops counting at the limit (45 s since R013) after it began. It is removed at the next read for that payer or the next new reservation, not by the `finally` and not by a timer.
- The `inflight` entry for that payment had no limit of its own when this section was written; it was removed only in the same `finally`. Since R013 it has the same 45 s limit (section 13).

**Pinning tests** (PS; six, under the comment at PS:2249).

| Test | Line |
|---|---|
| `R002 M1 test 1: 3 settles that never answer; once RESERVATION_TTL_MS has passed the payer is served again` | PS:2296 |
| `R002 M1 test 2: other payers are served at every step of a payer's hung settles` | PS:2325 |
| `R002 M1 test 3: hung payers at 5/s for 60 s leave 150 reservations, not 300; 0 after the bound and a sweep` | PS:2375 |
| `R002 M1 test 4: a copy of an in-flight payment whose reservation expired still joins it: one settle call, served once` | PS:2410 |
| `R002 M1 test 5: an expired reservation whose settle answers late does not release a newer one` | PS:2441 |
| `R002 M1 test 6: a hung settle is aborted at SETTLE_TIMEOUT_MS → settle-unconfirmed (row 3a, R006), not served, nonce not cached` | PS:2465 (R006 changed its expected reason) |

Red/green as recorded in `ed98127`: tests 1 to 6 red on HEAD source, green on the diff; every mutant the QA ran was killed. The commit message gives no count of mutants.

**Docs.** Updated: `packages/cloudflare/README.md`:93 (row 0c no longer lists the timeout), :96 (row 3a lists it) and :114-119 (the timeout and the limit, then 10 s and 30 s). **No CHANGELOG line was added** for the timeout or the limit by R002; CHANGELOG A9 and A10 carry them now, with the R013 values (section 13).

**Not done.**

- spec.md line 30 ("an entry exists only while a settle for that payer runs") is now false: an entry can outlive a cancelled request until it is swept. Not edited; spec.md is off limits to the coder. Queue for closeout.
- spec.md line 144 ("The code has no timeout of its own and none is added") is now false. Same.
- spec.md line 29 still lists "timeout/abort" under `settle-unreachable`; since R006 a timeout is `settle-unconfirmed`. Same.
- The test comment at PS:2165 ("A reservation has no expiry") is stale. Not edited; R007 is docs only.

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

**L3.** At R003, line 3 of this file named the commit that update was written on as the head; the R003 commit came after it, so the claim was stale as soon as it was committed (review round 2, L6). Corrected by R014: line 3 now names the round-2 review head `7e81768` and points to `git log` for the commits after it (section 11).

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

**Golden comparison, re-run.** (a) On the R004 tree the golden file passes (27 tests) and `git status` shows no change to `packages/cloudflare/test/__snapshots__/contract-golden.test.ts.snap`: every entry is byte-identical. (b) Section 3's run repeated on the R004 tree (every `packages/*/src` file replaced with `git show main:<path>`, `pnpm exec tsc -b` exit 0, then the golden file): the same result as section 3 had then. History, before R012: section 3 now holds R015's re-run, which differs on four entries.

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

## 11. R014: review round 2 of 7e81768, docs and lows

Written on `926bb12` (`git rev-parse --short HEAD`), with the R014 change in the worktree. Line numbers here are at that tree. R014 changes no file under `packages/*/src`.

**Head line (round 2 L6, round 1 L3).** Line 3 of this file named two older commits as the head. It now names `7e81768`, the head review round 2 read, and points to `git log 7e81768..HEAD` for the R-task commits after it. The per-section commit notes stay as history. The L3 note in section 9 is corrected the same way.

**L1 (a timeout during a non-2xx body read) was closed by R013, commit `926bb12`.** It is not a known gap. The non-2xx body read now rethrows a timeout, so the README and CHANGELOG A9 sentences ("the read of its body, whatever the status"; "a 2xx or a non-2xx body alike") are true as written and R014 does not change them. Pinned by:

- PS:966 `row 3a (R013 L1): HTTP ${status} headers, then the timeout fires during the body read → settle-unconfirmed, not cached, not counted` (run for 502 and 400).
- PS:2779 `R013 L2: the native AbortSignal.timeout(SETTLE_TIMEOUT_MS) ends a hung settle, and a stalled non-2xx body, as settle-unconfirmed (real timer, 25 s)`.

**L3 (two surviving ledger mutants): both now killed.** The review ran 20 mutants on the fix lines: 18 killed, 2 survived. R014 adds two tests to `packages/core/test/ledger.test.ts` and ran those 2 mutants again; the other 18 were not re-run. Each mutant was made in a throwaway copy (`crew-scratch`, one `sed` deleting the line), never in the worktree.

| Source | `ledger.test.ts` result | Failing test | Failure |
|---|---|---|---|
| HEAD `926bb12` | 13 passed / 13 | none | |
| LEDGER:67 deleted (`roll` keeps the held start) | 1 failed / 12 passed | `recordOffer's window roll restarts the held window, it does not carry the old start over` | `expected 1 to be 2` |
| LEDGER:114 deleted (`recordPaid` keeps the held start) | 1 failed / 12 passed | `recordPaid clears the held window's start, not only its count` | `expected 1 to be 2` |

Why the older tests missed them: after a roll or a payment the held count is 0 either way. Only the window's end differs, and that shows in a later held repeat that is inside the restarted window but more than one window after the old start. Result for the review's set, if its other 18 still hold: 20 of 20 killed.

**L4 (replay-cache turnover): stated, not changed.** The in-isolate replay cache holds 512 entries, oldest out (`DAMP_CAP`, CF:79; read at CF:334). At the bucket rate, 5 settle calls per second (CF:85), 512 other settled payments pass in about 100 s (the review's probe P7: 98.6 s). A payment can live up to 300 s plus the skew allowance, so a settled payment can outlive its cache entry. After the turnover a replay of it is not answered locally: it takes a bucket token and a settle call. Replay safety then rests on the settle route refusing a spent nonce. The review read that in the data-api route (`fareseal-settle.js:106-107`); it was read only, not run against a facilitator, and R014 did not read it again. This is the same in one isolate and across isolates. The README now says so in the paragraph on one state per isolate, with a pointer from the row 3a paragraph. The route was not made idempotent, and the README says it must not be without changing this cache. Same on main.

**Paths and names (L6).** This repo is public. Replaced with neutral wording: the worktree path in section 6's vitest banner (`<worktree>`); the owner's first name in section 8; the local temp and scratchpad paths in second-review-2abd077.md's disclosure (`<review-temp-dir>`); the local coordinator path in spec.md line 5 (`<coord>/…`, on the coordinator's ruling; nothing else in spec.md). Not changed, by the brief: tasks.md and second-review-7e81768.md, which still carry the first name and local paths, and the first name elsewhere in spec.md (lines 3, 10, 13, 150).

## 12. R014: what cannot be tested here

No workerd, no facilitator and no chain are available to the crew; every test is Node under vitest with a stub settle route. Each item below is the owner's (**O001**, tasks.md:18).

- Cross-isolate behaviour: each test has one isolate's state, so what two isolates do with one payment is not run (O001).
- The late on-chain settle: whether a transfer lands after the toll's timeout needs a real facilitator and chain (O001).
- Runtime cancellation: whether workerd cancels the settle fetch and skips `finally` when the client disconnects (O001).
- Abort over the service binding: whether a service binding honours the abort signal, and what the settle route does when it is aborted (O001).
- The native timer on workerd: PS:2779 runs the real `AbortSignal.timeout` in Node only (O001).
- First-burst interleaving on a cold workerd isolate: the cold-start tests use Node's interleaving (O001).

## 13. R012 and R013: review round 2 of 7e81768, M2, M1 and M3

Written by R015 on `04828e6` (`git rev-parse --short HEAD`). Line numbers here are at that tree. R015 changes this file only. CHANGELOG lines are in `packages/cloudflare/CHANGELOG.md`.

### R012 (commit `c6d1e92`): rows A11 and A12

**A11, the error-only 402** (CHANGELOG:18). For `settle-unconfirmed` and `no-transaction-id` the payer may already have paid, so the 402 carries no offer.

- The two reasons: `MAYBE_PAID`, HONO:630.
- The answer: HONO:708-719. One header is set, `cache-control: no-store` (HONO:714); the body is `{ x402Version: 1, error }` (HONO:715-718). It returns before the offer is built (HONO:720 onward), so there is no `x-payment-required`, no `accepts`, no `options`, no `price_usd` and no Stripe `link`.
- The new `settle-unconfirmed` text: HONO:624-625. It replaces `…do not pay again, contact the operator`. The `no-transaction-id` text (HONO:618) is unchanged.
- Golden entries `no tx id` and `unconfirmed` (GOLD:201-202) changed with it; section 3 shows both now differ from main.

**A12, the map of unconfirmed payments** (CHANGELOG:19).

- Constants: `UNCONFIRMED_CAP = DAMP_CAP` (512) at CF:124, `UNCONFIRMED_TTL_MS = 600_000` (10 minutes) at CF:125. The comment at CF:116-123 calls the age limit a judgment, not a measurement.
- The map: CF:312, payment key to the time of its last unconfirmed answer.
- Written by `answerUnconfirmed` (CF:410-413) through `remember` (CF:199; capped, oldest out). Its callers are the row 3a paths; the timeout path is CF:575.
- Read at CF:554-559, before the `seenPayments` write (CF:560) and the `payerFails` write (CF:564): while an entry is younger than the limit, a payer-class settle answer for that payment is `settle-unconfirmed` again, not cached, not counted. The entry's time is not renewed there. An entry at or past the limit is deleted (CF:558).
- A confirmed settle deletes the entry: CF:468.
- `_sizes()` reports `unconfirmed`: CF:620.

**Pinning tests** (PS; names as grep prints them).

| Row | Test | Line |
|---|---|---|
| A11 | `rows 2 and 3a (R012 M2): the maybe-paid 402 is error-only: no x-payment-required, no accepts, no options, no price` | PS:986 |
| A11 | golden entries `no tx id` and `unconfirmed` | GOLD:201-202 |
| A11 (text) | the `settle-unconfirmed` text in `packages/hono/test/payment-errors.test.ts` | :90 |
| A12 | `row 3a (R012 M2): timeout, then the same payment answered ${name} → settle-unconfirmed again, not cached, payerFails 0` (run for row 6 and row 7, PS:1028-1031) | PS:1032 |
| A12 | `row 3a (R012 M2): through the middleware, timeout then nonce-used on the retry is the unconfirmed 402 again` | PS:1064 |
| A12 | `R012 M2: an unconfirmed entry expires at UNCONFIRMED_TTL_MS, and an answer in between does not renew it` | PS:1079 |
| A12 | `R012 M2: the unconfirmed map is capped at UNCONFIRMED_CAP, oldest out` | PS:1111 |

Red/green as recorded in `c6d1e92`'s message, not re-run by R015: the six new R012 tests fail on the source before it and pass on the diff; three mutants (limit `<` to `<=`, cap removed, delete-on-success removed) were each killed.

### R013 (commit `926bb12`): rows A9, A10 and A13

**The numbers (M1).** Both are named constants. Both are reasoned from the route budget (verify 10 s + settle 10 s + receipt write), NOT measured; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured.

- **A9** (CHANGELOG:16): `SETTLE_TIMEOUT_MS = 25_000`, CF:106; used at CF:434 (`AbortSignal.timeout(SETTLE_TIMEOUT_MS)`). Reasoning in the comment at CF:92-104: the data-api settle route awaits the facilitator's verify, then its settle, each with its own 10 s timeout, then writes the receipt, so a call that succeeds can take about 20 s plus the write. 25 s clears that case; the 10 s of R002 did not. NOT measured; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured.
- **A10** (CHANGELOG:17): `RESERVATION_TTL_MS = 45_000`, CF:115; comment at CF:107-113. It is the settle timeout plus a 20 s margin. Read for reservations at CF:304 (`liveReservations`). NOT measured; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured.

**A13, the age limit on `inflight`** (CHANGELOG:20, M3). The limit is `RESERVATION_TTL_MS`, so it has the same status: NOT measured; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured.

- An entry is `{ atMs, p }`: CF:288-289.
- On read, CF:360-373: a copy joins the settle only while the entry is younger than the limit (CF:362); an entry at or past it is deleted (CF:372) and the request goes on as a new attempt.
- Swept with the reservations when a new settle starts: CF:401-402.
- A new entry is stamped at CF:579-580.
- The `finally` removes only its own entry, by identity (CF:605), so a settle that answers late leaves a newer entry for the same payment alone.
- Known limit, CF:284-287: a custom `fetch` that ignores the abort signal can still be running at that age, and the payment then gets a second settle call.

**Also in `926bb12` (L1):** the non-2xx body read rethrows a timeout (`isTimeout`, CF:196-197; the rethrow, CF:444). Section 11 gives its tests.

**Pinning tests** (PS).

| Row | Test | Line |
|---|---|---|
| A9, 25 s | `R002 M1 test 6: a hung settle is aborted at SETTLE_TIMEOUT_MS → settle-unconfirmed (row 3a, R006), not served, nonce not cached`; the value is asserted at PS:2666 (`expect(SETTLE_TIMEOUT_MS).toBe(25_000)`) | PS:2656 |
| A9, 25 s | `R013 L2: the native AbortSignal.timeout(SETTLE_TIMEOUT_MS) ends a hung settle, and a stalled non-2xx body, as settle-unconfirmed (real timer, 25 s)` | PS:2779 |
| A10, 45 s | `R002 M1 test 3: hung payers at 5/s for 60 s leave 5 x RESERVATION_TTL_MS/1000 (225) reservations and inflight entries, not 300; 0 after the bound and a sweep`; the value is asserted at PS:2582 (`expect(5 * TTL_S).toBe(225)`, so 45 s) | PS:2560 |
| A10 | `R002 M1 test 1: 3 settles that never answer; once RESERVATION_TTL_MS has passed the payer is served again` | PS:2479 |
| A13 | `R002 M1 test 4: a copy of an in-flight payment still joins it one ms before RESERVATION_TTL_MS: one settle call, served once` | PS:2605 |
| A13 | `R013 M3: the same payment sent again RESERVATION_TTL_MS after a settle that never returns gets one new settle call and an answer` | PS:2703 |
| A13 | `R013 M3: 51 dead settles leave no inflight entry after the limit and a sweep` | PS:2730 |
| A13 | `R013 M3: a settle that answers after its entry expired does not remove the newer entry for the same payment` | PS:2744 |

The six `R002 M1` tests have moved since section 8b listed them: they are now at PS:2479, 2508, 2560, 2605, 2632 and 2656, and tests 3 and 4 were renamed by R013. They take both values from the source (PS:2435-2437). No test asserts the literal `45_000`; PS:2582 pins it through 5 x 45 = 225.

R015 ran none of these tests. The only run R015 made is the golden comparison in section 3.

**Still stale, not R015's to edit:** spec.md and pr-body.md still carry the 10 s and 30 s values (queued as R016 and R017).

## 14. R020: owner decisions of 2026-11-14, and review round 3 L1 and L2

Review: `second-review-32c3a07.md` (round 3 of `32c3a07`, PASS, eight lows). CF and PS lines in this section are as of R020; R020 moved the source below CF:320 down by about 60 lines, so CF lines in earlier sections are as of their own commits.

**(a) The timeouts.** The owner approved `SETTLE_TIMEOUT_MS = 25_000` (CF:106) and `RESERVATION_TTL_MS = 45_000` (CF:115) as they are: approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured. Values unchanged. The wording is changed in the CF comments, CHANGELOG A9, A10 and A13, the README, this file (sections 8b and 13) and `pr-body.md`.

**(b) L1, row A14.** While a payment is remembered as unconfirmed (A12), every 402 for it is the error-only unconfirmed 402. Source:

- CF:321 `unconfirmedNow(key)`: entry present and younger than `UNCONFIRMED_TTL_MS`; an older entry is deleted. It never renews the entry. CF:329 `keyOf`: the payment key, as before.
- CF:398 `fault(r)`: `settle-unconfirmed` for a remembered payment, else `r` unchanged. It wraps `not-yet-valid-held` (CF:418), `payer-cooldown` (CF:447), `settle-throttled` (CF:455), `settle-retryable` rows 3 and 4 (CF:564, CF:572) and `settle-unreachable` (CF:642).
- CF:587: row 5 for a remembered payment returns before the hold and the count are written (review L8: it was counted before).
- CF:624: the R012 row 6/7 amnesty, same behaviour, now through the helper.
- CF:338-374: the local check. Its rejection carries no payer, so for `expired`, `not-yet-valid` and `window-too-long`, and only while something is remembered, `verifyProof` is run again with the clock at the payment's own `validBefore`. It passes only for a well-formed, correctly signed authorization and gives the signer for the key. A `validBefore` beyond a safe integer is not tried. The other local reasons (malformed, wrong network or recipient, low value, bad signature, signer mismatch) cannot be a remembered payment: the same signed bytes passed that check when the payment was remembered.
- Nothing is written on any of these paths: no `seenPayments`, `payerFails` or `notYetValid` entry, and a live `unconfirmed` entry is neither deleted nor re-timestamped. The retry is not stopped before the settle call. The due-pass block and `packages/hono` are unchanged.

**Tests (PS:1138-1445, and the row A7 test at PS:3528).** 14 tests carry `R020` in the name:

- 4 remembered second faults (502, connection failure, throttle, cooldown) and the same 4 for a payment that is not remembered (today's reason, text and offer).
- L2: HTTP 502 + `settled:true` is remembered; the retry answered `nonce_used` is unconfirmed, not cached, not counted.
- Row 3 (HTTP 200 `retryable:true`) and row 5 (`valid_after`, `validAfter` still ahead) for a remembered payment: unconfirmed, `_sizes()` unchanged (no hold, no count, entry kept), no `x-payment-required`, no `retry-after`.
- A remembered payment past its `validBefore`: unconfirmed, no settle call, nothing written; a payment that is not remembered and a copy with an altered `validBefore` get `expired`; an oversized `validBefore` does not throw; at 600 s the entry is dropped and the answer is `expired`.
- The entry is not renewed by a second fault.
- The existing row A7 test (a due attempt answered 502 + `settled:true` is not put back) changed its expectation: its retry meets the cooldown as a remembered payment, so it now gets the unconfirmed 402 instead of "payer cooling down". Its guard for mutant M26 (no settle call, 4 calls) is kept. Sections 9's quotes of its old name are records of past runs.

**Red, then green** (`vitest run packages/cloudflare/test/pages-settle.test.ts -t R020`):

| step | source | result |
|---|---|---|
| first tests written | `32c3a07` source | 5 failed, 5 passed. Failed: the 4 remembered second faults and "does not renew". Passed: the 4 not-remembered tests and L2 (a test gap; the code was right) |
| after `fault()` and the row 5 guard | first fix | 10 passed; full suite 60 files, 832 passed (1 existing test, row A7, updated as above) |
| QA: `fault()` off | mutant | 6 failed, 5 passed (11 tests with row A7) |
| rework tests written | first fix | 1 failed, 13 passed. Failed: the `validBefore` test |
| row 5 guard off (`if (false)`) | mutant of the first fix | the row 5 test fails (and the `validBefore` test, not yet fixed) |
| row 3 `fault()` removed | mutant of the first fix | the row 3 test fails (and the `validBefore` test, not yet fixed) |
| oversized `validBefore` case added, before its guard | local-check fix without the guard | the `validBefore` test fails with a RangeError |
| after the local-check fix | final | 14 passed |

Full run on the final tree: `npm run typecheck` exit 0; `npm test` 60 files, 835 passed, 0 failed (822 at `32c3a07` plus 13 new); `npm run lint` exit 0.

**Not changed (review lows L3 to L7):** not in R020's scope.
