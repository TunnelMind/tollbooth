VERDICT: PASS for 32c3a0789eac543575cb8d66e57c1ecfb7c7afd2

Second review, round 3 (narrow), of TunnelMind/tollbooth draft PR #17, branch
crew/fareseal-contract-o1o4-1 (Fareseal payment contract O1-O4). Reviewed 2026-11-13.
Head is the expected 32c3a07. Round 2 reviewed 7e81768; the fixes are
`git diff 7e81768..HEAD` (tasks R012-R019). No HIGH, no MEDIUM, eight LOW.

Short names: CF = packages/cloudflare/src/index.ts, HONO = packages/hono/src/index.ts,
PS = packages/cloudflare/test/pages-settle.test.ts. Lines are at the head.
"Ran" = run by me on a git-archive copy, offline (unshare -rn), with in-process stubs.

READY FOR THE OWNER'S REVIEW OF THE CONTRACT: YES. The lows below can be fixed before or
after his read; L1 and L2 are the two worth doing first. The 25 s / 45 s values still
need his word (they are reasoned, not measured, and say so everywhere).


1. ROUND 2 FINDINGS

| finding | state | evidence |
|---|---|---|
| M1 settle timeout below the route's budget; retry answered nonce-used blamed on the payer | closed | CF:106 SETTLE_TIMEOUT_MS = 25_000 (route budget: 10 s verify + 10 s settle + receipt write); CF:115 RESERVATION_TTL_MS = 45_000. Blame: CF:559-564, a payer-class answer for a remembered key is settle-unconfirmed, not cached, not counted. Ran P3: timeout, then 30 replays answered nonce_used: 19 unconfirmed + 11 throttled, seen 0, payerFails 0. Mutants 25->10 s, timeout taken from the 45 s constant, amnesty counts, amnesty caches: all killed. The data-api half (receipt under waitUntil, an idempotent route) is another repo and not in this PR. |
| M2 unconfirmed 402 carried a full offer; nothing remembered | closed as asked, one residual (L1) | HONO:630, 708-719: error-only 402 for settle-unconfirmed and no-transaction-id. Ran P1/P8: status 402, no x-payment-required, no accepts, no options, for the leader and for a joiner of the same settle. Memory: CF:317, 415-418 (written on a timeout CF:580 and on non-2xx settled:true CF:490), cap 512 oldest out (CF:129), age 600 s (CF:130, 561), forgotten on success (CF:473). Mutants: never remembered, timeout not remembered, cap 1, cap x4, age edge, never expires, expired entry kept, amnesty renews, header kept, either reason dropped from the set: all killed. |
| M3 inflight entry had no age limit | closed, one residual (L3) | CF:293-294 entry holds atMs; CF:367-378 an entry >= 45 s old is dropped on read and the request is a new attempt; CF:406-407 sweep; CF:610 release removes only its own entry. Mutants: no limit, edge <=, sweep edge, no sweep, release deletes any entry, start time wrong: all killed. PS "R002 M1 test 3" bound 225. |
| `building` had no age limit (R019) | closed | CF:120 BUILD_TTL_MS = 10_000, CF:866-870 replace when >= 10 s old, CF:877-880 a replaced build does not install its state. Mutants: no limit, edge >, replaced build installs: killed. The value itself is unpinned (L5). |
| L1 timeout during a non-2xx body read | closed | CF:446-451 rethrows a TimeoutError; mutant killed. |
| L2 no native-timer test | closed | PS "R013 L2: the native AbortSignal.timeout..." ran 25.0 s real time, passed. |


2. FINDINGS (all LOW)

