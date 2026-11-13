VERDICT: FAIL for 7e81768d8b48e5b92790ecdce5f5fee4ded506c4

Second review, round 2 (narrow), of TunnelMind/tollbooth draft PR #17, branch
crew/fareseal-contract-o1o4-1 (Fareseal payment contract O1-O4). Reviewed 2026-11-13.
Head is the expected 7e81768. Round 1 reviewed 2abd0777b16253e943c9f2aacb9a784dba619e1a;
the fixes are `git diff 2abd077..HEAD` (16 files, +1616 -73; tasks R001-R011).
Base origin/main 6825c30: 0 behind, 28 ahead; `git merge-tree --write-tree origin/main HEAD`
is clean (tree feaf90c5).

No HIGH. Three MEDIUM, all around the one new path this round added (the 10 s settle
timeout) and the part of round 1's M1 that was not built. No way was found to take money
twice for one authorization or to serve twice for one payment. Round 1's H1 is closed.

Short names: CF = packages/cloudflare/src/index.ts, PIPE = packages/core/src/pipeline.ts,
LEDGER = packages/core/src/ledger.ts, HONO = packages/hono/src/index.ts,
PS = packages/cloudflare/test/pages-settle.test.ts. Lines are at the head.
"Ran" = run by me on a git-archive copy, offline (unshare -rn, loopback only).


1. FINDINGS

MEDIUM

M1. The 10 s settle timeout is shorter than the settle route's own budget for a call that
    succeeds, so a payment that the route would have settled and answered is cut off, the
    payer is not served, and the operator may have no receipt for money that moved.
    Where: CF:92 (SETTLE_TIMEOUT_MS = 10_000), CF:382 (the signal), CF:504-505.
    Evidence (read, not run; the only thing I read outside the worktree): the settle route
    in the local data-api checkout (api/routes/fareseal-settle.js at 6cc211d, lines 100-130)
    awaits facilitatorVerify, then facilitatorSettle, then recordSettlement, and
    api/lib/x402/facilitator.js:72 gives EACH facilitator call its own
    AbortSignal.timeout(10_000). So the route may take up to about 20 s plus the receipt
    write and still answer settled:true. Any call where verify + settle together pass 10 s
    is aborted by the toll. Main waited and served 200.
    What follows (reasoned): the abort travels over the service binding
    (CF:573, binding.fetch(new Request(url, init))) and ends the route's request. If that
    lands after the facilitator has the settle call and before recordSettlement (route
    line 125), the transfer completes on chain and no `payment` receipt is written; the
    route's header says "money moved is always receipted". The payer gets 402
    settle-unconfirmed. Ran (probe P1): the payer's retry of the same payment is a new
    settle call; when the route answers settled:false with a nonce-used reason (which it
    must, the route is not idempotent: a second verify of a spent nonce fails, route
    line 106-107) the answer is 402 "facilitator rejected: <reason>", cached for the nonce
    and counted toward the payer's cooldown (two more such payments and the payer is cooled
    down). So: charged, not served, then blamed. It is not silent (the first answer says
    "do not pay again, contact the operator"), which is why this is MEDIUM and not HIGH.
    The CHANGELOG (A9), README, code comment and pr-body all say plainly that 10 s is a
    judgment and unmeasured; nothing is claimed as measured. The crew review listed this as
    a low ("unmeasured"). It is more than unmeasured: it is below the callee's own limit.
    Fix: set SETTLE_TIMEOUT_MS above the route's worst successful case (two 10 s facilitator
    calls + receipt write: 25 s, and RESERVATION_TTL_MS above that, e.g. 45 s), or have the
    route keep its total under the toll's limit; and make the route record the receipt
    under waitUntil so a caller's abort cannot lose it (data-api, own run). Put the pair of
    numbers side by side in the README. Then M2's fix covers what is left.

