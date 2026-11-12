# fareseal-pay-lows-1 - independent second review 2 (GATE R)

Commit 9c5c4898d774e041f5a72cfa904b6efa9c954d3a, branch crew/fareseal-pay-lows-1, base origin/main 514bb79.
Reviewed 2026-11-11. Read-only: worktree clean and still at 9c5c489 afterwards. All builds, probes and mutants ran in
temp copies of HEAD, origin/main and 36c4f87 under /home/o2k/.crew/coord/review-tmp (fspay2, fspay2-main, fspay2-36),
removed afterwards. No network beyond `pnpm install --frozen-lockfile`; settle was always an in-process stub.

## Verdict

FAIL for 9c5c489. No HIGH. One MEDIUM (M1), by the severity rule given for this review ("client-drivable drain of
settle calls or facilitator quota that is worse than main"). Everything else is LOW. No free content, no replay, no
memory exhaustion, no wrong README row found. 671/671 tests pass; all 30 mutants are killed.

Why FAIL and not PASS, in one line: R001 asked for "fresh nonces from one payer are still bounded by the cooldown" and
"the maze-dodge sequence from the report ends in a 302 as on main". Neither holds. The run's own test pins the opposite
("fresh early nonces from one payer: not counted toward the cooldown, bounded by the settle bucket",
pages-settle.test.ts:1233) and its L6 test only covers a drain made of ONE repeated payment (:1279).
Mitigating fact for the coordinator: the ceiling is the per-isolate bucket (20 burst + 5/s), which main also reaches
with rotated payer keys (keys are free). So the absolute worst case is unchanged; what changed is that one key and no
rotation now reaches it (3 calls on main).

## A. Closure of L1-L9 (file:line at 9c5c489)

| # | State | Fix | Test |
|---|---|---|---|
| L1 | closed (404/405); 400 bad price recorded, not fixed | cloudflare/src/index.ts:352-356 (404, 405 in row 4); README "Known costs"; closeout R002 | pages-settle.test.ts:889 "row 4: HTTP 404/405 ..." |
| L2 | HALF closed | index.ts:215 (map), :242-248 (local hold), :366-371 (record). Same payment: fixed. Fresh nonces from one payer: NOT bounded by the cooldown (M1) | :1170, :1193, :1216, :1233 (pins the unfixed half), :1254 |
| L3 | closed | core/src/pipeline.ts:124-130 isNoOfferFault, :368; closeout "Known cost (L3)" | core pipeline-payment.test.ts:151, :163; hono payment-errors.test.ts:224 |
| L4 | decided, not changed: not-yet-valid still records an offer (comment index.ts:361-365, README row 5 "yes") | - | :1279 expects 402,402,402,302,302. Honest fast-clock agent is still mazed on the 4th early retry (L-b) |
| L5 | closed | index.ts:343-348 uses core isOperatorFault; no reason regex left in cloudflare | :858 "row 3: reason settle-throttled/..." |
| L6 | NOT closed in general | only the one-repeated-payment drain is closed (by the L2 hold) | :1279 covers that variant only; see L-a |
| L7 | closed | index.ts:334-335 `settle-unconfirmed`; hono/src/index.ts:611-614 text | :868 "row 3a ...", :613; hono :87 |
| L8 | closed, all four | - | core :179 "patterns are anchored"; pages-settle :972 near-miss reasons; :980 "junk0x.." rows; x402.test.ts:195 zero atob/JSON.parse |
| L9 | recorded, not built (closeout "Recorded, not built") | - | - |
| README gaps | closed: rows 3a, 6b, 3xx in row 7, "Offer recorded" column, no-timeout note | README.md:73-99 | :1018 "README table: every row id has a scenario ..." |

Not recorded: closeout.md has no R001 section. The L2/L4/L6 decisions (bucket, not cooldown, bounds fresh early nonces;
offer still recorded) live only in a code comment and test names.

## B. The not-yet-valid memory

Where: `notYetValid` Map<string,bigint> inside makeSettlingVerify (index.ts:215): per isolate, per state build.
Key: `${payer}:${normalised nonce}` (same key as the nonce cache), so respelled or re-encoded copies share the entry
(measured). Value: BigInt(validAfter) from the signed authorization. Bound: `remember` cap 512, oldest out (:369).
It is its own map: it cannot evict the nonce cache or the payer cooldown.

- Fill/evict: an entry is only written after a settle call that answered valid_after, so writes are bucket-limited.
  Measured: 100 rps of fresh early payments for 54 s wrote 289 entries (< 512), the first entry was still held.
  With the default 60 s tolerance the cap cannot be reached inside one hold window (20 + 5*60 = 320). If evicted, the
  cost is one extra settle call for that payment. 700 early junk payments (one payer or many) did not evict a settled
  nonce: replay stayed `already-settled`, 0 calls. (On main the same flood with plain unfunded payments from many
  payers DOES evict the nonce cache: pre-existing, "eviction is amnesty".) Memory: 512 short strings. No exhaustion.
- Client-chosen value: bounded by the local check to validAfter <= now + skew (60 s default). Measured: now+60 held
  until +60 then one settle; now+61 refused locally, 0 calls; JSON number, hex string, padded, leading zeros: same as
  the string; "" and `true` (0n/1n): never held; 2^64: refused locally; "-1", "1e3", 1.5, null, {}, 9x80, 2^256
  cannot be signed/verified (refused before settle). BigInt on both sides, same clock source as verifyProof
  (opts.nowS, else Date.now). No overflow, no pin beyond the tolerance. A larger operator `skew_tolerance` lengthens
  the hold equally.
- After validAfter: the entry is deleted and one attempt goes on (inflight/cooldown/bucket still apply). If the
  facilitator still says valid_after (its clock behind ours) the entry is re-recorded with a past time, so it is not
  held and every retry settles, bucket-bounded (documented "ponytail", index.ts:367-368; counts below).
- Oracle: the held answer is the same reason and text as the first answer and as the local early reject; it needs the
  signed payment itself. Nothing learnable about other payers.
- Order: nonce cache -> hold -> inflight -> cooldown -> bucket. A payer in cooldown with a held entry is told
  not-yet-valid until validAfter, then payer-cooldown; no settle call (measured).
- Replay (funded payer, validAfter = now+30): sequential not-yet-valid(1 call), held(1), at +30 OK(2), then
  already-settled x3 (2 calls). Concurrent: 4 early copies share 1 call; 4 held copies 0 calls; at +30 five copies
  incl. re-encoded, respelled nonce and respelled validAfter -> exactly one OK, four already-settled, 1 call; three
  more -> already-settled, 0 calls. Served exactly once.

### Settle calls, measured (main / 36c4f87 / 9c5c489)

Unfunded payer; facilitator stub says valid_after while early, then insufficient_funds. "burst" = frozen clock,
"10 rps" = 100 ms per request.

| Scenario | N | main | 36c4f87 | 9c5c489 |
|---|---|---|---|---|
| same payment dated +55 s, burst | 30 / 100 / 300 | 1 / 1 / 1 | 20 / 20 / 20 | 1 / 1 / 1 |
| same payment dated +55 s, 10 rps | 30 / 100 / 300 | 1 / 1 / 1 | 30 / 69 / 169 | 1 / 1 / 1 |
| fresh nonces, ONE payer, +55 s, burst | 30 / 100 / 300 | 3 / 3 / 3 | 20 / 20 / 20 | 20 / 20 / 20 |
| fresh nonces, ONE payer, +55 s, 10 rps | 30 / 100 / 300 | 3 / 3 / 3 | 30 / 69 / 169 | 30 / 69 / 169 |
| fresh nonces, ONE payer, +60 s, 10 rps for 60 s | 600 | 3 | 319 | 319 |
| many payers (new key each), +55 s, burst | 30 / 100 / 300 | 20 / 20 / 20 | 20 / 20 / 20 | 20 / 20 / 20 |
| many payers, +55 s, 10 rps | 30 / 100 / 300 | 30 / 69 / 169 | 30 / 69 / 169 | 30 / 69 / 169 |
| baseline: plain unfunded, one payer, fresh nonces | 30 / 100 / 300 | 3 | 3 | 3 |
| baseline: plain unfunded, many payers, 10 rps | 30 / 100 / 300 | 30 / 69 / 169 | same | same |
| same payment +55 s, 10 rps through expiry | 1000 | 1 | 295 | 2 |
| same, facilitator ALWAYS says valid_after | 1000 | 1 | 519 | 245 (1 before validAfter, bucket rate after) |
| same payment +5 s, facilitator clock 3 s behind | 300 | 1 | 60 | 32 |
| validAfter = now, facilitator clock 3 s behind | 300 | 1 | 31 | 31 |

### L6 sequence re-run (verified agent, offer_grace 3, maze on, frozen clock; agent sends 8 requests each with a
fresh unfunded payment)

