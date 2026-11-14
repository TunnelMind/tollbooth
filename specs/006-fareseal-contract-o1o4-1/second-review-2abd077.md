VERDICT: FAIL for 2abd0777b16253e943c9f2aacb9a784dba619e1a

Second review of TunnelMind/tollbooth draft PR #17, branch crew/fareseal-contract-o1o4-1
(Fareseal payment contract O1-O4). Reviewed 2026-11-13. Head is the expected 2abd077.
Base origin/main 6825c3088634b28aedd3012071c929f1c28fa910; the branch is 0 behind, 13 ahead;
`git merge-tree --write-tree origin/main HEAD` is clean (tree 37992ccf).

One finding is HIGH by the brief's own rule (a status code changes outside the before/after
table) and one is MEDIUM (a reservation that is never released locks a payer out). Money
safety (the acceptance bar) held on every warmed schedule: 0 violations in 4,200 schedules.
Everything else in the table A1-A8 and T1 is as specified.

Short names: CF = packages/cloudflare/src/index.ts, PIPE = packages/core/src/pipeline.ts,
LEDGER = packages/core/src/ledger.ts, HONO = packages/hono/src/index.ts. Lines are at the head.


1. FINDINGS

HIGH

H1. A held repeat moves the start of the agent's offer window, so a verified agent that main
    sends to the maze (302) gets a 402 on the head. Not a row of the table.
    Where: LEDGER:70-75 (`recordHeld` calls `roll`), LEDGER:49-55, PIPE:394-400.
    Cause: R-O3 as written ("roll the window exactly as recordOffer does"). On main a held
    repeat never touched the ledger; on the head it restarts an expired window at the time of
    the held repeat, so the offers that follow are counted in a window that began earlier
    and therefore ends earlier.
    Ran it (default config, window 10m, offer_grace 3, through the Pages handler, one verified
    Web Bot Auth agent A, signatures made fresh per request):
      t=0     A, no payment                         402 / 402   (window opens)
      t=601   anonymous client, early payment x     402 / 402   (x is now held)
      t=602   A repeats held x                      402 / 402   (head: window restarts at 602)
      t=650   A, no payment, three times            402 / 402   (main: window restarts at 650)
      t=1203  A, no payment                         main 302, head 402
    Same result with window = "30s" (probe o3.windowStartShift: main 302, head 402).
    It needs a held repeat from a key whose window has expired, so the payment was first seen
    under another identity (anonymous, another key, or the same agent before its signature
    verified), or the ledger entry was evicted. The shift is at most the life of a hold (360 s)
    and always in the agent's favour. I rate it HIGH only because the brief says a status code
    that changes outside the table is HIGH; on its own weight it is small.
    Fix (either): (a) do not roll the offer window in `recordHeld`: keep a separate
    `heldWindowStart`, or reset only `heldInWindow` when the window has expired and leave
    `windowStart` and `offersInWindow` to `recordOffer`; add the scenario above as a test; or
    (b) add the row to the table and the CHANGELOG and have the owner accept it.

MEDIUM

M1. A per-payer reservation has no time limit. If a settle call never comes back, the
    reservation stays for the life of the isolate; three of them lock that payer out of
    settlement for good, with the text "payer cooling down after repeated failures".
    Where: CF:314 (reserve), CF:462-468 (release only in the `finally` after `await p`).
    Ran it (probe o1.hung, mock clock): 3 settles from one payer that never answer, then a
    fresh funded payment from that payer at +0 s, +600 s, +1 h, +24 h: head 402 payer-cooldown
    every time, no settle call; main 200 with receipt every time. Another payer is served on
    both (no lock-out of others). With one hung settle the payer keeps 2 slots (o1.oneHung).
    The leak is cumulative: each lost settle costs the payer one of its three slots until the
    isolate is recycled.
    How it happens in production (reasoned, not run: no workerd here): the Workers runtime
    cancels a request's pending work when the client disconnects, unless it is under
    waitUntil. The settle `await` is not (CF:709, hono verify). A cancelled request never
    resumes, so the `finally` never runs. An agent whose HTTP client times out before a slow
    settle answers does exactly this. In Node an aborted request signal changes nothing
    (probe o1.clientAbort: released), so the suite cannot see it.
    The spec's edge case says the reservation is "released when the runtime ends the request".
    Nothing in the code does that; README:101-103 says only that a hung settle holds the
    request. On main the same event leaks one `inflight` entry (that one payment can no longer
    be retried on that isolate), which is old; the payer-wide lock-out is new.
    Fix: give a reservation an age limit (store the start time per settle and ignore entries
    older than, say, 120 s when counting), or put a timeout on the settle fetch
    (AbortSignal.timeout) so the `finally` always runs, or run the settle under
    `context.waitUntil` so it finishes after a disconnect (that also closes the old case where
    a payment settles but is never recorded as seen). Add a test with a settle that never
    answers and a clock advanced past the limit. State the remaining bound in the README.

