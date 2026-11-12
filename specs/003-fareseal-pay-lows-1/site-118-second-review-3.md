# Second review 3: TunnelMind/tunnelmind-site#118 (site-pay-vendor-1)

VERDICT: FAIL for f69e0840795f363d77d0e03e2746ab94e329c0dd, on wording only.

The delta is docs-only and the code the first review passed is byte-unchanged. The R002 rewrite of
the settle-failure clause is correct and matches the code exactly. No HIGH. One MEDIUM: the
rollback command as written does not run on this repo's merge commits (M-1). The PASS rule given
to me ("no owner-facing sentence overclaims or is false") counts that as a fail. Fix is one
sentence in closeout.md (and the same sentence in plan.md); no code, test, vendor/ or public/ change.

Head confirmed f69e084. Nothing changed, committed, pushed, merged or deployed. No call to a
facilitator, wallet, Stripe, Cloudflare or tunnelmind.ai. Worktree clean after the review.

Path shorthand: CF = vendor/fareseal-cloudflare/dist/index.js, HONO = vendor/fareseal-hono/dist/index.js,
AD = vendor/fareseal-adapter-x402/dist/index.js, CFG = vendor/fareseal-core/dist/config.js,
PIPE = vendor/fareseal-core/dist/pipeline.js, MW = functions/_middleware.js.

## 1. The delta
- HEAD = f69e0840795f363d77d0e03e2746ab94e329c0dd; `git status --short` empty.
- `git diff 06ceb07..HEAD --stat`: 3 files, +178 -2, all under specs/004-site-pay-vendor-1/
  (closeout.md 8 lines, second-review-06ceb07.md new, tasks.md +1). Nothing in vendor/, functions/,
  public/, src/, test/, package files, wrangler.toml, .github.
- `git diff 862b91e..HEAD --stat`: 5 files, all under specs/004-site-pay-vendor-1/ (closeout.md,
  the two review files, spec.md, tasks.md). Code byte-unchanged since the first review's PASS.
- `cd vendor && sha256sum -c SHA256SUMS`: 110 OK, 0 failed.
- `git diff origin/main...HEAD -- public/`: empty. Behind origin/main: 0; ahead: 10.

## 2. Owner-facing claims

