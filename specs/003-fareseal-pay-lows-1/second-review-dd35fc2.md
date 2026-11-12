VERDICT: PASS

# fareseal-pay-lows-1 - independent second review 3 (GATE R)

Commit dd35fc24bb1112fe3794f956d93b0e43451d0716, branch crew/fareseal-pay-lows-1.
Base origin/main 514bb79d01935dd9e97fe15349bbffa3dbb464af (= `git merge-base origin/main HEAD`).
Reviewed 2026-11-12. Read-only: the worktree was clean and at dd35fc2 before and after.

No HIGH. No MEDIUM. Lows only (one is a surviving mutant, the rest are equal to main or already
recorded as known costs). The round-2 medium (M1, the one-payer drain) is closed: every drain
number measured on dd35fc2 equals the number measured on origin/main with the same probe.

All work ran in `git archive` copies under /home/o2k/.crew/coord/review-tmp (fareseal3,
fareseal3-main, fareseal3-mut), removed afterwards. Probes and mutants ran inside an empty network
namespace (`unshare -rn`), so they could not reach anything.

## 1. Closure of the round-2 findings

Paths: CF = packages/cloudflare/src/index.ts, CORE = packages/core/src/pipeline.ts,
HONO = packages/hono/src/index.ts, PS = packages/cloudflare/test/pages-settle.test.ts,
CT = packages/core/test/pipeline-payment.test.ts.

| # | State | Fix (file:line at dd35fc2) | Test that pins it |
|---|---|---|---|
| M1 one-payer drain with fresh early nonces | CLOSED | CF:370-378: the row-5 reject is counted in `payerFails` (:374-377); the hold (:243-250) keeps the same payment from being counted twice; a successful settle clears the count (:319) | PS:1354 (burst of 30 -> 3 calls), PS:1371 (10 rps for 60 s -> 3 calls), PS:1387, PS:1407 (counted once), PS:959 (row 5 counted). My probe: 3 calls, same as main (section 2) |
| L-a settle-throttled let a verified agent avoid the maze | CLOSED | CORE:131 (`settle-throttled` is not a no-offer fault; its 402 text stays the operator-fault one) | PS:1455, PS:1495, CT:150. My probe M-a: 402,402,402,302.. as on main |
| L-b honest fast-clock agent mazed while waiting | CLOSED | CF:247-248 (`not-yet-valid-held`), CORE:371/383/404 (skips only the ledger write, still meets step 7), HONO:605 (same text) | PS:1428 (402 x6 then 200, 2 calls), PS:1473 (a mazed agent stays mazed), CT:229, CT:238, hono payment-errors.test.ts:79 |
| L-c facilitator clock behind ours: each retry settled | BOUNDED, recorded | Row 5 is counted, so the retries stop at the cooldown (3 calls; was 32 / 245). Cost recorded: README "Known costs" (packages/cloudflare/README.md:102-104), closeout "Known costs" | No dedicated test. Measured A17/A18 below |
| L-d README/CHANGELOG silent on the hold | CLOSED | README.md:83 (row 5: held, counted once per nonce, offer on first attempt only), :76 (row 0b offer yes), CHANGELOG.md:12-13 | PS:1039 "README table: every row id has a scenario and its cells match the code" |
| L-e closeout had no R-task section | CLOSED | specs/003-fareseal-pay-lows-1/closeout.md:289-402 (decisions, measured table, known costs, docs) | - |
| L-f settle-unconfirmed uncached | RECORDED (as asked) | closeout.md:372-382, with the reason it is left uncached | PS:878 (row 3a) unchanged |
| L-g carried items (bad price 400, no settle timeout, cold-start cache, no-transaction-id) | UNCHANGED, recorded | README "Known costs", closeout | - |

## 2. The drain, measured

Method: one probe file in the temp copies, run unchanged on dd35fc2 and on origin/main. The real
`makeSettlingVerify`, `createPagesMiddleware` and the hono pipeline run in-process; the settle
backend is a stub function (valid_after while early, settled:true + tx for a funded payer once per
nonce, else insufficient_funds); `Date.now` is mocked; global `fetch` is replaced by a counter that
throws (0 calls). Real secp256k1 signatures, real keys generated per payer.
Budget: per-isolate bucket 20 burst + 5/s; per-payer limit 3 failures then 600 s cooldown.
"Victim" = a different, funded payer sending one valid payment after (or during) the attack.