LOW

L1. Row A7 lets a cooled-down payer keep calling settle for as long as the facilitator is
    faulty. CF:459-460. Probe o4.dueOperatorFault: cooled payer, one due hold, settle answers
    503: 105 settle calls in 100 requests over 25 s (bucket rate), main 0. This is the table's
    row A7 as written, and an uncooled payer can do the same on main (probe outage.uncooled:
    100 calls in 100 requests on both), so no budget is lost that main protected from a fresh
    key. But it is outside "6 per payer per window" and the README does not say so.
    Fix: say it in README "Known costs" (operator-fault answers are not payer-attributable and
    are bounded only by the settle bucket), or cap put-backs per hold (for example 3).
L2. spec.md still says "at most 2 ... per nonce" without the 3-call case in two places:
    spec.md:51 (R-O4 Bound) and spec.md:90 (US4). Confirmed. README:115-126, CHANGELOG and
    closeout section 7 state both bounds correctly. Fix: correct the two spec lines.
L3. closeout.md:3 says HEAD `2d680f1`; the head is 2abd077 (the closeout commit). The same
    slip as L5 of the last review, which this run fixed for spec 005.
L4. Mutant M41 survives: a due attempt that does not reserve (CF:314 made conditional on
    `!due`). R-O4 says the due attempt raises the in-flight count. Real test gap. Test: a payer
    with 3 holds, the first due attempt succeeds (failures cleared), the other two are held in
    flight, then 3 fresh payments: 1 starts, 2 are payer-cooldown.
L5. Mutant M26 survives: the hold is also put back after `settle-unconfirmed`. The rule
    (CF:455-458) says it is not. Real test gap. Test: cooled payer, due attempt answered
    502 + settled:true, the retry is payer-cooldown with no call (probe o4.dueOperatorFault
    shows the head does this; nothing pins it).
L6. Old, not from this change, same on main: the single-flight and the damping do not hold
    for requests that arrive while the first request is still building the state
    (CF:704-707: every concurrent first request builds its own state and its own maps).
    Probe on a cold handler, main and head alike: 100 fresh payments from one payer at once
    = 100 settle calls (not 3, not 20); 5 copies of one funded payment at once = 5 settle
    calls and, with a stub that confirms each, 5 x 200. A real chain refuses the reused
    nonce, as it must across isolates anyway. US1 and US5 say "warmed"; my fuzz was run warm.
    Fix (own run): build the state once (`statePromise ??= buildState(...)`).
L7. Row A1 cost, as accepted in OQ3 and stated in the README: an honest payer's 4th concurrent
    payment gets the "after repeated failures" text and an offer is recorded. No finding
    beyond what the owner accepted; listed so it is not lost.

Not findings: `OfferState.heldInWindow` is a required field on an exported interface (T1 says
so). The closeout's "18 files, 2944 insertions" was taken before the closeout commit (19 files,
3185 now).


2. PROBE TABLES

All through `createPagesMiddleware` with the handler warmed by one request, `fetch` set to a
recording settle stub, `Date.now` mocked. Same probe files run on a `git archive` copy of main
6825c30 and of the head. Payers are real secp256k1 keys signing real EIP-3009 authorizations.

2.1 Money safety (item 1)