| Drain before the agent (30 anonymous requests) | main | 36c4f87 | 9c5c489 |
|---|---|---|---|
| none | 402,402,402,302.. | same | same |
| ONE early payment repeated (the variant the run tested) | 402x3,302.. | 402 x8 | 402x3,302.. (closed) |
| fresh early nonces from one payer (the report's sequence) | 402x3,302.. (drain = 3 calls) | 402 x8 | 402 x8, never 302 (drain = 20 calls) |
| plain unfunded payments from rotating payers | 402x3,302.. | 402 x8 | 402 x8, never 302 |

The last row shows L6 does not depend on early dating at all: any bucket drain plus F6 (`settle-throttled` records no
offer) gives it. In real time the drain must keep above 5 requests/s.

### Honest agent, clock 30 s fast (funded, verified agent, same payment retried)

| Retry times (s) | main | 9c5c489 |
|---|---|---|
| 0,5,10,15,20,25,30,31 | 402,402,402,302,302,302,302,302 (never served, 1 call) | 402,402,402,302,302,302,200,402 (served at +30; mazed for tries 4-6; 2 calls) |
| 0,15,30,31 | 402,402,402,302 | 402,402,200,402(nonce used) |
| 0,30 | 402,402 | 402,200 |

Served once the time passes: yes, even after having been mazed. "Must not be mazed": not met for an agent that retries
more than 3 times before validAfter (same as main; main never serves). Stated decision (index.ts:361-365).

## C. Classification table, reconstructed from the code and measured (144 settle answers through
makeSettlingVerify and through the hono pipeline with a verified agent)