M2. `settle-unconfirmed` is answered with a complete fresh offer, and nothing remembers
    that the payment may have settled.
    Where: PIPE:392-393 (isNoOfferFault -> action "offer" with the offer body),
    HONO:698-716 (x402 headers and `accepts` are added for every 402), CF:504-505 and
    CF:427-428 (nothing stored for the key).
    Ran (P1): the timeout 402 carries `x-payment-required` with the full requirement, and
    a body with `accepts: [requirement]`, `options`, `price_usd`, next to
    error "settlement status unconfirmed; do not pay again, contact the operator". An x402
    client that acts on `accepts` and does not read the error text signs a NEW
    authorization (new nonce) on its next call: if the first transfer landed, the payer is
    charged twice and served once. This shape is old for row 3a (a non-2xx with
    settled:true, rare); this round routes every settle slower than 10 s into it (M1), so
    it is now reachable in ordinary operation. Not HIGH: the toll never settles one
    authorization twice; the second charge needs the payer's client to sign again against
    the stated advice.
    Second half, ran (P1): after an unconfirmed answer the same payment sent again is
    settled again (calls 2). With a route that answers OK it is served (200, receipt), so
    "retry the same payment" is in fact the safe move and the 402 text does not say so.
    With a route that answers nonce-used it is cached and counted as the payer's fault
    (see M1).
    Fix: (a) on `settle-unconfirmed` (and `no-transaction-id`) send no `accepts`, no
    `x-payment-required` and no `options`: an error-only 402 (or 503 with Retry-After) so no
    client is invited to sign a new payment; (b) keep a capped map of keys whose last answer
    was unconfirmed; while a key is in it, a payer-class answer for that key (rows 6/7) is
    answered `settle-unconfirmed` again, not cached as the payer's fault and not counted;
    (c) change the text to say the same payment may be retried and no new one signed.
    Tests: the 402 for a timeout has no `accepts`; timeout then nonce-used on the retry is
    unconfirmed, payerFails 0.

M3. Round 1's M1 is only half closed: the per-payment `inflight` entry still has no age
    limit and its release still runs only in the request's `finally`. Old on main; R002(b)
    asked for it ("the release does not depend on the request staying alive") and it was
    not built (pr-body:27 says so for waitUntil).
    Where: CF:320-328 (join), CF:510, CF:530-531.
    Ran (P5, a settle whose promise never settles, which is what a request cancelled by the
    runtime leaves behind): 51 dead settles -> inflight 51, and still 51 at +31 s and
    +4.5 min (payerInflight is swept: 1). The same payment sent again at +31 s and at
    +4.5 min never gets an answer: it joins the dead promise (no settle call). A fresh
    payment from the same payer does start (the TTL works).
    Why it matters (reasoned, no workerd here): the usual cause is a client that gives up
    before a slow settle answers; that client then retries the same payment, which is
    exactly the request that hangs, on that isolate, until the isolate is recycled. If the
    first settle did land, that payer is charged and gets no answer at all. The map also
    grows without bound at the bucket rate (5/s) for anyone who sends a payment and drops
    the connection. The crew review has this as a low; I rate it MEDIUM because it is the
    one place where a payer can be left with no plain answer, and the fix is small now that
    a settle cannot run past the timeout.
    Fix: store the start time with each `inflight` entry; on read, an entry older than
    RESERVATION_TTL_MS is dead by construction (its fetch was aborted at the timeout):
    delete it and go on as a new attempt; sweep them where reservations are swept
    (CF:356). Test: PS "R002 M1 test 3" already holds 300 dead entries; add the same-payment
    retry after the limit (one new settle call, an answer) and inflight 0 after a sweep.
    Or run settle + release under waitUntil (needs the context passed through hono).

LOW