Fuzz: 4,200 randomised schedules per side (seeds 0-4199), 2-6 payers, 1-4 payment slots each
(funded, unfunded, early funded, early unfunded, expired; re-minted after expiry), 30-80
steps of send (1-5 concurrent copies, respelled nonce/from in 30%), release one pending
answer, or advance the clock (50 ms to 601 s, including 599.999 s, 600 s, 601 s, 59 s, 61 s,
299 s). Stub answers: normal (decided by a model chain with a clock lag of 0-90 s), 503, 500
HTML, throw, reject after delay, 2xx non-JSON, hang, 429, 400, 404, settled without tx id,
502 with settled:true, retryable. 30% of schedules have a verified Web Bot Auth agent.
Asserted on every schedule: (a) a 200 only after a delivered 2xx settled:true with a valid
tx id for that payment, with the matching x-payment-response, and at most one 200 per
payment; (b) no settle call for a payment the chain has settled, and never two calls in
flight for one payment; (c) every delivered settlement has exactly one 200 with the receipt;
(d) no settle call after a settled answer; plus no settle call for a locally expired
payment, and every request answered unless parked behind a hung call.

| side | schedules | requests | settle calls | 200 served | 302 | violations | failing seeds |
|---|---|---|---|---|---|---|---|
| head | 4,200 | 223,843 | 54,540 | 11,631 | 2,806 | 0 | none |
| main | 4,200 | 223,886 | 55,212 | 11,674 | 2,868 | 0 | none |

By design and equal on both: a retry after a non-2xx settled:true (`settle-unconfirmed`, not
cached) calls settle again (686 head, 694 main). Cold start is L6 (seeds 1, 5, 7 fail on both
sides when the handler is not warmed).
Targeted: 20 copies of a due payment = 1 call, 1 x 200, 19 x "nonce already used"; a due
attempt racing its copies and two fresh payments = 3 calls for 3 holds, 3 served, 3 copies
refused, 2 fresh payer-cooldown.

2.2 O1 (item 2)

| probe | main | head |
|---|---|---|
| 100 concurrent fresh payments, settle never answers | 20 calls; 80 x settle-throttled | 3 calls; 97 x payer-cooldown |
| honest payer, 3 in flight, a 4th | 4th settles (4 calls) | 4th: 402 payer-cooldown, no call, bytes equal to the sequential cooldown 402; the 3 are served; a 5th is served; the refused 4th sent again is served (not cached) |
| 2 live failures + 1 in flight, one more | settles | payer-cooldown; after the in-flight one succeeds the payer is clear |
| after one settle on each path, 4 fresh at once start | 4 | 3 (success, 503, 500 HTML, 429, retryable, reject after delay, thrown, 2xx non-JSON, no tx id, unconfirmed); 2 after a counted failure (unfunded, 400, not-yet-valid); 3 again on the next round in every case |
| after 3 concurrent on 503 / reject / non-JSON / unconfirmed, 4 fresh start | 4 | 3 |
| request signal aborted during the settle (Node) | n/a | released, 3 start |
| 3 hung settles, fresh payment at +0 / +600 s / +1 h / +24 h | served | payer-cooldown every time (M1); other payer served |

Direct `_sizes()` after 100,000 requests: inflight 0, payerInflight 0 (2.6).

2.3 O4 (item 3)

| probe | main | head |
|---|---|---|
| US4: funded payer 55 s fast, 3 early at once, each repeated when due | 3 calls, 0 served, 3 x payer-cooldown | 6 calls, 3 served |
| cooled payer, one hold due, facilitator lagging, 4 tries | 0 calls, cooldown | 1 call (not-yet-valid), then 3 x payer-cooldown, no call |
| lone early nonce, lagging facilitator, 11 tries | 3 calls, then cooldown | 3 calls, then cooldown (same sequence) |
| 15 throwaway payers, one early nonce each, lagging | 45 calls (3 per nonce) | 45 calls (3 per nonce) |
| one payer streaming early nonces 1,900 s, facilitator always "not yet valid" | 12 calls, max 3 in any 600 s | 13 calls, max 4 in any 600 s |
| same, due passes kept to the last second of validity, 2,500 s | 15 calls, max 3 in any 600 s | 18 calls, max 6 in any 600 s |
| due attempt, bucket empty (A6) | payer-cooldown | settle-throttled (bytes equal to the plain throttled 402), 0 calls, again throttled, after refill served with 1 call |
| due attempt, 503 / reject / non-JSON / 429 / retryable (A7) | payer-cooldown, 0 calls | operator-fault 402 each time, hold kept, 1 call each; then OK = served |
| the same during a long outage, 100 tries | 0 calls | 100 calls (L1) |
| due attempt answered 502 + settled:true, then retry | cooldown | settle-unconfirmed, then payer-cooldown, no call (hold not put back) |