Serve condition: `resp.ok && data.settled === true` and a trimmed `transaction` (first) or `tx` matching
`^0x[0-9a-fA-F]{64}$`. OPF = "settlement unavailable (operator fault); retry the same payment".

| Row | Settle answer | Served | Cached | Counted | Offer | 402 error | README | Test |
|---|---|---|---|---|---|---|---|---|
| local | X-PAYMENT > 8192 chars, no settle call | no | - | no | yes | malformed X-PAYMENT header | adapter README | yes |
| 0a | no settle token | no | no | no | no | OPF | agrees | yes |
| 0b | bucket empty | no | no | no | no | OPF | agrees | yes |
| 0c | throw; 2xx non-JSON; 204 empty | no | no | no | no | OPF | agrees | yes |
| 1 | 2xx (200, 201) settled:true + valid id (retryable:true ignored) | YES | yes | cleared | n/a | - | agrees | yes |
| 2 | 2xx settled:true, no valid id | no | yes | no | no | settle failed: no transaction id | agrees | yes |
| 3a | any non-2xx (301..503 measured) with settled:true, beats retryable:true and rows 3/4 | no | no | no | no | settlement status unconfirmed; do not pay again, contact the operator | agrees | yes |
| 3 | retryable === true; reason network-mismatch; isOperatorFault(reason) | no | no | no | no | OPF | agrees | yes |
| 4 | HTTP 5xx, 401, 403, 404, 405, 429, any body (a valid_after reason too) | no | no | no | no | OPF | agrees | yes |
| 5 | reason contains valid_after (2xx, 3xx, other 4xx) | no | no (held locally until validAfter) | no | yes | authorization not yet valid | agrees; hold not mentioned (L-d) | yes |
| 6 | 2xx settled:false, other reason; near-miss operator strings ("x settle-failed(500)", "settle-failed(500) x", trailing newline, "settle-failed(5000)", "x verify-error: y"); retryable:"true" | no | yes | yes | yes | facilitator rejected: <reason> / settle failed / payment rejected | agrees | yes |
| 6b | 2xx {} / null / [] / data:null / data:"x" / settled:"true" / settled:1 | no | yes | yes | yes | settle failed | agrees | yes ({}, null, []) |
| 7 | 301, 302, 400, 402, 408, 409, 413, 422, any body without settled:true | no | yes | yes | yes | settle failed (or facilitator rejected: <reason>) | agrees | yes |
| - | timeout | none exists; request hangs until the runtime ends it | stated | - |

