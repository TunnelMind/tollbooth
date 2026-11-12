# fareseal-pay-lows-1 - independent second review (GATE R)

Commit 36c4f8771167ba77bd2cf67ab818d85023bced78, branch crew/fareseal-pay-lows-1, base origin/main 514bb79.
Reviewed 2026-11-11. Read-only: the worktree is unchanged (clean, HEAD still 36c4f87). All builds, probes and
mutants ran in temp copies (/home/o2k/.crew/coord/review-tmp/fspay and fspay-main), both removed afterwards.
No network call to any facilitator, wallet, Stripe, Cloudflare or live site; settle was always a local stub.

## Verdict

PASS for 36c4f87. No HIGH, no MEDIUM. 9 LOW findings (L1-L9) and 4 test gaps (surviving mutants).

## What changed (file:line at 36c4f87)

- F1 packages/cloudflare/src/index.ts:311-347 (rows 3, 4, 6/7; `!resp.ok ||` removed, regex gains 401|403|429 at :325,
  row 4 at :330). packages/hono/src/index.ts:613-625 (paymentError uses core isOperatorFault). packages/core/src/pipeline.ts:96-115.
- F2 packages/adapter-x402/src/index.ts:214 (MAX_X_PAYMENT_CHARS = 8192), :228 (`xPayment.length > MAX` -> malformed, first
  statement of verifyProof, before atob/JSON.parse).
- F3 packages/cloudflare/src/index.ts:335-336 (`reason.includes("valid_after")` -> `not-yet-valid`, no remember, no count).
- F4 packages/cloudflare/src/index.ts:286 (`if (resp.ok && data.settled === true)`).
- F5 packages/cloudflare/src/index.ts:290-293 (first of [transaction, tx] that, trimmed, matches /^0x[0-9a-fA-F]{64}$/).
- F6 packages/core/src/pipeline.ts:351-353 (operator fault at step 6 returns the offer before the step-7 consequence
  check and the step-8 recordOffer). VerifyPayment result gains optional `reason` (:93-94).
- F7 packages/core/src/config.ts:59-62 (comment only).
- F8 closeout.md "F8 - follow-up (LOW-4)": recorded, not built.

## Reconstructed classification table (from the code, every row measured through the middleware)

Serve condition (exact): `resp.ok && data.settled === true` AND a trimmed string in `data.transaction` (first) or
`data.tx` matching `^0x[0-9a-fA-F]{64}$`. Everything else is 402.
"Offer recorded" = counts toward the maze for a verified agent (core isOperatorFault false).
OPF = "settlement unavailable (operator fault); retry the same payment".

| Settle outcome | Served | Cached for nonce | Counted to cooldown | Offer recorded | 402 `error` |
|---|---|---|---|---|---|
| X-PAYMENT > 8192 chars (no settle call) | no | no | no | yes | malformed X-PAYMENT header |
| no settle token (0a) | no | no | no | no | OPF |
| settle bucket empty (0b) | no | no | no | no | OPF |
| transport throw (0c) | no | no | no | no | OPF |
| 2xx non-JSON body, 204 empty (0c) | no | no | no | no | OPF |
| timeout | NOT CLASSIFIED: the settle fetch has no timeout (index.ts:259); the request hangs until the runtime ends it (pre-existing) |
| 2xx settled:true + valid id (1) | YES | yes (already-settled) | cleared | no (recordPaid) | - |
| 2xx settled:true, id missing/""/" "/number/array/object/null/63 hex/65 hex/no 0x/`0X` prefix/inner newline (2) | no | yes (no-transaction-id) | no | YES | settle failed: no transaction id |
| 2xx settled:true + valid id + retryable:true | YES (row 1 wins) | yes | cleared | no | - |
| 2xx settled:"true" or 1 (not === true) | no | yes | yes | yes | settle failed |
| 2xx JSON without data ({}, [], null, data:null, data:"x") | no | yes | yes | yes | settle failed |
| any status, data.retryable === true (3) | no | no | no | no | OPF |
| any status, reason settlement-not-configured / network-mismatch (3) | no | no | no | no | OPF |
| any status, reason starts verify-error: / settle-error: (3) | no | no | no | no | OPF |
| any status, reason exactly (verify|settle)-failed(5xx|401|403|429) (3) | no | no | no | no | OPF |
| HTTP 5xx (500-599 measured: 500,502,503,504,520,599), 401, 403, 429, any body incl. settled:true (4) | no | no | no | no | OPF |
| 2xx or other-4xx, reason contains `valid_after` (5) | no | no | no | YES | authorization not yet valid |
| 5xx/401/403/429 with a valid_after reason | row 4 wins: operator |
| 2xx settled:false, reason (verify|settle)-failed(400|402|404...) (6) | no | yes | yes | yes | settle failed |
| 2xx settled:false, other [a-z0-9_]{1,64} reason, e.g. insufficient_funds, ..._valid_before (6) | no | yes | yes | yes | facilitator rejected: <reason> |
| 2xx settled:false, reason missing or non-string (6) | no | yes | yes | yes | settle failed |
| 2xx settled:false, reason is a near-miss of an operator pattern ("xsettle-failed(500)", "settle-failed(500) x", "foo settle-failed(500)", trailing newline, "x verify-error: y") (6) | no | yes | yes | yes | payment rejected |
| 2xx settled:false, retryable:"true" (string) | row 6: payer |
| 2xx settled:false, reason = settle-throttled / settle-unreachable / settle-retryable / settlement-unconfigured | no | YES | YES | NO | OPF  <- code disagrees with itself, see L5 |
| HTTP 400,402,404,405,408,409,413,422,425,451,499 and 301, any body incl. settled:true + valid id (7) | no | yes | yes | yes | settle failed (or facilitator rejected: <data.reason>) |