Why 6 is the ceiling (reasoned): a hold needs a counted first attempt, a payment lives at
most 360 s (MAX_TIMEOUT 300 + skew 60), a failed due attempt counts and restarts the 600 s
cooldown, so two batches of first attempts are at least 600 s apart and each brings at most
3 due attempts. No scenario exceeded 6 payer-attributable calls per payer per 600 s. The
only excess over main beyond the ruled bound is L1 (operator-fault answers).

"Wider than when due" (item 8): CF:419 skips the hold whenever validAfter <= now by our
clock, also on a first attempt. Confirmed. A caller cannot observe it: probes
o4.pastValidAfter (cooled and not cooled, validAfter 5 s past and exactly now) and
o4.slowSettleCrossesValidAfter give identical statuses, texts and call counts on main and
head. On main such an entry was deleted by the next request before the cooldown check, so it
never gave a pass. The only difference is one fewer entry in the capped hold map.

2.4 O2 and O3 (item 4)

Retry-After on a hold with validAfter = T0+55, same mocked clock:

| request time | header |
|---|---|
| first answer (reached settle) | none |
| +0 ms, +1 ms, +999 ms | 55 |
| +1,000 ms | 54 |
| +10,000 ms | 45 |
| +53,999 ms | 2 |
| +54,000 ms, +54,999 ms | 1 |
| +55,000 ms | none (due, goes to settle) |
| hold at the largest skew (validAfter = now+60) | 60 |
| validAfter = now+61 (refused locally) | none |

Always validAfter minus floor(now), an integer >= 1. In the golden set (2.5) the header is on
the held 402 and on nothing else: not the first not-yet-valid, not throttled, not cooldown,
not any operator or payer fault, not the 302, not the 200. Hono with a custom verifier:
header only for a positive safe integer on a refusal (0, -5, 1.5, NaN, Infinity, 2^53, "7",
and ok:true give none).

Held repeats, verified agent, offer_grace 3:

