# Second review 2: TunnelMind/tunnelmind-site#118 (site-pay-vendor-1)

VERDICT: FAIL for 06ceb071d0a85268cbcfafca9c2c9f83af3ddece, on wording only.
No HIGH. No code finding above LOW. The clock-tolerance wording is now correct. One other
sentence in the closeout's first paragraph still claims more than the code does (M-1), and the
PASS rule given to me counts that as a fail. The fix is one sentence in closeout.md; no code,
vendor/ or public/ change is needed.

Head confirmed 06ceb07. Nothing changed, committed, pushed, merged or deployed. No call to a
facilitator, wallet, Stripe, Cloudflare or tunnelmind.ai. Worktree and crewbase-fareseal clean
after the review.

## Findings

### MEDIUM M-1 (wording, owner-facing): "our own settle failures no longer burn the payer's payment or cooldown" is wider than the code
- Where: specs/004-site-pay-vendor-1/closeout.md:1 (last clause). Code: vendor/fareseal-cloudflare/dist/index.js:212-224.
- What the code does: only six conditions are treated as ours (data-api non-2xx, `retryable`,
  `settlement-not-configured`, `network-mismatch`, `verify-error:`/`settle-error:`,
  `(verify|settle)-failed(5xx)`, lines 212-218). Everything else is cached for the nonce and
  counted toward the payer's cooldown (lines 220-224).
- Case A, not in the eight lows: the facilitator refuses US (HTTP 401 or 403 on our CDP key, 429
  on our quota). data-api answers HTTP 200 `settled:false` with reason `verify-failed(401)` /
  `verify-failed(429)` / `settle-failed(403)` (data-api api/routes/fareseal-settle.js:106-107,
  116-117; api/lib/x402/facilitator.js:77 returns the status, it does not throw). The regex at
  index.js:218 matches 5xx only, so the site caches the payment and counts the failure.
  Measured in my copy for each of the three reasons: same X-PAYMENT twice = 1 settle call, both
  402 "settle failed"; then fresh payments from the same payer: two more 402 "settle failed",
  then "payer cooling down after repeated failures; retry later" (3 settle calls in total).
  So an operator fault of this kind still burns the payer's payment (in this isolate) and puts
  the payer in the 10-minute cooldown. Same as the old vendor, so not a regression; the
  sentence says it no longer happens.
- Case B, already LOW-4: a settle whose answer is lost (`settle-error:` after the 10 s timeout,
  or a data-api 5xx after the facilitator settled) is "retryable", the retry finds the nonce
  spent, and the payer has paid without being served. The payment is burned in the plain sense.
- Row 4 of the closeout table and spec.md:35 are accurate (they list the six conditions). Only
  the first paragraph generalises.
- Smallest fix (docs only): replace the clause with what row 4 says, for example: "settle
  failures the site classes as ours (data-api non-2xx, `retryable`, not configured, network
  mismatch, facilitator transport errors and 5xx) are no longer cached and no longer count
  toward the payer's cooldown; a facilitator 401/403/429 is still counted against the payer,
  and a settle whose answer is lost still costs the payer (LOW-4)". Add Case A to the lows list
  as LOW-9, upstream (Fareseal): treat `(verify|settle)-failed(401|403|429)` as operator fault.

### LOW L-1: test title repeats the same blanket claim
- test/fareseal-pay-fixes.test.js:137 `describe("US-4 operator faults never burn the payer")`.
  The two cases under it prove HTTP 503 only. Not owner-facing. Fix with M-1 or leave: e.g.
  "US-4 a non-2xx settle is not cached or counted".

### LOW L-2: a whitespace-only transaction id serves
- vendor/fareseal-cloudflare/dist/index.js:186-190 accepts any non-empty string. Measured:
  `{settled:true, tx:" "}` gives 200 and X-PAYMENT-RESPONSE with transaction " ". Only data-api
  (over the service binding) can send it, and data-api sends the facilitator's `transaction`
  (fareseal-settle.js:121). Upstream (Fareseal): require /^0x[0-9a-fA-F]{64}$/ or at least trim.