Compared with the README table (packages/cloudflare/README.md:73-84): rows 0a-7 all match the code and each has a test.
Disagreements / silences:
1. README has no row for a 2xx JSON body without `data.settled` ({}, null, []): code makes it a payer fault (cached,
   counted). Only "settled:false with no reason" is tested; the bodyless shapes are not. Same on main.
2. README row 6 says a 2xx settled:false with "any other reason" is a payer fault. For the four reasons in L5 the
   cloudflare half agrees (cached, counted) but core/hono treat it as operator fault. No test.
3. README does not mention timeout (none exists) or 3xx (lands in row 7).
4. README has no "offer recorded" column; `not-yet-valid` and `no-transaction-id` both DO record an offer (L3, L4).

## Attacks on F1

- Client causes operator-fault class (free retries)? Not through the header any more. Measured, 30 sequential
  requests in one isolate, settle calls:
  - oversize header (9980 chars): main 20 -> new 0.
  - same payment, settle HTTP 400: main 20 -> new 1. Fresh nonces, one payer, HTTP 400 or 404: main 21 -> new 3 then cooldown.
  - same payment on HTTP 503 / HTTP 429 / 200 verify-failed(429): 20 (bucket bound; 503 and 429 unchanged from main,
    verify-failed(429) was 1 on main: specified).
  Remaining client levers into the operator class: making OUR settle route or facilitator answer 5xx/429 (flooding to
  the rate limit, or an input the facilitator 500s on: not determinable here), or a WAF 403 in front of the route.
  All bounded by the isolate bucket (20 burst + 5/s), not by the payer cooldown. By design.
- Regex anchoring: both regexes are anchored (index.ts:325, pipeline.ts:114). Measured: "xsettle-failed(500)",
  "settle-failed(500) x", "foo settle-failed(500)", "settle-failed(500)\n", "x verify-error: y" are all payer faults.
  But NO TEST pins this: un-anchoring either regex leaves 632/632 green (mutants F1f, F1g).
- 429: settle-route HTTP 429 -> row 4 operator; facilitator `(verify|settle)-failed(429)` -> row 3 operator. As specified, tested.
- Our own credential refused: settle-route 401/403 -> operator; facilitator 401/403 reported as -failed(401|403) -> operator. As specified, tested.
- Payer blamed for our fault: see L1.

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW

L1. A settle-route 4xx that only the operator can cause is now a payer fault. packages/cloudflare/src/index.ts:337-347.
  Read against the real settle route (tunnelmind-data-api 242908d, api/routes/tollbooth-settle.js): its 4xx answers are
  400 body-not-JSON, 400 payment empty or > 8192, 400 bad base64/JSON, 422 not an x402 exact payload, 400 `price_usd out
  of bounds`. After F2 the edge already refuses every client-caused one locally (same 8192 bound, same atob, stricter
  shape check), so against that route the ONLY reachable 4xx are ours: `price_usd` outside (0, $10] or more than 6
  decimals (400), a wrong settle.url (404), a wrong method/route (405).
  Scenario: operator sets `price_usd = "12"` (or a bad settle.url). 1) An honest payer sends a valid payment. 2) Route
  answers 400. 3) Payment cached `settle-failed`, payer counted; after 3 payments a 10-minute cooldown; text is
  "settle failed", not "retry the same payment". 4) A verified agent doing this is mazed on the 4th attempt (measured
  402,402,402,302,302 on HTTP 400) - the case F6 exists to prevent.
  Loss: payers wrongly cooled down and wrongly mazed during our misconfiguration; no money moves (the facilitator is
  never reached). On main this was `settle-retryable`.
  The run flagged the 404 half itself (plan Risks, the ponytail comment at :340). The 400 half is not recorded.
  Smallest fix: none needed for the brief as written (it says 4xx = payer). If wanted: add 404 and 405 to row 4, and
  have the data-api route answer a bad `price_usd` as 200 `settled:false, reason:"settlement-not-configured"` (or 5xx).
  At least record the price_usd case next to the 404 note.