| probe | main | head |
|---|---|---|
| honest agent, one early payment (validAfter +60), 1 request/s | 60 x 402, then 200 | 60 x 402 (59 with Retry-After 59..1), then 200; never 302; 2 settle calls |
| agent at 10 requests/s on one held payment, 120 requests | 120 x 402 | first 302 at request 64 (1 first + 60 free + 2 that record offers + the mazed one), all 302 after; 1 settle call |
| two held payments, alternating | never 302 | first 302 at request 64 (one count per agent key, not per payment) |
| 50 held repeats, then a successful payment, then 70 more | never 302 | paid 200; count reset: first 302 at the 64th after |
| window 30 s: 55 held repeats, window rolls, 70 more | never 302 | count reset by the roll: first 302 at the 64th after |
| anonymous client, 200 held repeats | 200 x 402 | 200 x 402, never 302 |
| another verified agent B (100 repeats) and an anonymous client (100) hammer A's held payment | n/a | B is mazed at its own 64th; A's budget untouched (A's first 302 only after its own 60) |

Whose budget: the count is keyed by `identity.agentKey`, which exists only after the
request's Web Bot Auth signature verified (PIPE:244). An attacker without the victim's key
cannot spend it. Replaying a captured signed request of the victim spends it, but the same
replay with no payment already spends the victim's grace in 3 requests on main, so nothing
new.

2.5 Public contract (item 5)

My golden set: 94 entries (full responses with status, all headers and body bytes, plus
call counts) on main and head: no payment, garbage, JSON not a payment, expired, amount too
low, too early (local), window too long, wrong recipient, signer mismatch, human, free path,
report path, maze path, unfunded, replay, throw, reject, 500 HTML, 503, no tx id,
unconfirmed, 400 (three forms), 404, 401, 429, 2xx HTML, retryable, network-mismatch,
success, replay after success (also respelled), no token, early first, held, due (success,
not-yet-valid again, unfunded, throttled, 503; payer cooled and not), cooldown (also last ms
and first ms after), throttled, three concurrent failures, A1, joiners of an OK / failed /
503 leader, agent offer, mazed agent, mazed agent pays, held repeats 1 / 60 / 61 / 62 / 63.

19 entries differ, every one a table row:

| entries | difference | row |
|---|---|---|
| held repeat (2 forms), agent held repeats 1, 60, 61, 62 | + retry-after, body and other headers identical | A2 |
| 4th concurrent payment | 200 -> 402 payer-cooldown, byte-identical to the cooldown 402 | A1 |
| agent held repeat 63 (and the status list) | 402 -> 302 to the maze | A3 |
| due attempt, payer cooled: success, unfunded and its replay, fresh payment after the success | 402 payer-cooldown -> the settle result | A4 |
| due attempt answered not-yet-valid again | payer-cooldown -> not-yet-valid; the retry is payer-cooldown on both | A4, A5 |
| due attempt, empty bucket, and its retry | payer-cooldown -> throttled (bytes equal to the plain throttled 402); retry served | A4, A6 |
| due attempt, 503, and its retry | payer-cooldown -> operator-fault 402 (bytes equal to the plain 503 one); retry served | A4, A7 |

75 entries are byte-identical. No new reason string, text, status code or body shape. The one
difference outside the table is H1 (not in this set; found by the window probe).
Exported types (compiled .d.ts, main against head): only `OfferState.heldInWindow`,
`OfferLedger.recordHeld` (and a private `roll`), `X402VerifyResult.retryAfterS?`, and the
`_sizes()` hook on the @internal `makeSettlingVerify`. As T1.
Scope: 19 files, all under packages/cloudflare, packages/core, packages/hono (src, tests,
README, CHANGELOG) and specs/005, specs/006. No package.json, lockfile, workflow,
adapter-x402 or adapter-stripe change. No added or removed line mentions stripe or voucher.
`retry-after` appears in src only at HONO:730.

2.6 State bounds (item 6)

100,000 requests from 50,000 distinct payers through `makeSettlingVerify` (two requests per
payer, mixed answers: success, unfunded, not-yet-valid, no tx id, 503; a third of the
payments early), 66,667 settle calls:

| map | cap | largest seen | at the end |
|---|---|---|---|
| seen | 512 | 512 | 512 |
| payerFails | 512 | 512 | 512 |
| notYetValid | 512 | 512 | 512 |
| inflight | - | 0 | 0 |
| payerInflight | <= inflight | 0 | 0 |

Offer ledger: 50,000 agent keys through `recordHeld` twice each: size 50,000 = the default
`agent_ledger_max` (same LRU as offers). I did not drive 50,000 verified agents through the
handler; the ledger bound was measured at the core class.
Entries do not expire by time in seen, payerFails or notYetValid; they are overwritten,
deleted on use, or pushed out at the cap (as on main). inflight and payerInflight entries
leave only when the settle returns: a hung settle keeps both (inflight: old; payerInflight:
M1), growing at most at the bucket rate.


3. MUTANTS (item 7)

46 mutants on the changed lines, each against the full cloudflare, core and hono suites.
42 killed, 2 survive as real gaps (L4, L5), 2 are equivalent.

| mutant | result | first killing test |
|---|---|---|
| M01 due `>=` -> `>` | killed (8) | pages-settle "a not-yet-valid answer to the due attempt is not held again (row A5)" |
| M02 due always false | killed (9) | same |
| M03 retryAfterS + 1 | killed (4) | contract-golden "held" |
| M04 retryAfterS dropped | killed (4) | contract-golden "held" |
| M05 live `<` -> `<=` | killed (7) | pages-settle "L4: 'row 5' failures at t, t+1 s, t+300 s ..." |
| M06 due does not skip the refusal | killed (8) | pages-settle "(a) L3, row A4 ..." |
| M07 refusal `>=` -> `>` | killed (60) | contract-golden "cooldown" |
| M08 in-flight not counted | killed (20) | contract-golden "fourth concurrent payment (A1)" |
| M09 due entry never deleted | killed (4) | pages-settle row A5 test |
| M10 due entry deleted before the bucket check | killed (2) | pages-settle "M1: the same early payment at 10 rps ..." |
| M11 reserve + 2 | killed (135) | contract-golden "cooldown" |
| M12 no reservation | killed (21) | contract-golden "fourth concurrent payment (A1)" |
| M13 never released | killed (119) | contract-golden "cooldown" |
| M14 release `left > 0` -> `> 1` | killed (3) | pages-settle "M1: the same early payment at 10 rps ..." |
| M15 release deletes the whole entry | killed (3) | pages-settle "_sizes() counts payers with a settle in flight, not settles" |
| M16 row 5 always held | killed (4) | pages-settle row A5 test |
| M17 row 5 hold `>` -> `>=` | killed (2) | pages-settle row A5 test |
| M18 row 5 cooldown from the pre-await clock | killed (4) | pages-settle "M1: the same early payment at 10 rps ..." |
| M19 rows 6/7 cooldown from the pre-await clock | killed (2) | pages-settle "L2: a held 'row 6' failure landing at 5 s ..." |
| M20 row 5 count `<` -> `<=` | killed (2) | pages-settle "L4: a 'row 5' failure written exactly at untilMs starts at 1" |
| M21 rows 6/7 count `<` -> `<=` | killed (1) | pages-settle "L4: a 'row 6' failure written exactly at untilMs starts at 1" |
| M22 A7 put-back on any failure | killed (3) | pages-settle row A5 test |
| M23 A7 no put-back | killed (1) | pages-settle "(d) row A7 ..." |
| M24 held check `<` -> `<=` | killed (13) | pages-settle "after validAfter exactly one settle attempt is allowed ..." |
| M25 live ignores the window | killed (6) | pages-settle "L4: 'row 5' failures at t, t+1 s, t+300 s ..." |
| M26 A7 put-back also for settle-unconfirmed | SURVIVED | real gap (L5) |
| M27 cap `> 60` -> `>= 60` | killed (2) | pipeline-payment "held repeats: 60 record no offer, the 61st does ..." |
| M28 cap 61 | killed (3) | settle-budget "a verified agent at 10 req/s ... 302 by request 64" |
| M30 roll keeps heldInWindow | killed (2) | ledger "recordHeld rolls with the window like recordOffer" |
| M31 recordPaid keeps heldInWindow | killed (1) | ledger "recordPaid resets the held count" |
| M32 recordHeld does not roll | killed (1) | ledger "recordHeld rolls with the window like recordOffer" |
| M33 recordHeld counts by 2 | killed (7) | settle-budget "an honest agent polling 1/s for 60 s ..." |
| M34 hono `> 0` -> `>= 0` | killed (1) | payment-errors "retryAfterS 0 ... no retry-after" |
| M35 hono header without the x-payment check | survived | equivalent: `payment` is set only when the request carried X-PAYMENT (HONO:849-862) |
| M36 hono isSafeInteger -> isFinite | killed (1) | payment-errors "retryAfterS 1.5 ... no retry-after" |
| M37 hono header also when ok | survived | equivalent: an ok result never reaches `offerResponse` |
| M38 roll `>` -> `>=` | killed (1) | ledger "recordHeld rolls with the window like recordOffer" |
| M40 reservation keyed per payment | killed (20) | contract-golden "fourth concurrent payment (A1)" |
| M41 due attempt does not reserve | SURVIVED | real gap (L4) |
| M42 A7 puts back validAfter + 60 | killed (1) | pages-settle "(d) row A7 ..." |
| m01 row 5 counts from the pre-await snapshot | killed (8) | pages-settle "L1: three concurrent early payments from one payer cool it down" |
| m04 rows 6/7 ignore the window | killed (3) | pages-settle "L4: a row-6 count from an expired cooldown window restarts at 1" |
| m09 row 5 keeps the old untilMs | killed (2) | pages-settle "L4: 'row 5' failures at t, t+1 s, t+300 s ..." |
| m10 rows 6/7 keep the old untilMs | killed (2) | pages-settle "L4: 'row 6' failures at t, t+1 s, t+300 s ..." |
| m21 row 5 max(snapshot, re-read) | killed (2) | pages-settle "L4 (P2d): a success landing before an in-flight 'row 5' failure ..." |
| m22 rows 6/7 max(snapshot, re-read) | killed (2) | pages-settle "L4 (P2d): ... 'row 6' failure ..." |

The earlier review's lows: L1 closed (m01 killed), L2 closed (CF:426, CF:441; M18, M19
killed), L4 closed (m04, m09, m10, M20, M21, m21, m22 killed), L5 closed (specs/005
closeout line 3 now f24a66e).

