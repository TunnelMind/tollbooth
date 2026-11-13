# Spec: fareseal-contract-o1o4-1 — Fareseal payment contract: options O1, O2, O3 and O4

**Source:** Josh's prompt (2026-11-13), brought from another chat. Josh: "3 = yes on Fareseal O1, O2, O3 and O4." and "draft PRs, merges stay mine".
**Options defined in:** `specs/005-fareseal-pay-lows-2/spec.md` "Open Questions" and its `closeout.md` (merged with tollbooth#16, main `6825c30`).
**Second review in scope:** `~/.crew/coord/fix5/fareseal-pay-lows-2-second-review.md` (PASS with lows L1–L5, on f24a66e).
**Base:** main `6825c30`. CF = `packages/cloudflare/src/index.ts`, PS = `packages/cloudflare/test/pages-settle.test.ts`, HONO = `packages/hono/src/index.ts`, PIPE = `packages/core/src/pipeline.ts`, LEDGER = `packages/core/src/ledger.ts`, README = `packages/cloudflare/README.md`, CHANGELOG = `packages/cloudflare/CHANGELOG.md`. Line numbers are at `6825c30`.

## Intent

Build the four payment-contract changes Josh approved (O1 reserve per-payer in-flight settles, O2 `Retry-After` on the held 402, O3 cap held repeats per agent key, O4 let a due hold through a payer cooldown) and close the second review's lows L1, L2, L4, L5 on the same lines. Each change is written below as an exact rule with a before/after table; anything not in the table must stay byte-identical to main, pinned by a golden test, and money safety is the acceptance bar.

Key sentences from the prompt:
- "ONE DRAFT PR back to Josh for his merge word. Do not merge, no deploy, no publish to npm, no secret, no call to any payment provider, facilitator, chain RPC or Stripe endpoint (stubs only). Stripe stays: remove no Stripe code."
- "for each of O1-O4 write the exact rule to be built, with every variant the spec left open decided by a stated default ... and a before/after table of every status code, reason string, header and body shape that changes."
- "Default where the spec offers a choice: the variant that adds the fewest new strings and headers. Nothing outside those rows may change: pin the unchanged response shapes with a golden test against main."
- "Money safety is the acceptance bar, each with tests through the real Worker handler and a controllable settle stub and clock."
- "O1's reservation is released on every path (success, failure, operator fault, timeout, thrown error)."
- "x402 discovery documents unchanged unless a row in the GATE 0 table says so."

## The rules to build (decided defaults; GATE 0 confirms them)

Current code these rules edit: `makeSettlingVerify` CF:204-408 — hold check CF:243-250, in-flight join CF:251-259, cooldown check CF:260-263, bucket CF:264-272, row 5 write CF:370-382, rows 6/7 write CF:388-395, `finally` CF:401-405; `X402VerifyResult` HONO:67-73; `offerResponse` HONO:681-718; `decide` step 6 PIPE:372-384; `OfferLedger` LEDGER:17-92.

### R-O1 (N1b) — reserve per-payer in-flight settles before the await

- New per-isolate map `payerInflight: Map<payer, number>` in `makeSettlingVerify`: settle calls started for that payer and not finished.
- The cooldown check CF:261-263 becomes one condition: `live = fails && now < fails.untilMs ? fails.n : 0`; refuse when `live + (payerInflight.get(payer) ?? 0) >= PAYER_FAIL_LIMIT` (3). With nothing in flight this is exactly today's check. Skipped only for a due attempt (R-O4).
- **Reason for a reserved-out request: the existing `payer-cooldown`** (variant (b) with reuse; no new string). Same as today's `payer-cooldown`: no settle call, no bucket token, not cached for the nonce, not counted toward the cooldown, offer recorded in core.
- Reserve (`+1`) right after the bucket token is taken (`bucket.tokens -= 1`, CF:272), in the same synchronous run as the check, so no await separates check and reserve. Release (`-1`, delete the entry at 0) in the existing `finally` around `await p` (CF:403-405), so success, payer failure, operator fault, `settle-unreachable` (fetch rejects, timeout/abort, non-JSON 2xx) and any thrown error all release. A request that returns before the token (seen, held, joined, refused, throttled) reserves nothing.
- Bounded: an entry exists only while a settle for that payer runs, so `payerInflight.size <= inflight.size`.
- Copies of one payment still join the leader's settle (CF:251-259) before the check and reserve nothing.

### R-O2 (N3) — `Retry-After` on the held `not-yet-valid` 402 only

- **Variant (c): held only.** The `settle-throttled` 402 and the first `not-yet-valid` 402 stay unchanged (fewest changed shapes; one new header on one shape).
- `X402VerifyResult` (HONO:67) gains an optional field `retryAfterS?: number`. The held return at CF:247-248 becomes `{ ok: false, payer: null, reason: "not-yet-valid-held", retryAfterS: Number(early - nowS) }`. Same clock as the hold check (`opts.nowS`, else wall time). `nowS < early` there, so the value is an integer `>= 1`, and `<= skew_tolerance` (default 60 s, adapter-x402 `src/index.ts:270`) plus the time since the first answer.
- `offerResponse` (HONO:681) sets `retry-after: <retryAfterS as a decimal integer>` when the request carried `x-payment`, `rejected?.ok === false`, and `retryAfterS` is a safe integer `> 0`. Only on a 402 offer. A 302 consequence carries no `Retry-After`. Body, `x-payment-required`, `cache-control`, `link` are unchanged.

### R-O3 (N4) — cap held repeats per verified agent key

- **N = 60** free held repeats per verified agent key in a held window of `cfg.toll.window` (default 10 m), opened by the first held repeat, as a constant `HELD_REPEATS_FREE = 60` in PIPE. Why 60: `validAfter` can be at most `skew_tolerance` (default 60 s) ahead of our clock, so an honest agent polling once a second on its one early payment makes at most 60 held repeats and is never mazed for waiting (with R-O2's header it needs 1). Not a config key.
- `OfferState` (LEDGER:8) gains `heldInWindow: number` (0 on create). New `OfferLedger.recordHeld(key, nowMs, windowMs): number`: touch, expire its own held window (no held start yet, or `nowMs - heldStart > windowMs` → `heldStart = nowMs`, `heldInWindow = 0`; LEDGER:95-99), then `heldInWindow += 1` and return it. `recordHeld` never touches `windowStart` or `offersInWindow`. The held window is cleared when `recordOffer` rolls the offer window or on `recordPaid`: both set `heldInWindow = 0` and drop the held start.
- `decide` step 6 (PIPE:383): for `paid.reason === "not-yet-valid-held"` and a verified agent, `ledgerOffer = deps.ledger.recordHeld(agentKey, nowMs, cfg.toll.window) > HELD_REPEATS_FREE`. Anonymous traffic: unchanged (never ledgered).
- **What a capped repeat gets:** the same 402 (`authorization not yet valid`, with R-O2's header), and an offer is recorded. Once the grace is spent, step 7 sends the existing 302 to the maze, as for any agent that has spent its grace. No new string.

### R-O4 (N5) — a due hold passes a payer cooldown once

- **Which attempt:** a request whose key is in `notYetValid` with `nowS >= early` is that payment's **due attempt**. Today CF:249 deletes the entry right there. Instead set `due = true` and keep the entry for now.
- A due attempt skips the R-O1 refusal (cooldown and reservation). It still needs a bucket token. With the bucket empty it gets `settle-throttled` and the entry stays, so a retry is still the due attempt. When the token is taken, `notYetValid.delete(key)` and the payer's in-flight count goes up by 1. Both happen in the same synchronous run, so concurrent copies join `inflight` and make no second call (as today).
- **How it is counted:** like any attempt. A success clears `payerFails` and is served. Rows 6/7 are cached and counted. Row 5 again (facilitator clock behind, A17) is counted but **not held again**: the `remember(notYetValid, …)` at CF:373 is skipped when `due`, so the next retry is an ordinary attempt that meets the cooldown. An operator-fault answer (`isOperatorFault(reason)`: `settle-retryable`, `settle-unreachable`) puts the entry back with the same `validAfter`, so the "retry the same payment" retry is again the due attempt. That put-back happens at most twice: the third operator-fault answer for one hold drops the hold (R003), so the next request is an ordinary attempt that meets the cooldown. `no-transaction-id` and `settle-unconfirmed` do not put it back.
- **Bound:** per nonce, as ruled at T005 (2026-11-13): a payer who is cooled down or reserved out gets at most 2 payer-attributable settle calls per nonce (the first attempt and the due attempt). A lone early nonce against a lagging facilitator (its clock behind ours, so the due attempt is answered row 5 again) may cost 3 settle calls: the first attempt, the due attempt, and one ordinary retry under row A5, which is the payer's third failure; after that it is `payer-cooldown`. Per payer per 600 s window: at most 3 first attempts (R-O1) + 3 due attempts = 6 for a stream of early nonces. See OQ1.

### L-fixes on the same lines

- **L1** Pin the row-5 half of N1a: 3 concurrent `earlyPayment` from one payer (all `not-yet-valid`, 3 calls), then a 4th fresh payment → `payer-cooldown`, calls still 3. Kills m01.
- **L2** Stamp the cooldown with the clock at write: in both writes (CF:376-380, CF:390-394), `const t = Date.now()`; `n: (cur && t < cur.untilMs ? cur.n : 0) + 1, untilMs: t + PAYER_COOLDOWN_MS`.
- **L4** Tests that kill m04 (rows 6/7 count from an expired window), m09/m10 (a new failure extends the window: failure at t and at t+300 s → still cooled at t+899.999 s, free at t+900 s), m19/m20 (the `<` boundary: a failure at exactly `untilMs` starts at 1), m21/m22 (P2d, in an order R-O1 still allows: one failure, then a funded and an unfunded payment in flight, the success lands first, then the unfunded one fails; one more failure; the next funded payment is served on head and refused under the mutant).
- **L5** `specs/005-fareseal-pay-lows-2/closeout.md` line 3: HEAD `825f88a` → `f24a66e`.

## Before / after table (every caller-visible change; nothing else may change)

| # | Situation | Before (main 6825c30) | After |
|---|---|---|---|
| A1 | Fresh payment from payer P, P has `live` failures and `k` settles in flight, `live + k >= 3`, `live < 3` (e.g. a 4th concurrent payment) | settle call; result per the README table (200 + `x-payment-response` on success) | 402, `x402Version`/`accepts` body with `error: "payer cooling down after repeated failures; retry later"` (reason `payer-cooldown`), no settle call, not cached, not counted, offer recorded. Byte-identical to today's `payer-cooldown` 402 |
| A2 | Held repeat (`not-yet-valid-held`) 402 | headers `cache-control: no-store`, `content-type`, `x-payment-required` | the same plus **`retry-after: <validAfter − now, integer s ≥ 1>`**. Body unchanged |
| A3 | Held repeat number > 60 in a held window, verified agent key | 402, no offer recorded | 402 (as A2), **offer recorded**; once `offer_grace` is spent → the existing 302 to `maze.prefix` |
| A4 | Due attempt (hold has come due) while P is cooled down or reserved out | 402 `payer-cooldown`, no settle call | one settle call; result per the README table (200 + `x-payment-response` on success) |
| A5 | Retry after a due attempt that got row 5 again | held again; the next request settles again, every time | not held; the next request is an ordinary attempt (`payer-cooldown` if cooled, else a settle call) |
| A6 | Due attempt meets an empty bucket | 402 `settle-throttled`; the hold is gone, so the retry is an ordinary attempt | 402 `settle-throttled` (same bytes); the hold stays, so the retry is still the due attempt |
| A7 | Due attempt gets an operator fault | 402 operator-fault text; the hold is gone | same 402; the hold is put back, so the retry is still the due attempt. At most twice: the third operator-fault answer for one hold drops the hold (R003), so the next request is an ordinary attempt that meets the cooldown |
| A8 | When a cooldown ends (L2) | start time of the failing settle + 600 s | time its failure was written + 600 s. No response shape changes |
| A9 | A settle call that has not answered, body included, after 10 s (R006) | no timeout: the request waits; a settle answering after more than 10 s is served per the README table (200 + `x-payment-response` on success) | 402, `error: "settlement status unconfirmed; do not pay again, contact the operator"` (reason `settle-unconfirmed`, the existing reason and text), not cached, not counted, no offer recorded. The payer is not served and their money may already have moved |
| A10 | A payer's reservation (A1) whose settle has not answered, or whose release never ran, 30 s after the settle call started (R002) | — (main has no reservations; under A1 alone it would count until released) | it stops counting and is removed when the payer's reservations are next read (no timer). No response shape changes |
| T1 | Exported types | — | `X402VerifyResult.retryAfterS?: number` (hono, optional); `OfferState.heldInWindow: number` and `OfferLedger.recordHeld()` (core). The `@internal` `makeSettlingVerify` return value gains a `_sizes()` test hook |

**No new reason string, no new 402 text, no new status code.** `settle-throttled` 402, first `not-yet-valid` 402, the x402 discovery shapes (`x-payment-required` header and `accepts` from `buildOffer`), receipts, signed bytes, log formats and exit codes are unchanged. The golden test (FR-001) pins these 26 shapes through the Worker handler, the reviewer's list: no payment, garbage, JSON that is not a payment, unfunded, replay, early, held, cooldown, throttled, unreachable, 500, no tx id, unconfirmed, 400, 404, 2xx HTML, retryable, success, replay after success, expired, amount too low, too early, no token, three concurrent failures, plus a mazed agent (302) and a human pass (200). Only A2 changes one of them (held: plus `retry-after`).

## User Scenarios

### US1 — one payer cannot take the settle bucket with one burst (O1)
- **Given** a warmed Worker handler and a settle stub that never answers, **when** one payer sends 100 fresh payments at once, **then** the stub sees 3 calls (main: 20) and 97 answers are 402 `payer-cooldown`.
- **Given** an honest funded payer with 3 payments in flight, **when** it sends a 4th, **then** the 4th gets 402 `payer-cooldown` with no settle call, and once the 3 are served a 5th is served.
- **Given** each release path (success, `insufficient_funds`, settle 503, fetch rejects after a delay (timeout/abort), fetch throws, 2xx non-JSON), **when** it ends, **then** the payer can again start 3 concurrent settles, and `_sizes().payerInflight` is 0.

### US2 — the held 402 says when to come back (O2)
- **Given** an early payment 55 s ahead held at T0, **when** it is repeated at T0+10 s, **then** the 402 has `retry-after: 45` and is otherwise byte-identical to main's held 402. The `settle-throttled` 402 has no `retry-after`.

### US3 — throwaway payer keys no longer hold the offer open (O3)
- **Given** a verified agent at 10 requests/s on one held early payment, **then** it gets 302 by request 60 + 3 + 1 at the latest. On main it is never mazed while the hold lasts. An honest agent polling once a second for 60 s is never mazed.

### US4 — a fast-clock funded payer is served (O4, L3's case)
- **Given** an honest funded payer whose clock runs 55 s fast, **when** it sends 3 early payments at once (3 × `not-yet-valid`, payer now cooled down) and repeats each one after `validAfter`, **then** all 3 are served (6 settle calls in total, 2 per nonce: the bound for a payer who is cooled down or reserved out). A lone early nonce against a lagging facilitator may cost 3 settle calls (first attempt, due attempt, one ordinary retry under row A5), then `payer-cooldown`. On main after N1a: 3 × `payer-cooldown`, none served.

### US5 — money safety holds (acceptance bar)
Through `createPagesMiddleware` with a recording settle stub and a mocked clock: no 200 without a `settled:true` answer with a valid tx id for that payment; no payment settled twice (concurrent copies, respelled nonces, a due hold with 20 copies → 1 call); no payment refused after its settle succeeded without the `x-payment-response` receipt; no settle call after a settled answer for a nonce.

## Functional Requirements

- **FR-001** Golden test: a new test drives the 26 response shapes above through `createPagesMiddleware` and records status, every header and body as a vitest snapshot, captured on main's source before any source change. Later tasks may change only the snapshot entries their table row names (A2 only, among the 26).
- **FR-002** (L1, L4) Tests that kill mutants m01, m04, m09, m10, m19, m20, m21, m22. Each one shown red with its mutant and green without it.
- **FR-003** (L2) Both cooldown writes use the clock read at write time; a test with a held settle answer and a mocked clock shows the cooldown lasts until landing + 600 s (red before).
- **FR-004** (O1) R-O1 exactly, with US1's tests.
- **FR-005** (O4) R-O4 exactly, with US4's test and the A5, A6, A7 rows each tested.
- **FR-006** (O2) R-O2 exactly, with US2's test and a hono unit test for `offerResponse` with and without `retryAfterS`.
- **FR-007** (O3) R-O3 exactly, with core tests for `recordHeld` (held window, `recordPaid` reset) and `decide` (60 free, 61st records an offer), and US3 through the Worker handler.
- **FR-008** Budget and bounds suite (`packages/cloudflare/test/settle-budget.test.ts`): the second review's section-3(d) scenarios plus the new concurrent ones, through the Worker handler, asserting stub calls `<=` the main column (see SC-003). Maps bounded after 700 payers and 1400 payments (`_sizes()`: seen 512, payerFails 512, notYetValid <= 512, inflight 0, payerInflight 0). Every entry expires, is evicted or is released.
- **FR-009** Docs: README (the damping paragraph, table row 5, "Known costs"), `packages/hono/README.md` (the `Retry-After` header and `retryAfterS`), CHANGELOG `2.3.0 — Unreleased` state A1–A8 and T1 exactly. The L3 known cost is marked resolved by O4. The early-nonce ceiling (6 per payer per window) and the O1 cost (a 4th concurrent payment from an honest payer is refused and records an offer) are stated.
- **FR-010** `specs/006-fareseal-contract-o1o4-1/closeout.md`: per row A1–A8 and T1, the code (file:line) and the test that pins it; mutant red/green runs; the budget table, head against main; golden test run against main's source showing only A2 differs; verify tail; `git diff main --stat`; the Stripe grep.

## Success Criteria

- **SC-001** The verify command (plan.md) exits 0 at the end of every task; GATE F requires GitHub CI green on the draft PR.
- **SC-002** The golden test file run against main's `packages/*/src` (via `git show main:<path>` in a scratch copy) fails only on the held-repeat entry (A2), and only on its headers.
- **SC-003** Budget suite stub-call counts (one payer, fresh nonces). Head must be `<=` main in every row; head numbers are asserted exactly, or as an upper bound where written `<=`:

  | Scenario | main | head |
  |---|---|---|
  | 100 sequential | 3 | 3 |
  | 100 concurrent, one burst | 20 | 3 |
  | 3 concurrent per second, 20 s | 9 | 3 |
  | 20 concurrent every 4 s, 60 s | 60 | 3 |
  | 10 per second, settle never answers, 30 s | 169 | 3 |
  | many payers, 30 per second, 20 s | 115 | <= 115 |

  The one exception, by design (OQ1): a stream of early nonces from one payer whose holds come due gets <= 6 calls per 600 s window (main: 3). The suite asserts that bound.
- **SC-004** Every mutant in FR-002 is red with the mutant and green without it, shown in the task note and in the closeout. m01 and m21/m22 must stay killed after R-O1 (the tests use orders R-O1 still allows).
- **SC-005** `git diff main -- packages | grep -iE '^[+-].*(stripe|voucher)'` prints nothing. No lockfile, workflow or `package.json` in the diff. No new dependency.
- **SC-006** `grep -rn "retry-after" packages/*/src` hits only HONO's `offerResponse`. `git diff main -- packages/adapter-x402` is empty (discovery unchanged).

## Edge Cases

- A due attempt joined by concurrent copies: one settle call. The copies get `already-settled` / the leader's reason, as today (CF:251-259).
- A due attempt while the bucket is empty → `settle-throttled`. The entry stays. It must not be deleted before the token is taken.
- A due attempt answered row 5 again with a `validAfter` still in the future by our clock (both clocks disagree). Rule: not held again. Next retry is ordinary. Document it.
- `retryAfterS` when `opts.nowS` is given (tests, hono `options.nowS`): uses that clock, not wall time.
- A payer whose first settle hangs: the settle call times out at 10 s and is answered `settle-unconfirmed` (R006, row A9), which releases the reservation. If the release never runs (the runtime cancelled the request), the reservation stops counting after 30 s (R002, row A10).
- `recordHeld` on a key evicted from the ledger LRU starts at 1 (eviction is amnesty, LEDGER header comment).
- R-O1's merged check must not change any sequential test: with nothing in flight `live + 0 >= 3` ⇔ `n >= 3 && now < untilMs`.
- Signing is slow (secp256k1). Loops of 100+ signatures use the 30_000 ms timeout the M1 tests use.

## Assumptions

- "tollbooth#16" is the merged fareseal-pay-lows-2 PR; main `6825c30` is its merge. The repo slug stays `tollbooth`; the product is Fareseal.
- No version bump: entries go under CHANGELOG `2.3.0 — Unreleased`.
- O1–O4 refine ADR-004 ("a payer with repeated fresh failures gets a cooldown") and do not contradict the root `plan.md`, so constitution Art. VII.24 needs no ADR. GATE 0 may overrule this, in which case an ADR task is inserted before T004.
- "Timeout" in the release paths means the settle fetch rejecting (an abort or a runtime timeout). The settle fetch has a 10 s timeout of its own (R006, row A9), and a reservation has a 30 s limit (R002, row A10).

## Open Questions (GATE 0 — each has a stated default; the tasks follow the default unless GATE 0 says otherwise)

- **OQ1 (O4 vs the budget bar).** O4 as Josh approved it ("each nonce costs at most 2 calls") lets a payer whose early payments come due make up to 6 calls per window. Main makes 3 (sequential). L3's honest case (3 served) needs at least 3 due passes, so no O4 variant stays at 3. **Default:** read "one payer cannot take more of the settle budget than on main" as every scenario in SC-003 (plain and concurrent nonces), with the early-nonce-due stream as the one stated exception, bounded at 6 and documented.
- **OQ2 (O2 variant).** **Default (c): held only**, by the prompt's fewest-strings-and-headers rule. Alternative (b) also puts `retry-after: 1` on `settle-throttled` (the bucket refills one token in <= 0.2 s). It is a one-line follow-up if Josh wants it.
- **OQ3 (O1 variant).** **Default (b), reuse `payer-cooldown`, reserve for every payer.** Cost: an honest payer sending a 4th concurrent payment is refused with a text that says "after repeated failures", and an offer is recorded (an agent sending 7+ at once from one wallet could hit the maze before its paid ones land). Alternative (c) reserves only when the payer has a live failure. It costs no honest payer anything, but a fresh payer's first burst still reaches 20 calls.
- **OQ4 (N for O3).** **Default 60**, as a constant (see R-O3).

## Out of Scope

- Any Stripe code (`packages/adapter-stripe/**`, `packages/core/src/voucher.ts`). No Stripe line is removed.
- A new config key, a new dependency, a refactor of `makeSettlingVerify` beyond the rules above. (The settle timeout was out of scope at first and is now in scope: the 10 s timeout is R006 and the 30 s reservation limit is R002, rows A9 and A10.)
- x402 discovery shapes (`buildOffer`, `x-payment-required`, `accepts`), receipts and signed bytes, CLI exit codes.
- Live facilitator, workerd or Pages measurements, deploys, npm publish, merges (owner).