L1. A timeout while reading the body of a NON-2xx answer is swallowed. CF:387-389:
    `resp.json().catch(() => null)` also catches the TimeoutError, so the answer is
    classified by status alone. Ran (P2b, real loopback server, native timer): 502 headers
    then a stalled body -> `settle-retryable` ("retry the same payment") at 10.006 s; 200
    headers then a stalled body -> `settle-unconfirmed` at 10.012 s; no answer at all ->
    `settle-unconfirmed` at 10.013 s. A 4xx with a stalled body becomes row 7 (cached,
    counted). The comment at CF:500-503 and CHANGELOG A9 ("on the fetch and on reading its
    body") are true for 2xx only. Fix: in that catch rethrow a TimeoutError; one test.
L2. No test runs the native timer. Every timeout test either throws a hand-made
    DOMException from the stub or replaces AbortSignal.timeout (PS manualTimeouts). That
    the real signal reaches the fetch, rejects with name "TimeoutError" and covers the body
    read is unpinned in the suite (it does hold in Node 's fetch: P2b). On workerd through a
    service binding it is unverified by anyone. Fix: one slow test with a loopback server
    (10 s), or make the limit injectable for the test; owner's workerd check stays open.
L3. Two ledger mutants survive (699 tests pass): LEDGER `roll` without
    `this.heldStart.delete(state)`, and `recordPaid` without it. Effect of the bug they
    stand for: a held window that ends early (more free held repeats), never money.
    Fix: a test that rolls the offer window (and one that pays) mid held-window and checks
    the held window's end.
L4. In-isolate replay protection is a 512-entry cache (CF:79 DAMP_CAP, CF:244). Ran (P7):
    after 512 other settled payments (98.6 s at the bucket rate, well inside a payment's
    360 s life) a replay of a settled payment is no longer answered locally and goes to
    the bucket and settle. Same on main. Safe only because the route refuses a spent nonce
    (route line 106-107, read). The README says this for other isolates (README:82-83); it
    is equally true inside one. Fix: say it; do not ever make the settle route idempotent
    for a spent nonce without changing this.
L5. `building` (CF:619, 785-799) shares one promise between requests. Correct in Node
    (mutants F, H killed). It relies on buildState doing no request-bound I/O (today only
    publicKeyOf, CF:637); if a later change adds a fetch there and the first request is
    cancelled, every later request of the isolate would wait on a dead build. Fix: a
    comment at buildState stating that rule.
L6. closeout.md:3 still names `ed98127` / `7f87051` as the head (round 1's L3; the head is
    7e81768). Public-repo hygiene, item 5: the branch adds local paths and names in specs
    text: closeout.md (a vitest banner with /home/o2k/.crew/work/...),
    second-review-2abd077.md (a C:\Users\<user>\AppData\... scratchpad path and
    ~/.crew/coord paths), spec.md and tasks.md (the owner's first name, ~/.crew/coord/fix5).
    No secret value, no token, no host name or address. Fix: strip the paths before the PR
    leaves draft.
L7. `BigInt(opts.nowS ...)` at CF:299 throws on a non-integer nowS, against "never throws
    into the pipeline" (CF:223). Not reachable through createPagesMiddleware (it passes no
    nowS); old. Fix: Math.floor.


2. ROUND 1 FINDINGS

| round 1 | state | evidence |
|---|---|---|
| H1 held repeat moves the offer window | closed | LEDGER:96-102 recordHeld no longer rolls; :72-74 first offer opens the window; :128 exhausted ignores a held-only entry; receipt uses usableState (HONO:887-888, R005). Mutants: recordHeld rolls again, exhausted counts held-only, first offer keeps the held start, window edge `>=`, receipt uses get: all killed (core ledger.test "recordHeld never rolls the offer window (H1)", "... at every t across the edge", hono reporter-wiring "R005"). |
| M1 reservation never released | partly | payer lock-out closed: CF:266-273, 336, 356, 535-539; PS "R002 M1 test 1-6"; mutants TTL `<=`, TTL 5 s, check ignores TTL, release-oldest, no sweep, no signal, timeout 60 s all killed. Not closed: the per-payment inflight entry and the cancelled request (M3). The timeout chosen opens M1/M2 above. |
| L1 A7 unbounded in an outage | closed | CF:104, 521-528; PS "row A7 bound"; mutants `<=` and faults-never-grow killed; README:141-149, CHANGELOG A7. |
| L2 spec "2 per nonce" | closed | spec.md:51, :92 give both bounds. |
| L3 closeout head | not closed | closeout.md:3 (L6). |
| L4 due attempt reserves | closed | PS "R-O4: due attempts in flight are reserved". |
| L5 hold not put back after unconfirmed | closed | PS "row A7: a due attempt answered 502 with settled:true ...". |
| L6 cold-start state | closed in Node | CF:619, 781-800; PS "cold handler" (3 tests); mutants not-single-flight and failed-build-kept killed. workerd interleaving not determined (the closeout says so). |
| L7 A1 cost | accepted by owner | README:162-167. |


3. MONEY SAFETY BY ATTACK (code as it stands)

| attack | result |
|---|---|
| one authorization settled twice, one isolate, concurrent | no. Seen cache CF:295, join CF:320-328, reservation and due-delete in the same synchronous run CF:336-361. Round 1 fuzz (4,200 schedules) was on 2abd077; the changed lines are covered by the tests and mutants above, I did not re-run a fuzz. |
| cold isolate burst | no (in Node): one state, CF:781-800. |
| across isolates / after the 512-entry cache turns over | toll calls settle again (P8: 2 calls; P7). Not served twice only because the route's facilitator verify refuses a spent nonce (read at data-api 6cc211d, not run against a facilitator). L4. |
| retry during the settle | joins, gets the leader's reason or "nonce already used"; one call (PS test 4). |
| settle answers after the 10 s timeout | the answer is dropped (fetch aborted), nobody is served late: no double service. The payer may be charged and unserved, told "unconfirmed" (M1), offered a fresh payment (M2). |
| request cancelled by the runtime | reservation gone after 30 s; inflight entry stays, same-payment retry hangs (M3). |
| reservation expires at 30 s while its settle runs | cannot happen when the fetch honours the signal (10 s < 30 s). With a custom opts.fetch that ignores the signal it can: the payer then gets more than 3 concurrent settles (damping only); the same payment still joins (inflight has no TTL) and the late release removes only its own object (PS test 4, test 5). No money effect. |
| clock skew validAfter / validBefore | unchanged this round; local verifyProof runs first (CF:280), an expired due payment never reaches settle; a hold is written only while validAfter > our now (CF:468). |
| replay after recordPaid | 402 "nonce already used", no call, while cached (P7 first lines); then L4. |
| hold a victim's reservations | not possible without the victim's key: the payer is the recovered signer. Any client can still drain the shared bucket (20, 5/s): others get the operator-fault 402 (old, stated). |
| grow a map | payerInflight <= 170 (bucket-bound, swept; PS test 3). seen / payerFails / notYetValid capped at 512. inflight: unbounded under cancelled requests (M3). |
| settle-unconfirmed cached / counted | not cached, not counted, no offer recorded (PS row 3a tests; P1). Counted indirectly on the retry when the route says nonce-used (M1, M2). |
| settle-unconfirmed with a fresh offer | yes (M2). |
| retry-after | Number(early - nowS), both BigInt, strictly positive by CF:312; early <= hold-time now + skew; HONO:724-730 sends it only for a positive safe integer on a refusal with X-PAYMENT. Integer, >= 1. Fine. |


4. CALLERS' CONTRACT

CHANGELOG 2.3.0 has A1-A10, L6, T1; README table row 3a, the 30 s limit (README:116-119),
the A7 bound, the held window wording; hono README:19-22 has retryAfterS. They match the
code, with two gaps: the body-read claim holds for 2xx only (L1), and neither says that a
settle-unconfirmed 402 still carries an offer or what a retry of the same payment does
(M2). Nothing is described as measured that was not: the 10 s and 30 s are both labelled
judgment (CF:89-104, CHANGELOG A9, pr-body:25, :34). Status codes, reasons and header
names in the docs are the ones in the code; no new reason string.


5. TESTS

Pin: TTL edge (29,999 / 30,000 ms), sweep bound 150/170, own-object release, join after
expiry, timeout -> unconfirmed and not cached / not counted, A7 bound, cold start, H1
across the window edge, R005 receipt window. 20 mutants on the fix lines: 18 killed,
2 survive (L3).
Missing: the native timer (L2); timeout during a non-2xx body (L1); same-payment retry
after a dead settle (M3); timeout followed by nonce-used on the retry (M1/M2); the shape of
the unconfirmed 402 (golden has it for 502 + settled:true only); held-window end after an
offer-window roll or a payment (L3).
Impossible here: cross-isolate behaviour and the late on-chain settle (need a real
facilitator and chain); whether workerd cancels the settle fetch and skips `finally` on a
client disconnect; whether a service binding honours the abort and what the route does
when aborted; first-burst interleaving on a cold workerd isolate. All are the owner's
(O001).
Suite on my copy at 7e81768: tsc -b exit 0; vitest 792 passed; 2 example files could not
load (@hono/node-server: my copy did not carry examples/node_modules, not a branch fault).
biome and bench not re-run.


6. ITEM 5

No new dependency: no package.json, lockfile or workflow in `git diff origin/main...HEAD`.
No secret value. Local paths and a first name in specs text: L6.


7. DISCLOSURE

Nothing left the machine: no fetch, no install, no facilitator or chain call; tests ran
under `unshare -rn` (loopback only for my P2b server). Worktree unchanged (`git status
--short` empty, head 7e81768) and nothing pushed or commented. Nothing under ~/.crew/runs/
was read; no secret or env file opened. Read outside the worktree: two source files of
the local data-api checkout (fareseal-settle.js, a grep of facilitator.js), read-only.
Temp copy /home/o2k/.crew/coord/review-tmp/fs17 removed and its absence checked. Left
behind: this report, and my scripts in the session scratchpad (fs17review_setup.sh,
fs17review_probe.test.ts, fs17review_mutants.py). One probe of mine (P2a) was wrong, not
the code: its stub let the Request be garbage-collected, so it is not used as evidence.