| # | Where | Claim | Verdict | Code |
|---|---|---|---|---|
| 1 | closeout:1 | X-PAYMENT-RESPONSE now carries the transaction id | TRUE (stubbed settle only; see L-4) | CF:186-190, 205; HONO:716-722; data-api clone ed545f6 fareseal-settle.js:121,130 sends `tx` |
| 2 | closeout:1 | a rejected X-PAYMENT gets its reason in the 402 `error` | TRUE when the answer is a 402 (see L-1) | HONO:489-493, 418-432, 726, 737 |
| 3 | closeout:1 | local check tolerates validAfter up to 60 s ahead, validBefore up to 360 s ahead | TRUE | CFG:55; AD:160-162, 167; AD:86 (300) |
| 4 | closeout:1 | whether it settles depends on the facilitator, not tested here; a facilitator not-yet-valid reject is cached and counted; old local reject was not cached | TRUE | CF:122-124 (local reject returns before any cache), CF:220-224 |
| 5 | closeout:1 | settle failures classed as ours (data-api non-2xx, `retryable`, settlement not configured, network mismatch, facilitator transport errors and 5xx) are no longer cached and no longer counted | TRUE; the list equals the six conditions, no more, no fewer (5xx part: see L-3) | CF:212-219 return before CF:220-224; old vendor had no such return (git diff f3e778e) |
| 6 | closeout:1 | a facilitator 401, 403 or 429 on our key or quota is still cached and counted (LOW-9) | TRUE | CF:218 matches 5xx only; CF:220-224; data-api fareseal-settle.js:107,117 answers HTTP 200 with the reason |
| 7 | closeout:1 | a settle whose answer is lost still costs the payer (LOW-4) | TRUE (by reading; not testable offline) | CF:212-219, 227-229, then 220-224 on the retry |
| 8 | closeout:19, spec:32 | settle route answers `tx`; after the change the header carries the id | TRUE | as row 1 |
| 9 | closeout:19, spec:32, spec:41 | old vendor: X-PAYMENT-RESPONSE "has no `transaction`" / "`transaction` is absent" | FALSE in detail, about the OLD vendor only (L-2) | f3e778e HONO:675 `transaction: payment.transaction ?? ""`: the field is present and empty |
| 10 | closeout:19, spec:32 | settled:true with neither name stays 402 `settle failed: no transaction id` | TRUE (also cached for the nonce, payer not counted) | CF:191-197; HONO:410 |
| 11 | closeout:20, spec:33 | a rejected X-PAYMENT gets a reason "from a fixed table" | OVERCLAIM, low (L-1) | HONO:429-430 passes a facilitator reason through as `facilitator rejected: <reason>`; HONO:431 generic fallback |
| 12 | closeout:20, spec:33 | with no X-PAYMENT, `error` stays `X-PAYMENT header is required` | TRUE | HONO:489-493 |
| 13 | closeout:21, spec:34 | validAfter +60 / window 300+60 pass the local check; before, refused; `expired` unchanged; offers still advertise 300 | TRUE | AD:160-168; AD:105, 86; old strict checks in git diff f3e778e |
| 14 | closeout:22, spec:35 | the six conditions are not cached and not counted | TRUE | CF:212-219 |
| 15 | closeout:22, spec:35 | "The same X-PAYMENT can be retried" | TRUE at the settle step (AC-4.1 proves 503 only); limits are LOW-4, LOW-5 and the settle bucket | CF:219 (no remember); CF:150-155; PIPE:188-196 |
| 16 | closeout:23 | unknown network is a ConfigError; createPagesMiddleware rethrows it; site network is the constant "base", so no live request changes | TRUE | CFG:48,52; CF:468-469; MW:94 |
| 17 | closeout:75 | a human visitor sees nothing different | TRUE | PIPE:137-138 (humans pass before payment logic) |
| 18 | closeout:71 | no Pages variable or binding change needed | TRUE at this head for the site (MW:74-101 sets no skew key; CFG:55 default); the Fareseal range grep rests on the first review |
| 19 | closeout:168, plan:70 | "`git revert <merge-commit>` on main redeploys the previous vendor" | FALSE as written (M-1) | main is two-parent merge commits (f3e778e, d0b6922, 93f6c4b ...); .github/workflows/post-deploy-check.yml:71-73 uses `-m 1` for this reason |
| 20 | closeout:168 | no Pages variable, binding or data-api state involved; cached payments vanish with the isolates | TRUE | CF:114-115 (Maps in the closure, per isolate) |
| 21 | closeout:175 | check 2: /research unpaid gives `X-PAYMENT header is required` | TRUE, would pass | HONO:493; scripts/data/routes.mjs:26 (not an alias); curl is an anonymous agent, never mazed (PIPE:188) |
| 22 | closeout:176 | check 3: `X-PAYMENT: x` gives `malformed X-PAYMENT header`; old vendor gives `X-PAYMENT header is required`; proves the new vendor is live | TRUE, would pass | AD:122-127; HONO:399, 489-493; old HONO had the constant string |
| 23 | closeout:177-178 | checks 4 and 5: /data equal to the pre-merge probe; x402.json byte-identical | TRUE, would pass | test/toll-402-shape.test.js (no volatile field); public/ not in the diff |
| 24 | closeout:180 | no real payment can be checked; rows 1, 3, 4 proven only by tests | TRUE | - |
| 25 | closeout:120-129 | 100 files, 1159 passed, 16 skipped | TRUE | my run, same counts |

## Findings

### MEDIUM M-1 (wording, owner-facing): the rollback command does not run on a merge commit
- Where: specs/004-site-pay-vendor-1/closeout.md:168 (same sentence in plan.md:70).
- Every PR on main lands as a two-parent merge commit (`git log --merges origin/main`: #113 to #117).
  `git revert <merge-commit>` without `-m 1` stops with "is a merge but no -m option was given".
  The repo's own workflow knows it: .github/workflows/post-deploy-check.yml:71-73. The revert also
  only deploys once it is on main, which is a merge and needs the owner's word. The rollback was
  not exercised.
- Replacement for the first sentence of the Rollback section:
  "`git revert -m 1 <merge-commit>` (the PR lands as a two-parent merge commit; without `-m 1` git
  refuses), landed on main by a PR, redeploys the previous vendor (`1b566a6` bytes) through
  `deploy.yml`; merging that revert PR is itself a deploy and needs the owner's word. If
  `post-deploy-check.yml` fails it opens the revert PR itself. The rollback was not exercised here."
  Keep the next two sentences as they are.

### LOW L-1: "from a fixed table" is narrower than the code (closeout.md:20, spec.md:33)
- HONO:429-430: a data-api reason matching ^[a-z0-9_]{1,64}$ is echoed as
  `facilitator rejected: <reason>` (the likely text for a real facilitator reject, e.g.
  insufficient_funds); HONO:431: anything else is `payment rejected`. A Web-Bot-Auth verified agent
  on its 4th unpaid attempt in 10 minutes gets a 302 to the maze with no reason (LOW-5, PIPE:188-191).