### LOW L-3: vendored comment still says "accepted"
- vendor/fareseal-core/dist/config.js:54 "Clock drift accepted on a proof's
  validAfter/validBefore". Upstream text; cannot be edited here without breaking the
  byte-identical vendor. Upstream (Fareseal), with LOW-2.

The eight lows of the first review stand unchanged (no code moved).

## 1. The delta
- `git diff 862b91e..HEAD --stat`: 4 files, +107 -5, all under specs/004-site-pay-vendor-1/
  (closeout.md, second-review-862b91e.md (new), spec.md, tasks.md). Nothing in vendor/,
  functions/, public/, src/, test/, package files, wrangler.toml or .github.
- `cd vendor && sha256sum -c SHA256SUMS`: 110 OK, 0 failed. vendor/ holds 113 files: those 110
  plus PROVENANCE.json, README.md, SHA256SUMS.
- Tree hashes: test/vendor-provenance.test.js recomputes all five from disk and passed in my
  clone run (it is one of the 100 files).
- `git diff origin/main...HEAD -- public/`: empty.
- `git rev-list --left-right --count origin/main...HEAD`: 0 behind, 8 ahead.

## 2. The wording
Numbers in the code (vendor/fareseal-adapter-x402/dist/index.js): skew = 60 s default
(vendor/fareseal-core/dist/config.js:55, the site does not set it); validAfter passes when
<= now+60 (:161); validBefore passes when validBefore-now <= 360 (:167); expired when
validBefore < now, no tolerance (:163). Measured through onRequest: validAfter now+55 = 200,
now+66 = 402 "authorization not yet valid" with 0 settle calls; validBefore now+354 = 200,
now+366 = 402 "authorization validity window too long"; validBefore now-2 = 402
"authorization expired".
After the local check: settle call (index.js:158), and a facilitator payer-fault reason is
cached (:220) and counted (:221-224). Measured with reason
`invalid_exact_evm_payload_authorization_valid_after` and validAfter = now+30: same payment
twice = 1 settle call; the third fresh payment from that payer gets the cooldown. Old vendor:
`if (!local.ok) return local` before any cache, so the local not-yet-valid was not cached.