CI commands, three rounds on a clean copy of the head, each offline in an empty network
namespace with only loopback up:

| command | round 1 | round 2 | round 3 |
|---|---|---|---|
| biome check . | exit 0 | exit 0 | exit 0 |
| tsc -b && tsc -p tsconfig.tests.json | exit 0 | exit 0 | exit 0 |
| vitest run | 58 files, 774 tests passed | same | same |
| bun examples/bun-hono/check.ts | OK | OK | OK |
| node --experimental-strip-types bench/bench.ts --check | PASS | PASS | PASS |

No flake. Biome prints 1 warning and 4 infos, all in files this branch does not touch
(for example packages/core/test/keyfile.test.ts:51).


4. DOCUMENTS (item 8)

- README (cloudflare): A1, A2, A3, the due attempt, A5, A6, A7, A8 are stated. Both bounds
  are stated and match what I measured: at most 6 settle calls per payer in any 600 s window
  for early nonces (measured 6); 2 per nonce for a cooled-down or reserved-out payer
  (measured 2); a lone early nonce against a lagging facilitator 3, no more than main
  (measured 3 and 3); 100 concurrent = 3; first 302 by request 64. Missing: the outage case
  (L1) and what bounds a reservation (M1).
- CHANGELOG 2.3.0: rows A1-A8 and T1 are there, worded as the table.
- hono README: `retryAfterS` and the header, accurate (matches the hono probe).
- closeout: both bounds stated (section 7); HEAD line stale (L3).
- spec.md: lines 51 and 90 still give only "2 per nonce" (L2).
- The "validAfter <= now is never held" rule is in the README and in the closeout; not
  observable by a caller (2.3).