L2. F3 removes the per-payer bound for a deliberately early authorization. packages/cloudflare/src/index.ts:335-336.
  The local check accepts validAfter up to 60 s ahead (measured: now+55 passes, now+62 is refused locally), the
  facilitator then answers `..._valid_after`, and that is neither cached nor counted.
  Measured, 30 sequential requests: the SAME payment causes 20 settle calls (main: 1); fresh nonces from one unfunded
  payer cause 21 (main: 3, then cooldown). The only bound left is the isolate bucket (20 burst + 5/s); one payment is
  good for ~55 s of calls and new ones are free to sign.
  Who loses: facilitator verify quota, and while the bucket is empty every honest payer gets `settle-throttled`.
  Not new in kind (rotating payer keys reached the same bucket bound on main), but it now needs one key and no rotation.
  No replay opened: measured valid_after -> later settled -> replay = 402,200,402 with 2 settle calls; concurrent
  duplicates share one settle call and all get `not-yet-valid`.
  Smallest fix: on a `valid_after` reject remember `key -> validAfter` and answer `not-yet-valid` locally, with no
  settle call, until now >= validAfter (the value is in the payload already); or cap not-yet-valid rejects per payer.

L3. A payer whose payment settled but came back with an unusable id is recorded as ignoring the offer.
  packages/core/src/pipeline.ts:96-102 (`no-transaction-id` is not in the no-offer set), cloudflare index.ts:294-300.
  Scenario: settle route answers 200 settled:true with a malformed/absent id (money may have moved). The payment is
  cached `no-transaction-id`; the payer is told "settle failed: no transaction id" and, if a verified agent, is mazed
  on the 4th retry of the same payment (measured 402,402,402,302,302, 1 settle call). F5 widens the set of ids that land
  here (any non-hash string served on main).
  Loss: a payer who has probably paid is not served and then mazed. Reachable only if the route/facilitator returns a
  non-hash id on success; the CDP facilitator returns a 0x 64-hex hash on Base.
  The "paid, not served" cost is stated in plan.md Risks ("F5 strictness") but NOT in closeout.md.
  Smallest fix: treat `no-transaction-id` like an operator fault in `decide` (no offer recorded), and add the known cost
  to the closeout.

L4. `not-yet-valid` records an offer. A verified agent whose clock runs ahead and who retries as told is mazed on the
  4th attempt (measured 402,402,402,302,302). Specified (FR-004: "not an operator fault for FR-006"); stating it because
  the F3 text says the same payment "can succeed seconds later". Fix if unwanted: add it to the no-offer set.

L5. Two classifiers can disagree. cloudflare index.ts:319-347 vs core pipeline.ts:96-115.
  If the settle route ever answers 200 settled:false with reason `settle-throttled`, `settle-unreachable`,
  `settle-retryable` or `settlement-unconfigured`, cloudflare caches it and counts the payer (row 6) while hono tells
  the payer "retry the same payment" and core records no offer. The retry then hits the cache forever with the same
  text. Not emitted by data-api 242908d. No test.
  Smallest fix: in row 3, test `isOperatorFault(reason)` (import from core) in place of the duplicated list.

L6. F6 lets a non-paying verified agent stay out of the maze while the settle bucket is empty.
  Scenario (measured): an anonymous client drains the bucket with unfunded `validAfter = now+55` payments (not counted,
  L2); a verified agent attaches any fresh locally-valid unfunded payment to each request. Result: 8 of 8 attempts 402,
  never 302, no offer recorded (main: 302 from the 4th). Its unpaid requests still count normally.
  Gain: no maze, no ledgered offer; no content. Cost to us: ~5 facilitator verify calls/s while it lasts.
  plan.md Risks says "the bypass needs our outage"; it also works on a client-induced throttle. LOW because nothing is served.
  Smallest fix: L2's fix removes the cheap drain; or do not treat `settle-throttled` as a no-offer reason.