Disagreements: none that matter. One corner outside the table: a 200 settled:false whose reason is literally
`settle-unconfirmed` or `no-transaction-id` is cached and counted (row 6) but records no offer (core). The data-api
route cannot emit those.

Single classifier (L5): yes. cloudflare row 3 calls core `isOperatorFault` (plus `retryable` and `network-mismatch`);
hono `paymentError` calls the same function; core `decide` uses `isNoOfferFault` = isOperatorFault + the two
maybe-paid reasons. No reason regex is left in cloudflare.

404/405 (L1): a client cannot cause them. The settle URL and method are fixed by config; the client-controlled parts
(payment, resource) travel in the body. In tunnelmind-data-api (9d38ee3, api/worker.js:917,
api/routes/fareseal-settle.js) routing is on path and method only, and the body's `resource` is ignored.

Non-2xx settled:true (L7): own text, not cached, not counted, no offer, never served. A client cannot produce it (the
route never answers non-2xx with settled:true). Each retry is one bucket-limited settle call. No free content, no
client-drivable free retries.

## D. Serve condition, transaction id, cap

- Not served: junk before ("zz0x.."), junk after, inner newline, two ids on two lines, "junk\n<id>", "<id>\njunk",
  zero-width space before, 0X prefix, 63/65 hex, no 0x, "", " ", array, number, object.
- Served, id trimmed in the result: newline/CRLF/tab around a valid id, NBSP or BOM before it (String.trim strips
  them), upper-case hex.
- Both present: valid `transaction` wins over a valid or junk `tx`; junk `transaction` (even "zz"+valid) falls to a
  valid `tx`.
- Cap before decode: 8193, 8196, 20000 chars -> malformed with 0 atob and 0 JSON.parse calls; 8188 and 8192 -> 1 call
  each; 8193 x "!" with an atob that throws -> malformed, atob not called. (An 8192-char header plus trailing spaces
  is not oversize: the Headers API strips them before the check.)

## Findings

### HIGH
None.

### MEDIUM

M1. Fresh early-dated nonces from ONE unfunded payer are bounded only by the settle bucket, not by the payer cooldown.
  packages/cloudflare/src/index.ts:366-371 (row 5 writes the hold, never `payerFails`); pinned by
  pages-settle.test.ts:1233.
  Steps: sign payments with one key, each a new nonce, validAfter = now+55, no funds; send them. Every one passes the
  local check, reaches settle, is answered valid_after, and is not counted.
  Measured: 20 calls in a 30-request burst, 169 in 300 requests at 10 rps, 319 in 60 s (main: 3, then cooldown).
  Who loses: facilitator verify quota at the bucket rate; while the bucket is empty every honest payer gets
  `settle-throttled`. Who gains: nothing is served.
  Scale: equal to what main already allows with rotated keys (169 = 169 measured), so the ceiling is unchanged; the
  per-payer bound that main has is gone for this class. This is the unfixed half of L2 and R001's stated test.
  Smallest fix: count a row-5 reject toward `payerFails` once per nonce while leaving the nonce uncached (the hold
  already stops the same payment being counted twice; a successful settle clears the count at :317). Then one payer
  gets 3 early payments, as on main, and the same payment still succeeds later. Update AC-3.3, the README "Counted"
  cell for row 5 and the test at :1233. Alternative: refuse locally a 4th live held entry for one payer.