L1. After an unconfirmed answer the toll says "the same payment may be retried", but when
    that retry meets an operator answer it gets a full offer again. Ran (P1): timeout ->
    error-only 402; the same payment again with the route answering 502, or the call
    failing to connect -> 402 "settlement unavailable (operator fault); retry the same
    payment" WITH x-payment-required, accepts and options. Same for payer-cooldown, and
    (P3) 11 of 30 quick retries met settle-throttled (row 0b, offer shape). CF:384-394 and
    rows 3/4 (CF:498-512) do not look at `unconfirmed`. A client that acts on `accepts`
    then signs a new payment although the first may have moved money: M2's path with one
    more step. Rated low, not medium: with a 25 s limit a timeout is now rare, it needs a
    second fault on the retry, the text still says "retry the same payment", and any
    request sent without X-PAYMENT gets the offer anyway. Fix (small): while a key is
    remembered as unconfirmed, answer settle-throttled / settle-retryable /
    settle-unreachable / payer-cooldown for that key as settle-unconfirmed too (error-only).
    One test.
L2. Test gap, mutant m13 survives: nothing pins that a non-2xx with settled:true (CF:490)
    is remembered; only the timeout entry path is tested. The code is right. If it
    regressed, a payer whose transfer landed would again be answered "facilitator
    rejected: nonce used", cached and counted. No change in money or service. Fix: repeat
    the R012 timeout test with a 502 + settled:true first answer.
L3. A copy that joined a settle before the 45 s limit still waits on that promise for ever
    if the settle never returns (CF:368). Only copies arriving at or after 45 s start
    anew. So a client that disconnects and retries at once can hang once more, until its
    own timeout; its next retry after 45 s is answered. Fix: race the join against a timer
    for the entry's remaining age and answer settle-unconfirmed. Whether workerd leaves
    such a promise pending at all cannot be determined here.
L4. Unconfirmed map order. `remember` (CF:204) re-sets an existing key without moving it,
    so a payment answered 3a a second time keeps its old place and can be evicted first.
    Ran (P2): 512 unconfirmed payments, the first renewed, one more added: the renewed one
    is gone and its nonce_used answer is cached and counted. Also plain overflow: in an
    outage with more than 512 timed-out payments inside 10 minutes (about 100 s at the
    bucket rate) the oldest lose the amnesty, i.e. round 2's M1 blame returns for them.
    An attacker cannot cause entries (they need the operator's own timeout or the route's
    settled:true). Fix: delete before set in answerUnconfirmed; the cap is documented.
L5. Two constants are not pinned by value: m03 (BUILD_TTL_MS 10 s -> 600 s) and m04
    (UNCONFIRMED_TTL_MS 600 s -> 60 s) survive, because the tests read the exported
    constants. Not money. Fix: one literal assertion each (10_000, 600_000; and that
    600 s > 300 s payment life + skew).
L6. After the 45 s limit, or after a replaced build (two States), one payment can have two
    settle calls in one isolate. Ran (P5, a fetch that ignores the abort, both calls
    answered settled:true): both requests were served. With a fetch that honours the
    signal this cannot happen (the first ends at 25 s). Service is given once only because
    the route refuses a spent nonce, the same dependency the README already states for
    the 512-entry cache and other isolates. CF:290-293 and CHANGELOG A13 say "not a second
    charge" and do not say "served once only if the route refuses the nonce". Fix: add
    that sentence.
L7. CHANGELOG A9 (packages/cloudflare/CHANGELOG.md:16) still quotes the old text "do not
    pay again, contact the operator" as "the existing reason and text"; A11 then says it
    replaces it. Correct but a reader of A9 alone gets the wrong text. The 10 s build limit
    (R019) is in no CHANGELOG or README line (internal, no shape change; L6's entry says
    requests "wait for one build" without the limit).
L8. Row 5 (valid_after) for a remembered key is still counted (CF:525-545 runs before the
    amnesty at CF:559). Harmless: that answer means the first transfer did not land.


3. MONEY SAFETY BY ATTACK (changed paths)