| Scenario | Requests | Settle calls dd35fc2 | Settle calls main | Victim on dd35fc2 |
|---|---|---|---|---|
| A1 one payer, fresh plain unfunded nonces, sequential burst | 100 | 3 | 3 | served |
| A2 one payer, fresh EARLY nonces (+55 s), sequential burst | 100 | 3 (9c5c489: 20) | 3 | served |
| A3 one payer, fresh EARLY nonces, 10 rps for 60 s | 600 | 3 (9c5c489: 319) | 3 | served |
| A11c one payer, EARLY, 30 per second sequential, 60 s | 1800 | 3 | 3 | served 60/60 |
| A4 one payer, the SAME early payment | 100 | 1 | 1 | served |
| A5 one payer, the SAME plain unfunded payment (replayed nonce) | 100 | 1 | 1 | served |
| A6 many payers (new key each), plain unfunded, burst | 100 | 20 | 20 | throttled |
| A7 many payers, EARLY, burst | 100 | 20 | 20 | throttled |
| A11b many payers, plain, 30 per second for 60 s | 1800 | 315 | 315 | throttled 60/60 |
| A8 one payer, fresh EARLY nonces, 100 CONCURRENT | 100 | 20 | 20 | throttled |
| A9 one payer, fresh plain unfunded, 100 CONCURRENT | 100 | 20 | 20 | throttled |
| A10 one payer, EARLY, 30 concurrent per second for 60 s | 1800 | 30, then cooldown | 30 | throttled 3 of 60 s, served 57 |
| A11 one payer, plain unfunded, 30 concurrent per second, 60 s | 1800 | 30, then cooldown | 30 | throttled 3 of 60 s, served 57 |
| A12 malformed x100 (garbage, non-payment JSON, altered value, 9000 chars), then a valid funded payment | 101 | 0, then 1 (served) | same | - |
| A18 one unfunded payer, facilitator always says valid_after, same payment valid from now, 10 rps | 300 | 3 (9c5c489: 245) | 1 | served |

Answers to the questions:

- Can ONE payer exhaust the budget for others? Sequentially: no. 3 calls, then `payer-cooldown`
  for 600 s, for early and plain payments alike, exactly as on main. With CONCURRENT requests: yes
  for a moment (20 calls in one burst, 30 in a minute, then the cooldown holds), but this is
  identical on main and for plain unfunded payments (A8-A11), so it is not this branch's and not
  worse than main. See low N1. Many payers reach the bucket on both trees (keys are free); that is
  the designed ceiling.
- Replayed nonce: 1 call, then answered from the cache (A5), or held locally (A4).
- Not-yet-valid then valid (A13, funded, +55 s): not-yet-valid (1 call), 10 repeats held (0 calls),
  at +55 s served once (call 2), 5 replays `already-settled` (0 calls). Settled exactly once.
- Malformed then valid (A12): malformed never reaches settle and is not counted; the valid payment
  is served with 1 call.
- Concurrent identical (A14): 50 copies of one funded payment -> 1 OK, 49 `already-settled`, 1 call.
  A15: 50 copies of one funded EARLY payment -> 1 call; when due, 50 concurrent copies including a
  re-encoded body and a respelled nonce -> exactly 1 OK, 49 `already-settled`, 1 more call.
- Content without a settled payment: not found. In every scenario an OK result or a 200 came only
  for a payment the stub had settled, and the stub settled each funded payment exactly once.
- Settled twice: not found (settled counts are all 1; replays make 0 calls).
- Settled without content: not found on the changed paths. The two recorded cases remain
  (settled:true with no usable tx id; non-2xx with settled:true), unchanged by this round.
- Memory after 100,000 distinct nonces (Z1: about 4,000 payer keys, a quarter each plain unfunded, early
  from many payers, early from ONE payer, funded; 75,147 settle calls): nonce cache 512, payer
  cooldown map 512, not-yet-valid map 512, in-flight map 0. Maximum ever seen: 512 / 512 / 512 / 0.
  Bounded. A19: 2,000 concurrent payments while the settle call never answers -> in-flight map 20
  (it is filled only after a bucket token is taken), 0 after release.

## 3. `settle-throttled` answering with the offer again

Measured through `createPagesMiddleware` (P1) and the hono pipeline (M-a), same on main:

- Does the payer lose money? No. The throttled request makes no settle call (0 calls for the
  throttled answer and for 50 retries). Nothing is cached or counted for that payment. After the
  bucket refills (1 s) the SAME payment is settled once and served 200 with X-PAYMENT-RESPONSE; a
  replay is 402 "nonce already used", 0 calls.