### LOW

L-a. L6 is not closed: a verified agent still avoids the maze while the settle bucket is drained.
  core/src/pipeline.ts:368 with `settle-throttled` in the no-offer set (:96-102); test :1279 covers only one repeated
  payment. Measured 402 x8, never 302, with a drain of fresh early nonces (one payer) or of plain unfunded payments
  from rotating payers; main gives 302 from the 4th in both. Gain: no maze, no ledgered offer, no content. Cost to
  us: the drain's own settle calls (20 + 5/s). M1's fix removes the one-key drain; the rotating-payer drain remains
  and needs a decision: drop `settle-throttled` from the no-offer set (an honest agent throttled 4 times is then
  mazed), or accept and record it.
L-b. An honest verified agent whose clock runs ahead is mazed on the 4th retry before validAfter (302 at tries 4-6
  above), then served when it presents the payment after validAfter. Same as main up to the serve (main never serves
  it). Stated in the code comment and README row 5, not in the closeout. If unwanted without reopening L6: give the
  locally HELD answer its own no-offer reason (same 402 text), so only the first attempt of each early payment
  records an offer; fresh early payments still record one each.
L-c. A facilitator clock behind ours: after validAfter each retry of the same payment settles until the facilitator
  agrees (32 calls for 3 s of lag at 10 rps; 245 in 100 s if it never agrees; main: 1). Bucket-bounded, needs real
  clock lag, documented at index.ts:367-368. Smallest fix if wanted: on a repeat valid_after for an already-due
  entry, hold it for a second or two.
L-d. README row 5 says "Cached: no" and does not say the reject is answered locally until validAfter
  (packages/cloudflare/README.md:83). CHANGELOG has no line for the hold either. One sentence each.
L-e. closeout.md has no R001 section (the L2/L4/L6 decisions and the known costs above are unrecorded).
L-f. `settle-unconfirmed` is not cached, so a retry of that payment reaches the settle route again; with the real
  route the nonce is then spent and the retry becomes a cached, counted payer fault. The text says "do not pay
  again", which covers it. Same class as LOW-4 (F8). Unreachable with data-api 9d38ee3.
L-g. Carried, recorded by the run: bad `price_usd` -> 400 charged to the payer; no settle timeout; cold-start nonce
  cache (L9); `no-transaction-id` payer not served.

## E. Mutants (each alone in the copy, full suite, restored after; all killed)