- Replacement: "A presented and rejected `X-PAYMENT` that is answered with a 402 gets a reason in
  the body's `error`: a fixed string for local and operator-fault rejects (e.g. `authorization
  expired`, `nonce already used`), `facilitator rejected: <reason>` when the settle route passes on
  a facilitator reason matching `^[a-z0-9_]{1,64}$`, otherwise `payment rejected`. With no
  `X-PAYMENT`, `error` stays `X-PAYMENT header is required`."

### LOW L-2: the old vendor's header is described wrongly (closeout.md:19, spec.md:32, spec.md:41)
- Old vendor (f3e778e HONO:675) writes `transaction: ""`; the field is present and empty, not absent.
- Replacement (row 1): "Today a paying agent gets a 200 whose `X-PAYMENT-RESPONSE` has an empty
  `transaction` (\"\"); after the change it carries the on-chain id."
  Replacement (AC-1.1 tail): "On the old vendor `transaction` is the empty string (red)."

### LOW L-3: "facilitator ... 5xx" holds only for the reason string the site matches (closeout.md:1)
- CF:218 matches the text `(verify|settle)-failed(5xx)`. data-api (clone ed545f6,
  fareseal-settle.js:107,117) sends that text only when the facilitator's 5xx body has no
  `invalidReason` / `errorReason`; if it has one, that reason is sent with HTTP 200 and the site
  caches and counts it. Row 4 is exact (it quotes the pattern); the first paragraph is plain words.
- Replacement for the parenthesis: "(data-api non-2xx, `retryable`, settlement not configured,
  network mismatch, facilitator transport errors, and a facilitator 5xx that data-api reports as
  `(verify|settle)-failed(5xx)`)".

### LOW L-4: the first clause reads end to end but is proven on a stubbed settle (closeout.md:1)
- The caveat is at closeout.md:32 and :180, not in the paragraph the owner reads first. The clock
  clause has its own caveat; this one does not.
- Replacement: "a paying agent's X-PAYMENT-RESPONSE now carries the transaction id (proven against
  a stubbed settle; no real payment has been made, and a settle answer with no id is now a cached
  402 instead of a 200)".

### LOW L-5: nits
- closeout.md:175-176: `curl -s` prints no status, so "-> 402" is not shown by the command; add
  `-w '\n%{http_code}\n'` as the pre-merge probe line does.
- closeout.md:22 cites CF:208-219 and :220-221; the condition is :212-219 and the cache and count
  are :220-224.
- closeout.md:5 status line names T001-T004 only; R001 and R002 are also done.

## 3. The lows list (closeout.md:147-160)
LOW-1 to LOW-9 and L-1 to L-3 are all present, in order, none dropped, none softened.
- LOW-1 to LOW-8 match second-review-862b91e.md; marking correct (1, 2, 3, 5, 8 upstream Fareseal;
  4 data-api; 6 and 7 this repo).
- LOW-9: accurate (CF:218, 220-224); "same as the old vendor, not a regression" is true (the old
  vendor cached and counted every settled:false); upstream is correct.
- L-1: test/fareseal-pay-fixes.test.js:137 has that title; its two cases use status 503 only. This repo. Correct.
- L-2: CF:186-190 accepts any non-empty string. Upstream. Correct.
- L-3: CFG:54 says "Clock drift accepted". Upstream. Correct.
- The source line (closeout.md:147) attributes each low to the right review file.

## 4. Tests
`git clone` of the worktree at f69e084, `npm ci` rc 0, `npm test` rc 0: 100 files passed,
1159 tests passed, 16 skipped (1175). Same counts as the closeout. Clone removed.

## What I ran
- git rev-parse, status, diff --stat (06ceb07..HEAD, 862b91e..HEAD), diff origin/main...HEAD -- public/,
  rev-list counts, log --merges; sha256sum -c in vendor/.
- Read closeout.md, spec.md, tasks.md and both earlier review files in full; the vendored dist
  ranges cited above; functions/_middleware.js; git diff f3e778e..HEAD for the cloudflare, hono and
  adapter dist; deploy.yml, post-deploy-check.yml; test/toll-402-shape.test.js and its fixture;
  data-api clone /home/o2k/crewbase-tunnelmind-data-api (ed545f6) fareseal-settle.js and facilitator.js (read-only).
- npm ci and npm test in a temp clone, then removed it. No probe file written; the two earlier
  reviews measured the payment path and the code is byte-unchanged.

## Could not determine
- Whether the deployed data-api matches the clone at ed545f6 (it decides rows 1, 6 and L-3).
- What the CDP facilitator puts in a 401/403/429/5xx body, and what it answers for a future validAfter.
- The live Pages variables and live answers; the post-deploy checks are the test.
- Whether the PR will be merged as a merge commit (the last five were); if it were squashed, the
  rollback command would run as written.