- Can it loop forever? Only as long as the bucket stays empty, and each loop costs no settle call.
  An anonymous client gets 402 every time. A verified agent gets 402, 402, 402, then 302 (the maze)
  from the 4th throttled attempt inside the 10 min window; it is still served 200 when it presents
  the payment after the refill (measured). This is the R004 trade and it equals main. Note: someone
  who keeps the bucket empty with rotating keys (more than 5 requests/s) can push an honest paying
  verified agent to a 302. Same on main; recorded in README row 0b.
- Distinguishable from a fresh 402? Yes, by the `error` field only: fresh = "X-PAYMENT header is
  required"; throttled = "settlement unavailable (operator fault); retry the same payment". Status,
  headers (cache-control, content-type, x-payment-required) and every other body key are identical.
  No Retry-After header (N3).
- Anything secret echoed? No. The settle token, the settle URL and the word "bearer" appear in no
  status line, header or body of the fresh, throttled, paid or replay answers.

## 4. Stripe

Untouched. `git diff origin/main...HEAD` shows one Stripe file: packages/adapter-stripe/package.json,
1 line, `"version": "2.2.0"` -> `"2.3.0"` (the all-packages version rule, T008). No file under
packages/adapter-stripe/src, not packages/core/src/voucher.ts, no lockfile, no workflow is in the
diff. In the changed source files (core config.ts, pipeline.ts; hono index.ts; cloudflare index.ts;
adapter-x402 index.ts) no added or removed line contains "stripe" or "voucher"
(`git diff origin/main...HEAD -- packages ':!packages/*/test' | grep -iE '^[+-].*(stripe|voucher)'`
matches only the two package.json file headers). The R004/R005 delta (9c5c489..HEAD) names no
Stripe file at all.

## 5. Mutants (18, each alone in the temp copy, `pnpm test` = tsc -b + full suite, restored after)

17 killed, 1 survivor. (Under the empty network namespace one unrelated test, examples/node
"real local socket", fails because loopback is down; baseline there is 680/681, and 681/681 with
loopback up. It is excluded from the counts below.)

| Mutant | Failed | First failing test |
|---|---|---|
| M01 CF:374-377 row-5 count removed | 7 | PS "row 5 (AC-3.3, R004 M1) ... now counted toward the cooldown" |
| M02 row-5 count never accumulates (`n: 1`) | 6 | same |
| M03 row-5 cooldown length zero (`untilMs: now`) | 7 | same |
| M04 CF:248 held reason back to `not-yet-valid` | 3 | PS "README table ..."; "M1: the same early payment at 10 rps ..." |
| M05 row 5 also caches the nonce | 8 | PS "row 5 (AC-3.1/3.2) ... retried later serves" |
| M06 CF:373 hold not written (count only) | 8 | PS "the same early payment x30 - at most 1 settle call ..." |
| M07 CORE:131 settle-throttled no-offer again | 4 | PS "L-a: a bucket drain by rotating unfunded payers ... 302 from the 4th" |
| M08 CORE:383 held answer always ledgered | 2 | PS "M1 + L-b: an honest verified agent, clock 30 s fast ..."; CT "not-yet-valid-held under the grace" |
| M09 held answer made a no-offer fault (skips step 7) | 3 | PS "L-b: an agent already mazed stays mazed ..." |
| M10 CORE:404 step 8 ignores `ledgerOffer` | 2 | CT "not-yet-valid-held under the grace: the offer, ledger count unchanged" |
| M11 HONO:605 held text removed | 3 | PS "the same early payment x30 ... every answer 402 authorization not yet valid" |
| M12 CORE:383 `ledgerOffer` inverted | 8 | PS "M1 + L-b ..." |
| M13 CF:375 row-5 count ignores the cooldown window (`fails ? fails.n : 0`) | 0 | SURVIVED (N2) |
| M14 CF:319 a successful settle does not clear the count | 2 | PS "row 1: ... served, cached as already-settled, payer cleared" |
| M15 row-5 count +2 per early payment | 7 | PS "row 5 (AC-3.3, R004 M1) ..." |
| M16 CF:247 `nowS <= early` | 4 | PS "after validAfter exactly one settle attempt is allowed ..." |
| M17 CF:370 row 5 matches every 2xx reject | 23 | PS "a failed payment is never relayed twice" |
| M18 CORE:98 settle-throttled out of OPERATOR_FAULTS | 3 | PS "row 3: reason settle-throttled ..." |