| Mutant | Failed | First failing test |
|---|---|---|
| core isOperatorFault regex without ^ | 2 | core "isOperatorFault: the reason patterns are anchored"; pages-settle row 6 "x settle-failed(500)" |
| same without $ | 2 | same; row 6 "settle-failed(500)x" |
| core verify-error:/settle-error: un-anchored | 2 | same; row 6 "x verify-error: boom" |
| cloudflare reason regex un-anchored | n/a | the regex no longer exists; see the "own classifier restored" row |
| tx-id regex without leading ^ | 5 | row 2: tx "junk0x.." / "zz0x.." not served |
| tx-id regex without $ | 5 | settled:true with 65 hex is 402 |
| size cap moved after decode | 1 | x402.test "an oversize header is refused with zero atob / JSON.parse calls" |
| not-yet-valid memory removed | 4 | R001 "the same early payment x30 - at most 1 settle call" |
| expiry check inverted | 8 | row 5 (AC-3.1/3.2) "retried later serves" |
| expiry boundary `<=` | 3 | R001 "after validAfter exactly one settle attempt is allowed" |
| bound removed (plain set) | 1 | R001 "the remembered map is capped like the nonce cache" |
| hold never expires | 2 | R001 "after validAfter exactly one settle attempt ..." |
| entry not deleted at expiry | 1 | R001 "the remembered map is capped ..." |
| hold checked after the bucket | 2 | R001 "the same early payment x30" (bucket token spent) |
| hold ignores opts.nowS | 1 | R001 "the remembered map is capped ..." |
| hold keyed by payer only | 3 | R001 "the same early payment x30"; "fresh early nonces ..." |
| row 5 counted toward the cooldown | 4 | row 5 (AC-3.3); README table; R001 "fresh early nonces ..." (this is the test M1's fix must change) |
| no-transaction-id back in the offer set | 4 | core "no-transaction-id: four attempts are four offers"; README table |
| settle-unconfirmed back in the offer set | 4 | core "settle-unconfirmed: four attempts are four offers" |
| 404 and 405 removed from operator fault | 4 | "row 4: HTTP 404 ..." / "HTTP 405 ..." |
| only 405 removed | 2 | "row 4: HTTP 405 ..." |
| non-2xx settled:true case removed | 8 | F4 "HTTP 500 + settled:true: 402 settle unconfirmed"; row 3a x7 |
| hono text for settle-unconfirmed removed | 9 | same |
| cloudflare own classifier restored | 4 | "row 3: reason settle-throttled / settle-unreachable / settle-retryable / settlement-unconfigured" |
| F1 revert (`!resp.ok ||`) | 11 | "row 7: HTTP 400 {ok:false,error} - settle-failed, cached, counted" |
| F1 revert in core (5xx only) | 11 | "row 3: HTTP 200 reason verify-failed(401)" |
| F2 revert (cap removed) | 3 | x402 "a validly signed payment over 8192 chars is malformed" |
| F3 revert (valid_after branch off) | 8 | row 5 (AC-3.1/3.2) |
| F4 revert (no resp.ok) | 10 | F4 "HTTP 500 + settled:true" |
| F5 revert (any non-empty string) | 15 | settled:true with the old placeholder tx is 402 |
| F6 revert (no early return) | 12 | core "settle-retryable: four attempts are four offers, nothing ledgered" |

## F. Regression and compatibility

- Suite: HEAD 55 files, 671/671 passed (main 554/554). `pnpm lint`: 1 warning, 4 infos, no error. `pnpm typecheck`
  exit 0.
- Unpaid 402: status, all headers and body byte-identical to main for three requests (same probe on both trees).
- Public API, additions only: core `isOperatorFault`, `isNoOfferFault`; adapter-x402 `MAX_X_PAYMENT_CHARS`; optional
  `reason` on the VerifyPayment result; new reason `settle-unconfirmed` and its 402 text. Nothing removed or renamed.
- Vendoring site: refresh core, hono, cloudflare and adapter-x402 together (hono and cloudflare import the new core
  exports). No site code change. Site tests stubbing a placeholder tx id fail until they use a 0x + 64-hex id; 402
  `error` strings changed for the moved rows (CHANGELOG).
- Stripe: only the version field of packages/adapter-stripe/package.json. Lockfile and workflows not in the diff.
  All seven packages 2.3.0, CHANGELOG "2.3.0 - Unreleased". No tag on HEAD. Nothing published.

## What I ran

- `git rev-parse HEAD`, `git diff 36c4f87..HEAD`, `git diff origin/main..HEAD`; the brief, tasks.md R001-R003, the
  36c4f87 review, closeout.
- Three temp copies: `pnpm install --frozen-lockfile`, `pnpm build`; `pnpm test`, `pnpm lint`, `pnpm typecheck` on HEAD;
  `pnpm test` on main.
- One probe test file run on all three trees: settle-call counts, eviction, validAfter shapes, honest agent, L6,
  replay, 144 classification answers, cap/decode spy, unpaid 402.
- 30 mutants, full suite each.
- Read (only) tunnelmind-data-api 9d38ee3 api/routes/fareseal-settle.js and the route line in api/worker.js.

## Could not determine

- The live facilitator's exact not-yet-valid reason string and whether its clock or the chain's block time is used
  (decides how often L-c happens).
- Whether a locally valid payload can make the facilitator answer 5xx (bucket-bounded free retries if so).
- Behaviour on a hung settle route (no timeout; runtime-dependent).
- `bun examples/bun-hono/check.ts`, the bench check and CI status were not run or checked.