L7. A non-2xx with settled:true is told "retry the same payment". If money really moved (a 5xx after the settle), the
  retry reaches the route again, the nonce is spent, the answer becomes a cached payer fault. Same class as LOW-4 (F8),
  only reachable if the route returns non-2xx with settled:true; data-api 242908d never does.

L8. Test gaps (mutants that leave 632/632 green):
  - cloudflare reason regex un-anchored (index.ts:325);
  - core isOperatorFault regex un-anchored (pipeline.ts:114);
  - tx-id regex without the leading `^` (index.ts:293): "junk0x<64 hex>" would serve;
  - the size cap moved after atob/JSON.parse (adapter index.ts:228): AC-2.1 "without calling atob or JSON.parse" is unproven.
  Smallest fix: four one-line cases ("x settle-failed(500)" -> payer in both suites; `tx: "zz0x<64hex>"` -> 402; a spy
  on atob for the oversize case).

L9. Pre-existing, not in this diff, for the record: `state = await buildState(...)` (cloudflare index.ts:585-588) lets
  requests that arrive before the first state is assigned each build their own state and their own nonce cache.
  Measured cold: 4 concurrent copies of one payment -> 4 settle calls, 4 x 200 with an always-yes stub. Warm isolate:
  1 settle call, 200,402,402,402. On chain only one can settle, so this is the same exposure as two isolates. Identical on main.

## F2 details

Cap is `xPayment.length > 8192` on the header value as the runtime delivers it (UTF-16 code units; inner whitespace
counts, leading/trailing is stripped by Headers). It runs before any decode. Measured with validly signed payments:
8188, 8191 (unpadded) and 8192 chars -> local ok, 200, 1 settle call; 8193 (8192 + an inner space, which atob accepts and
main served), 8195, 8196, 9980 and 60000 -> 402 `malformed X-PAYMENT header`, 0 settle calls. A real authorization header
is 632 chars. No reflection: the 402 body is 607 bytes for a 60000-char header and contains none of it; response headers
are cache-control, content-type, x-payment-required (385). The data-api route uses the same bound (> 8192).

## F4 / F5 details

- `transaction` wins when valid; an invalid `transaction` with a valid `tx` serves `tx`; both valid and different ->
  `transaction`. Neither can serve on a bad value: only a value that itself matches the hash pattern is surfaced.
- Uppercase hex accepted and surfaced as sent; `0X` prefix refused; whitespace-padded accepted and trimmed in
  X-PAYMENT-RESPONSE; a value with an inner newline refused.
- settled must be boolean true: "true" and 1 are payer faults (cached, counted).
- Refusal text: `settle failed: no transaction id` (row 2), OPF (5xx/401/403/429 + settled:true), `settle failed`
  (other 4xx + settled:true).
- Settled-but-bad-id IS cached (`no-transaction-id`): a later good answer is never fetched (measured 402,402, 1 call).
  Recorded as a risk in plan.md, not in closeout.md (L3).

## Replay and serve-once

Warm isolate, measured: same authorization sequentially on the same path, another path, re-encoded (extra JSON field)
and respelled nonce (0X + uppercase) -> 200,402,402,402,402 with 1 settle call; 4 concurrent (2 paths + re-encoded) ->
200,402,402,402 with 1 settle call; 503 then healthy then replay -> 402,200,402 (2 calls). Nonce-cache semantics differ
from main only where F1/F3/F5 say. Cold-start race: L9 (pre-existing).

## Fail-closed

The settle body (index.ts:258-350) is one try/catch -> `settle-unreachable`; the new code adds no throw outside it
(`reason` is always a string before `.includes`, `data` may be any JSON value without throwing: measured data:null,
data:"x", [], {}). isOperatorFault cannot throw. The two fail-open catches (hono index.ts:1003-1006, cloudflare
index.ts:643-650) are byte-identical to main. No new path from an exception to served content found.

## Compatibility

- Public API: additions only (`isOperatorFault` from core, `MAX_X_PAYMENT_CHARS` from adapter-x402, optional `reason`
  on the VerifyPayment result). Nothing removed or renamed. hono 2.3.0 now imports `isOperatorFault` from core, so a
  vendor refresh must take core and hono together (the site vendors them as a set). No site code change needed.
- Unpaid 402: status, headers and body are byte-identical between main and 36c4f87 (same probe on both trees, no diff).
- Behaviour a vendoring site will see change: the 402 `error` strings for the moved rows (CHANGELOG lists them); any
  site test stubbing a settle with a placeholder id such as "0xTX" will now get 402.