Statement by statement:
- closeout.md:1, clock clause ("local check now tolerates validAfter up to 60 s ahead and
  validBefore up to 360 s ahead ... depends on the facilitator, not tested here ... cached and
  counts toward the payer's cooldown, where the old vendor's local reject was not cached"): TRUE.
- closeout.md row 3 and spec.md:34 (same text, "passes the site's local check"): TRUE.
- spec.md:49-50 (US-3 title, AC-3.1 "settle that succeeds (stubbed) ... proves the local check
  only"): TRUE.
- test/fareseal-pay-fixes.test.js:128-129 ("US-3 clock skew", "AC-3.1 validAfter = now+1,
  validBefore = now+301 -> 200"): TRUE of the stubbed test; makes no end-to-end claim.
- tasks.md:29 (R001 line): TRUE.
- No remaining "are accepted" / "wallet clocks ... fast" claim anywhere in the branch diff
  outside the embedded first-review report (which quotes the old sentence as the finding) and
  the R001 task line (which quotes it as the thing to fix). plan.md and vendor/README.md make
  no clock claim.
- The wording does not now under-claim: the validBefore half is described as a local check
  too, which is the safe side.

Other headline claims in closeout.md:1:
- "X-PAYMENT-RESPONSE now carries the transaction id": TRUE. index.js (cloudflare) :186-190
  reads `transaction` or `tx`, :205 returns it, vendor/fareseal-hono/dist/index.js:716-722
  writes it. Measured: tx "0xTX" arrives in the header.
- "a rejected X-PAYMENT gets its reason in the 402 `error`": TRUE. hono index.js:489-493, table
  :398-432 (fixed strings; a facilitator reason only if it matches ^[a-z0-9_]{1,64}$).
- "our own settle failures no longer burn the payer's payment or cooldown": OVERCLAIM, see M-1.

## 3. The lows list (closeout "Known lows from the second review")
All eight are present, in order, none dropped, none softened in substance. Upstream marking:
LOW-1 upstream (correct), LOW-2 upstream (correct), LOW-3 upstream (correct), LOW-4 data-api,
not Fareseal (correct, matches the report), LOW-5 upstream (correct), LOW-6 this repo's CI
(correct), LOW-7 this repo (correct), LOW-8 upstream (correct). Two notes, neither a finding:
LOW-1's one-liner leaves out the measured effect (20 settle calls where the old vendor stops
at 3; the per-isolate settle bucket can be held empty); LOW-7's leaves out that a bad toll
config is now a 500 on tolled paths. Both are in the embedded report.

## 4. Spot checks on the payment path (my own reading and probes)
(a) Serve condition. vendor/fareseal-cloudflare/dist/index.js:183 `data.settled === true`
(strict) and :186-191 a non-empty string `transaction` or `tx`; only then `ok:true` (:201-206).
vendor/fareseal-core/dist/pipeline.js:178 `if (paid.ok)` is the single gate to "paid". Measured
402 for: settled "true", 1, [true]; tx 123, "", {}, ["0xTX"], true, null; body data null, [],
"x", 7; top-level settled without the data envelope; `data:"settled"`; non-JSON 200; empty 200;
a binding that throws. Only defeat found: tx " " (L-2). Exception paths: index.js:132-133
(nonce re-parse and BigInt) run outside the try, and a throw there would reach the fail-open
catch at hono index.js:752; I could not construct one, because verifyProof (:171, same bytes
through hexToBytes) has already rejected any nonce that is not even-length hex of at most 32
bytes.
(b) Same authorization twice. Tracked in `seenPayments` (index.js:114), key payer:normalised
nonce (:133), checked at :134-136 before any settle, written at :199 on success; concurrent
copies wait on `inflight` (:137-145) and never get ok:true. Measured: second attempt, another
path, and a re-encoded copy (upper-case nonce, extra field) all 402 "nonce already used" with
no further settle call; three concurrent copies on two paths = one 200, two 402, one settle
call. Operator fault then success then replay: 402, 200, 402 with 2 settle calls. The map is
per isolate, cap 512 (:60-67); beyond that the guard is the facilitator (not determinable here).
(c) Catch blocks on the toll path.
- adapter index.js:125, :150, :173: return fail(...). No serve.
- cloudflare index.js:181 `.catch(() => null)`: non-2xx body only; falls to :212 retryable 402.
- cloudflare index.js:227: `settle-unreachable`, ok:false. No serve.
- core pipeline.js:153: voucher decode; falls through to spendVoucher, not to a pass.
- hono index.js:581: exists() threw; continues to the offer, not to content.
- hono index.js:644, :649: receipt emission only.
- hono index.js:752 and cloudflare index.js:461-471: the two pre-existing fail-OPEN catches
  (any throw in toll logic serves the page). Unchanged except the added ConfigError rethrow
  (:468-469). I found no request input that reaches them on the payment path (see (a)).
- functions/_middleware.js:169: header pass only; returns the toll's own response.
(d) Checks before serving, all in verifyProof, which runs first (cloudflare index.js:122-124):
network adapter index.js:138; payTo :140; amount :153; validity :161-168; asset and chain via
the EIP-712 domain :68 (a signature for another token or chain fails recovery); signer
:171-177. Settle is called only after these (:158), content only after settle.

## 5. Tests
- `git archive` copy, `npm ci` rc 0, `npm test` rc 1: the script stops before vitest with
  "fatal: not a git repository" (`git rev-parse --is-shallow-repository`). That is the copy
  having no history, not the branch.
- Same node_modules in a `git clone` of the worktree at 06ceb07: `npm test` rc 0,
  100 files passed, 1159 tests passed, 16 skipped (1175). Same counts as the closeout.
- My probe file (8 tests, in the copy only): results quoted above.
- Both copies removed.

## Could not determine
- What the CDP facilitator returns for a future validAfter, and whether it answers 401/403/429
  with or without an `invalidReason` body field (M-1 Case A assumes none, per
  fareseal-settle.js:107).
- Whether the deployed data-api matches the clone I read (crewbase-tunnelmind-data-api ed545f6).
- Cross-isolate replay refusal (rests on the facilitator). Unchanged by this PR.
- I did not rebuild Fareseal 514bb79 again; vendor/ is byte-unchanged since 862b91e (delta is
  docs only and the hashes verify), so the first review's rebuild still covers it.