## 6. Suite

`git archive HEAD` copy, `pnpm install --frozen-lockfile --offline` (from the local store, no
network), then `pnpm test`: 55 files, 681/681 passed (round 2: 671). Re-run inside the empty network
namespace with loopback up: 681/681. `pnpm lint`: 1 warning, 4 infos, no error. `pnpm typecheck`:
exit 0. Temp copies removed.

## 7. New findings

HIGH: none. MEDIUM: none.

LOW

N1. The per-payer limit is not atomic across concurrent requests (equal to main; not introduced
  here). CF:261-263 checks `payerFails` before the settle call; the count is written after it
  (CF:374-377 and :386-389) from the `fails` snapshot taken before the await, so N requests in
  flight all pass the check and all write `n = old + 1`. Measured: one payer, 100 concurrent fresh
  nonces -> 20 settle calls (the whole bucket) on both trees, early or plain; 30 calls in the first
  minute, then the cooldown holds; a second payer is throttled for 3 of 60 seconds. R004's "at
  most 3 settle calls then cooldown" tests (PS:1354, :1371) are sequential only. Why low: main does
  the same, the ceiling is the bucket, and free key rotation reaches the same ceiling continuously
  (A11b: 315 calls, victim throttled 60/60). Fix if wanted: count in-flight attempts per payer
  synchronously before the await (refuse when failures + in-flight >= 3, release on success or
  operator fault), and read `payerFails.get(payer)` again at write time; add a concurrent test.
N2. Surviving mutant M13: no test pins that a row-5 count from an expired cooldown window is
  dropped (CF:375, `now < fails.untilMs`). Add: one early reject, advance 600,001 ms, two more
  early rejects from the same payer -> the third attempt still reaches settle.
N3. `settle-throttled` and the held `not-yet-valid` 402 carry no Retry-After. A client is told
  "retry the same payment" with no pacing; a verified agent that retries at once is mazed on the
  4th try. Suggested: `Retry-After: 1` on settle-throttled, and seconds-until-validAfter on the
  held answer. Informational.
N4. Held repeats stretch the offer grace (L-b's price). A verified unfunded agent sending one held
  early payment per 60 s from throwaway payer keys got 402 for 121 requests at 1 request/s before
  the first 302 (main: 3), for 5 settle calls in 280 s. No content, no ledgered gain beyond the
  delay; it is mazed once three first-attempts are recorded. Accept and record, or cap held repeats
  per agent key.
N5. Recorded costs, re-measured (README "Known costs", closeout): an honest FUNDED payer whose
  clock is 30 s fast and who sends three payments at once is cooled down and none is served within
  their validity (A16; with two payments both are served, A16b; main serves none in either case).
  An honest funded payer when the facilitator's clock is 3 s behind ours and who retries once per
  second gets 3 x not-yet-valid, then payer-cooldown for 600 s (A17; 9c5c489 served it after 3 s at
  the price of the drain; main never serves it). No money is taken in either case. Optional
  softening: when a hold comes due, let that payment's one attempt through even if the payer is
  cooling down (it was already counted once); each nonce then costs at most 2 calls.
N6. Pre-existing, seen in Z1: the cooldown map is capped at 512, oldest out, so 512 other payers'
  failures evict a payer's cooldown ("eviction is amnesty"). It needs a larger flood than the one
  it re-enables. No change asked.

## Could not determine

- The live facilitator's exact reason string and clock source for not-yet-valid (decides how often
  N5's second case happens).
- Behaviour on the real Pages runtime: the budget is per isolate, so several isolates multiply it;
  no workerd run was made.
- A hung settle route (no timeout; runtime-dependent), and whether a locally valid payload can make
  the facilitator answer 5xx.
- CI status, `bun examples/bun-hono/check.ts` and the bench check were not run or checked.

## Disclosure: what left the machine

Nothing. No push, no PR comment, no deploy, no payment, no wallet, no credential read, no host
access. `pnpm install` ran with `--offline`. All probes, all 18 mutants and one full suite run ran
inside an empty network namespace; the probe's settle URL was `https://settle.invalid/...` and was
only ever passed to an in-process stub; the probe's global fetch counter read 0. The first full
suite run (681/681) and the lint/typecheck runs were outside the namespace; the repo's tests use
in-process stubs and one loopback socket, and I saw no outbound call, but that single run was not
network-isolated. The token used in probes was a made-up string, not a secret.