| attack | result |
|---|---|
| charged twice | no path in the toll: one authorization, one nonce. A second charge needs the payer to sign anew; the unconfirmed 402 no longer invites it (residual L1). |
| charged and not served without being told | no. Timeout or 3a: error-only 402 with the unconfirmed text; later nonce_used for that payment: the same answer for 10 minutes (longer than a payment's 300 s + skew life; after expiry verifyProof refuses locally). README:157-159 states the cost: served only if the route confirms, else contact the operator. |
| served twice for one payment | not with a fetch that honours the abort: P4 timeout then 6 concurrent retries with the route confirming: one 200, five 402, 2 settle calls, replay 402 with no call. With an abort-ignoring fetch or cross-isolate it rests on the route (L6). |
| reservation / inflight entry expiring while its settle runs | cannot with the built-in fetch: abort at 25 s (fetch and body read), limits at 45 s, 20 s margin, same `now` for both (CF:364, 409, 584). Order is right: 25 s timeout < 45 s reservation = inflight; build 10 s is independent (crypto only). Mutant "limit 20 s" killed. |
| holding reservations | P7: three hung settles lock that payer out (payer-cooldown) until 45 s, then free. Needs the payer's own key. Was 30 s. |
| growing a map | inflight and payerInflight <= 245 (20 + 5/s x 45 s), swept on each new settle; unconfirmed <= 512; seen / payerFails / notYetValid <= 512 as before. |
| different payer reusing a remembered key | impossible: key is recovered signer + nonce. Ran P3: other signer, same nonce: nonce_used, cached and counted as usual. |
| replay attacker hiding behind "unconfirmed" | each uncounted replay costs a settle call and a bucket token (P3: 20 calls then throttled), ends at 10 minutes or the payment's expiry; the time is not renewed by the amnesty (mutant killed). Entry needs an operator-side timeout, which a payer cannot cause. Cost: the shared bucket, never money. |
| per-isolate memory | another isolate does not know the key: its nonce_used is cached and counted there (README says per isolate). Blame only. |
| boundary | 599_999 ms remembered, 600_000 not (CF:561; mutant <= killed); join 44_999 joins, 45_000 new attempt (P5; mutant killed). |
| retry-after | unchanged this round: Number(early - nowS) of two BigInts, >= 1, sent only as a positive safe integer. |


4. MUTANTS

32 on the fix lines: 29 killed, 3 survived: m03 build limit value, m04 unconfirmed age
value (L5), m13 non-2xx settled:true not remembered (L2). None changes who is charged or
served.


5. CALLERS' CONTRACT

CHANGELOG A9-A13, README row 3a and :126-164, pr-body:25-45, spec rows A9-A13 match the
code: status 402, reasons unchanged, new unconfirmed text (HONO:624-625), error-only body
and headers, 25 s / 45 s, 512 / 10 minutes. Every mention of 25 s and 45 s says reasoned
from the route's budget, not measured, owner approval pending (CF:92-115, README:139-141,
CHANGELOG A9/A10/A13, pr-body:27, :45); 512, 10 minutes and the 10 s build limit are called
judgments. Nothing is described as measured that was not. Gaps: L1 (not stated that a
retry can get an offer again), L6, L7.


6. TESTS

Copy at 32c3a07: tsc -b exit 0, tsc -p tsconfig.tests.json exit 0, vitest 60 files,
822 passed, 0 failed (45 s; includes the 25 s native-timer test).

Cannot be tested here: cross-isolate behaviour; a late on-chain settle and what the route
answers for a spent nonce (real facilitator and chain); whether workerd cancels the settle
fetch and skips `finally` on a client disconnect, and whether a joined promise then stays
pending; whether the abort crosses a service binding and what the route does when aborted;
cold-isolate interleaving on workerd; the route's real latency (the basis of 25 s).


7. DISCLOSURE

Read-only. Nothing left the machine: no fetch, no install, no facilitator call. Worktree
unchanged (git status empty, head 32c3a07), nothing pushed or commented. Nothing under
<runs>/ read, no secret or env file opened. Copy <coord>/review-tmp/fs17c
removed and its absence checked. Left behind: this report and my scripts in the session
scratchpad (fs17review3_*; reused from the cut-off attempt after reading them).