5. COULD NOT DETERMINE

- Whether workerd really drops the `finally` when a client disconnects during the settle
  (M1's trigger). No workerd on this machine and no network. The mechanism (a reservation
  that outlives its settle forever) is measured; the trigger is reasoned.
- GitHub CI on the draft PR (no network use; local equivalents only).
- 50,000 verified agent keys through the handler (measured at the ledger class instead).
- Live facilitator behaviour for concurrent copies of one nonce (L6 uses a stub that
  confirms every call).


6. DISCLOSURE

- Nothing left the machine. Every build and test ran under `unshare -rn` (no network;
  loopback only for the repo's own two example checks). No git fetch, no install, no call to
  any payment provider, facilitator, chain RPC or Stripe endpoint. Keys were fixed test
  seeds inside the temp copy.
- The worktree was not changed (`git status --short` empty before and after; head 2abd077).
  Nothing was pushed or commented. Nothing under the crew's runs directory was read.
- The temp copy <review-temp-dir>/fso1o4 (git archive copies of head and
  main, copied node_modules, probe files, logs) was removed and its absence checked. Other
  files in <review-temp-dir> are not mine and were not touched.
- Left behind: this report, and my probe scripts in the session scratchpad
  <review-temp-dir>/scratchpad/ (a separate session directory, not the removed copy above)
  (zzlib.ts, zz-fuzz.test.ts, zz-probe.test.ts, zz-golden.test.ts, zz-extra.test.ts,
  zz-win.test.ts, fs_*.sh, fs_*.py).
- Stripe code: none removed.