- Versions: all seven packages 2.2.0 -> 2.3.0, CHANGELOG `## 2.3.0 - Unreleased`. No tag on HEAD. Nothing published.
- Stripe: only the `version` field of packages/adapter-stripe/package.json; no Stripe source touched.
- Dependencies: pnpm-lock.yaml not in the diff; `pnpm install --frozen-lockfile` passes; no workflow file changed.

## Revert / mutant table (each applied alone in the copy, full suite, then restored)

| Mutant | Failing tests | Caught |
|---|---|---|
| F1 `!resp.ok ||` restored (all non-2xx operator) | 10: pages-settle "row 7: HTTP 400/404/413/422 ..." (8), "row 7: HTTP 400 settled:true", "row 7: HTTP 422 with a string data.reason" | yes |
| F1 cloudflare reason regex back to 5xx | 6: "row 3: HTTP 200 reason {verify,settle}-failed({401,403,429})" | yes |
| F1 row 4 without 401/403/429 | 10 | yes |
| F1 row 4 removed | 21 | yes |
| F1 row 4 takes 404 | 2 | yes |
| F1 row 4 takes every 4xx | 10 | yes |
| F1 core regex back to 5xx | 4: core "verify-failed(429): four attempts ...", hono TABLE rows settle-failed(401), verify-failed(403), settle-failed(429) | yes |
| F1 cloudflare reason regex un-anchored | 0 | NO |
| F1 core isOperatorFault regex un-anchored | 0 | NO |
| F2 cap removed | 2: x402 "a validly signed payment over 8192 chars is malformed", pages-settle "an X-PAYMENT over 8192 chars is malformed and never settled" | yes |
| F2 `>=` | 1: "exactly 8192 chars passes" | yes |
| F2 constant 8193 | 2 | yes |
| F2 cap moved after decode | 0 | NO |
| F3 branch removed | 2: "row 5 (AC-3.1/3.2) ...", "row 5 (AC-3.3) ..." | yes |
| F3 cached but not counted | 2 | yes |
| F3 counted but not cached | 1: "row 5 (AC-3.3)" | yes |
| F4 `resp.ok &&` removed | 8: F4 describe (2), "row 4: HTTP 401/403/429/500/503 settled:true" (5), "row 7: HTTP 400 settled:true" | yes |
| F5 old any-non-empty-string check | 8: tx " ", "0xTX", 63 hex, 65 hex, no 0x, whitespace-padded, invalid transaction + valid tx, row 2 | yes |
| F5 no trim | 1 | yes |
| F5 regex without `$` | 1 (65 hex) | yes |
| F5 regex without `^` | 0 | NO |
| F5 no-transaction-id not remembered | 10 | yes |
| F6 early return removed | 8: core FR-006 it.each (6), "already-exhausted agent ...", hono "four 402s, no 302" | yes |
| F6 every failed payment skips the ledger | 1: "a payer fault (expired) keeps the consequence after the grace" | yes |
| F6 hono paymentError ignores isOperatorFault | 18 | yes |
| F6 settle-throttled dropped from the set | 2 | yes |
| F6 not-yet-valid added to the set | 3 | yes |

Every fix F1-F6 is caught on revert. Four boundary mutants survive (L8).

## What I ran

- `git rev-parse HEAD` (36c4f87), `git diff origin/main...HEAD` (30 files, +1693 -65), specs 003 spec/plan/closeout, the brief.
- Copy of HEAD: `pnpm install --frozen-lockfile`, `pnpm test` -> 55 files, 632 tests, 632 passed. `pnpm lint` -> 1 warning,
  4 infos, no error. `pnpm typecheck` -> exit 0.
- Copy of origin/main: install + build, for side-by-side probes.
- One probe test file (137 measured lines per tree: 94 classification cases, size cap, 30-request settle counts, replay,
  F6/maze, unpaid 402), run on both trees and diffed.
- 27 mutants, full suite each.
- Read tunnelmind-data-api 242908d api/routes/tollbooth-settle.js (read only) to see which answers the real route gives.

## Could not determine

- The live CDP facilitator's exact not-yet-valid reason string (F3 matches the substring `valid_after`; if the live
  string differs F3 silently does nothing and behaviour is as on main). Not verified by the run either.
- Whether a client-crafted but locally valid payload can make the facilitator answer 5xx (which would be an operator
  fault with bucket-bounded free retries).
- Behaviour when the settle route never answers: there is no timeout on the settle fetch, so it depends on the runtime.
- `bun examples/bun-hono/check.ts` and the bench check were not re-run; CI status for the branch was not checked.
