# Second review 4: TunnelMind/tunnelmind-site#118 (site-pay-vendor-1)

VERDICT: PASS for 86fe347b143bb5af46309af9c85368b34550dd14.

Docs-only delta, code byte-unchanged since the 862b91e PASS, every replacement from
second-review-f69e084.md applied, no HIGH, no MEDIUM. Seven LOWs remain (wording precision; none
changes a deploy or rollback decision). Each has an exact replacement below; none blocks.

Head confirmed 86fe347. Nothing changed, committed, pushed, merged or deployed. No call to a
facilitator, wallet, Stripe, Cloudflare or tunnelmind.ai. Worktree clean after the review.

Shorthand: CF = vendor/fareseal-cloudflare/dist/index.js, HONO = vendor/fareseal-hono/dist/index.js,
AD = vendor/fareseal-adapter-x402/dist/index.js, CFG = vendor/fareseal-core/dist/config.js,
MW = functions/_middleware.js, PDC = .github/workflows/post-deploy-check.yml.

## 1. Delta
- `git diff f69e084..HEAD --stat`: 5 files, +163 -18, all under specs/004-site-pay-vendor-1/
  (closeout.md, plan.md, second-review-f69e084.md new, spec.md, tasks.md).
- `git diff 862b91e..HEAD --stat`: 7 files, all under specs/004-site-pay-vendor-1/ (closeout, plan,
  spec, tasks, three review files). Nothing in vendor/, functions/, public/, src/, test/, package
  files, wrangler.toml, .github.
- `cd vendor && sha256sum -c SHA256SUMS`: 110 OK, 0 failed.
- `git diff origin/main...HEAD -- public/`: empty. Behind origin/main: 0; ahead: 12.

## 2. f69e084 replacements

| Finding | New text (short) | Status |
|---|---|---|
| M-1 closeout.md:168 | "`git revert -m 1 <merge-commit>` (...without `-m 1` git refuses), landed on main by a PR ... needs the owner's word" | APPLIED. One clause added beyond the replacement ("it does not merge it, because `AUTO_MERGE_REVERT` is `'false'` ... line 22 ... line 82"); checked true (PDC:22, PDC:82) |
| M-1 plan.md:70 | same sentence | APPLIED (identical to closeout.md:168) |
| L-1 closeout.md:20, spec.md:33 | "a fixed string for local and operator-fault rejects ..., `facilitator rejected: <reason>` ..., otherwise `payment rejected`" | APPLIED (both); citation column gained `:429-431`, correct |
| L-2 closeout.md:19, spec.md:32, spec.md:41 | "has an empty `transaction` (\"\")"; "is the empty string (red)" | APPLIED (all three) |
| L-3 closeout.md:1 | "and a facilitator 5xx that data-api reports as `(verify|settle)-failed(5xx)`" | APPLIED |
| L-4 closeout.md:1 | "(proven against a stubbed settle; no real payment has been made, and a settle answer with no id is now a cached 402 instead of a 200)" | APPLIED |
| L-5 curl | `-w '\n%{http_code}\n'` on checks 2, 3 and 4 | APPLIED |
| L-5 citations | CF `:212-219` and `:220-224` | APPLIED, correct |
| L-5 status line | "T001-T004 and R001-R003 done" (lines 5 and 11) | APPLIED |

R003's own sweep also changed: row 4 "can be retried at the settle step (limits: LOW-4, LOW-5)";
"The versions are the same in the old and new PROVENANCE ..."; "No real payment is checked after
deploy"; the T005 owner line in the closeout. All four are true.

## 3. Claim audit

| # | Where | Claim | Verdict | Code / evidence |
|---|---|---|---|---|
| 1 | closeout:1 | Merging deploys tunnelmind.ai | TRUE | deploy.yml:3-5 (push to main), :25-35 |
| 2 | closeout:1 | X-PAYMENT-RESPONSE carries the transaction id; stubbed settle; no id = cached 402 instead of 200 | TRUE (see L-G) | CF:186-197, 205; HONO:716-722; old vendor dropped `tx` (git diff f3e778e); test AC-1.1, AC-1.2 |
| 3 | closeout:1 | a rejected X-PAYMENT gets its reason in the 402 `error` | TRUE in the 402 case, loosely worded (L-A) | HONO:489-493, 418-431 |
| 4 | closeout:1 | validAfter up to 60 s, validBefore up to 360 s ahead pass the local check | TRUE | CFG:55; AD:160-162, 167; AD:86 |
| 5 | closeout:1 | facilitator not tested; its not-yet-valid reject is cached and counted; old local reject was not cached | TRUE | CF:122-124 (local return before any cache), CF:220-224 |
| 6 | closeout:1 | the listed operator-fault failures are no longer cached or counted | TRUE | CF:212-219 return before CF:220-224; absent in old vendor |
| 7 | closeout:1 | facilitator 401/403/429 still cached and counted (LOW-9) | TRUE | CF:218 matches 5xx only; data-api clone ed545f6 fareseal-settle.js:107,117 |
| 8 | closeout:1 | a settle whose answer is lost still costs the payer (LOW-4) | TRUE by reading | CF catch -> `settle-unreachable` (not cached), retry is cached and counted |
| 9 | closeout:19, spec:32 | row 1: route answers `tx`; old header has empty `transaction`; neither name = 402 | TRUE | data-api clone :130; HONO:719 `?? ""`; CF:191-197; HONO:410 |
| 10 | closeout:20, spec:33 | row 2: fixed string / `facilitator rejected: <reason>` / else `payment rejected`; no header = `X-PAYMENT header is required` | TRUE, one branch missing (L-A) | HONO:399-431, 489-493 |
| 11 | closeout:21, spec:34 | row 3: +60 / 300+60 pass; before refused; `expired` unchanged; offers advertise 300 | TRUE | AD:160-168, AD:105; old strict checks in git diff f3e778e |
| 12 | closeout:22, spec:35 | row 4: "exactly those six conditions"; retried at the settle step | TRUE (seven tests, grouped as the six items listed) | CF:212-219, 220-224; HONO:397, 416 |
| 13 | closeout:23 | row 5: unknown network = ConfigError; rethrown; network is the constant "base", so no live request changes | TRUE. ConfigError has one source, `parseConfig` (CFG:153,161,165); the only env values in the TOML are shape-checked (MW:63-68, 75-76), so no Pages variable can produce one | CFG:48,52; CF:468-469; MW:94 |
| 14 | spec:36, plan:36, plan:62 | the MW header comment "is corrected" / "the comment fix records it" | FALSE at this head (L-B); disclosed in closeout:23, :164, :196 | MW:12-14 unchanged |
| 15 | closeout:29, 43-53 | the range is 8 commits, maze untouched | TRUE | `git log --oneline 1b566a6..514bb79` in ~/tollbooth's object store: same 8 lines; maze diff empty |
| 16 | closeout:30, 57-65 | commit 514bb79d...; node v22.22.0, pnpm 11.5.1; versions 2.2.0; the ten tree_sha256 values; PROVENANCE absent at f3e778e | TRUE | vendor/PROVENANCE.json; `git show df3fd9b:vendor/PROVENANCE.json`; all ten hashes match; maze equal |
| 17 | closeout:32 | 10 cases through `onRequest`; 9 failed / 1 passed on the old vendor, 10/10 on the new | Numbers TRUE (re-run by me: 9 failed, 1 passed (AC-2.3) on f3e778e vendor bytes; 10 passed on the new). "through onRequest" holds for 9; the T005 case calls `parseConfig` (L-C) | test/fareseal-pay-fixes.test.js:78-161 |
| 18 | closeout:34, 36, 79-116 | 31 files; only four new test paths; no Stripe file, wrangler.toml, MW, package-lock, public/, maze | TRUE | `git diff f3e778e 9901e1b --stat`: 31 files, +802 -69; outside specs/vendor/test: package.json, scripts/vendor-fareseal.mjs |
| 19 | closeout:67 | versions equal, the commit identifies the build | TRUE | both PROVENANCE files |
| 20 | closeout:71 | no Pages variable or binding change; grep prints nothing; skew default 60s, site does not set it | TRUE | grep over `git diff 1b566a6 514bb79`: 0 lines; CFG:55; MW:74-101; CF diff adds no env read |
| 21 | closeout:75 | a human visitor sees nothing different | TRUE | the vendor diff touches only the settle path, the 402 `error` text and the ConfigError rethrow (row 13) |
| 22 | closeout:120-129 | 100 files, 1159 passed, 16 skipped (1175) | TRUE | my run, same counts |
| 23 | closeout:131-143 | build rc 0, public/.well-known unchanged | Not re-run; consistent with `git diff origin/main...HEAD -- public/` empty | - |
| 24 | closeout:147-160 | lows LOW-1..9, L-1..3 | TRUE; L-1 line 137 correct; L-3 CFG:54 correct. Does not say where review 3's findings went (L-D) | - |
| 25 | closeout:164 | MW lines 12-14 still say fails OPEN; editing MW moves x402.json `updated_at` | TRUE | MW:12-14; scripts/build-x402.mjs:17-28 lists `functions/_middleware.js` as an input |
| 26 | closeout:168, plan:70 | `git revert -m 1 <merge-commit>`, landed by a PR, redeploys the previous vendor through deploy.yml; itself a deploy | TRUE if the PR lands as a merge commit (#110 to #117 all did; a squash merge would make `-m 1` fail) (L-E) | deploy.yml:3-5; `git log --first-parent origin/main` |
| 27 | closeout:168 | PDC failure opens the revert PR itself and does not merge it; line 22; line 82 | TRUE | PDC:22, 60-82 (`-m 1` at :73) |
| 28 | closeout:168 | not exercised; no Pages variable, binding or data-api state; isolate caches vanish | TRUE | CF:114-115 (Maps in the closure) |
| 29 | closeout:172-178 | the five checks and what each prints | TRUE; commands run as written (`-w` prints the status). Check 3 distinguishes old from new | AD:122-127; HONO:399, 489-493; old HONO constant string |
| 30 | closeout:180 | rows 1, 3, 4 proven only by tests | TRUE | - |
| 31 | closeout:201 vs tasks:26 | T005 owner line | closeout TRUE; tasks.md:26 keeps the older, shorter wording (L-F) | - |

Internal consistency: first paragraph, table and lows list agree with each other. No absolute
left in closeout.md that the code contradicts.

## Findings (all LOW; none blocks the merge)

### L-A row 2 leaves out one branch (closeout.md:20, spec.md:33; first paragraph)
HONO:423-425: a facilitator HTTP-status reason (`verify-failed(401)`, `settle-failed(429)`) gives the
fixed string `settle failed`, not `payment rejected`. The row's "otherwise" reads as if it did.
Replacement for the middle of row 2: "a fixed string for local, cached and operator-fault rejects
(e.g. `authorization expired`, `nonce already used`), `settle failed` for a facilitator HTTP 4xx
reported as `(verify|settle)-failed(4xx)`, `facilitator rejected: <reason>` when the settle route
passes on a facilitator reason matching `^[a-z0-9_]{1,64}$`, otherwise `payment rejected`."
First paragraph, optional: "a rejected X-PAYMENT that is answered with a 402 gets a reason text in
`error`".

### L-B spec.md and plan.md still say the comment was corrected (spec.md:36, plan.md:36, plan.md:62)
MW:12-14 is unchanged. The closeout discloses it three times, so the owner is not misled.
Replacement, spec.md:36 tail: "becomes slightly wrong; it was NOT corrected in this PR (see
closeout Follow-up)." plan.md:36: "(the middleware header comment fix is deferred, see closeout
Follow-up)". plan.md:62 last sentence: "That is the intended trade; the comment fix that records it
is deferred (closeout Follow-up)."

### L-C "10 cases through `onRequest`" (closeout.md:32)
Nine go through `onRequest`; the T005 case calls `parseConfig` directly.
Replacement: "`test/fareseal-pay-fixes.test.js`, 10 cases (9 through `onRequest`, the T005 case
through `parseConfig`): ..."

### L-D the lows section does not mention review 3 (closeout.md:147)
The status line says R003 is done; the lows intro stops at review 2, and review 3 reused the labels
L-1 to L-3 for other findings.
Add after the first sentence: "The findings of `second-review-f69e084.md` (M-1, L-1 to L-5) were
all applied in R003 and are not listed here; L-1 to L-3 below are the 06ceb07 review's."

### L-E the rollback states the merge style as fact (closeout.md:168, plan.md:70)
Replacement for the parenthesis: "(PRs #110 to #117 all landed as two-parent merge commits; on a
merge commit git refuses without `-m 1`; if this PR were squash-merged instead, drop `-m 1`)".

### L-F tasks.md:26 owner line differs from the closeout's
Replacement: the closeout.md:201 sentence ("`git revert -m 1` of the merge commit, landed by a PR
(itself a deploy needing Josh's word), is the rollback; see Rollback.").

### L-G "a settle answer with no id" does not say the money may have moved (closeout.md:1, spec.md:94)
data-api clone :126,130 sends `tx: settle.json.transaction ?? null` AFTER the facilitator reported
success. If a facilitator ever omits `transaction`, the payer is charged and gets a cached 402 (old
vendor: a 200 with an empty id).
Replacement for the parenthesis tail: "and a settle answer with no id is now a cached 402 instead
of a 200, even though the payment may already have moved".

Nit: the closeout's Constitution roll-up has columns I-VIII; plan.md's table also has IX (N-A).

## 4. Tests
`git clone` of the worktree at 86fe347 under /home/o2k/.crew/coord/review-tmp/site118d: `npm ci`
rc 0; `npm test` rc 0: 100 files passed, 1159 tests passed, 16 skipped (1175). Same as the closeout.
Extra: in the same clone, test/fareseal-pay-fixes.test.js alone: 10 passed on the new vendor; with
the five vendor dirs checked out from f3e778e: 9 failed, 1 passed (AC-2.3). Clone and logs removed.

## What I ran
- git rev-parse, status, diff --stat (f69e084..HEAD, 862b91e..HEAD), name-only filter, diff
  origin/main...HEAD -- public/, rev-list counts, log --first-parent; sha256sum -c in vendor/.
- Read closeout.md, spec.md, plan.md, tasks.md and second-review-f69e084.md in full; the full
  `git diff f3e778e..HEAD` of the cloudflare, hono, adapter and core dist; MW:1-125; deploy.yml,
  post-deploy-check.yml, ci.yml; package.json scripts; scripts/build-x402.mjs inputs;
  scripts/post-deploy-check.mjs header; test/fareseal-pay-fixes.test.js case list and stub.
- PROVENANCE old (df3fd9b) and new; `git log` and `git diff` of 1b566a6..514bb79 in ~/tollbooth's
  object store (read-only; no fetch, no checkout).
- data-api clone /home/o2k/crewbase-tunnelmind-data-api (ed545f6) api/routes/fareseal-settle.js, read-only.
- npm ci, npm test and the two single-file runs in the temp clone.

## Could not determine
- Whether the deployed data-api equals the clone at ed545f6 (decides rows 2, 7, 9 and L-G).
- What the real facilitator answers for a future validAfter, or puts in a 401/403/429/5xx body.
- The live Pages variables and live answers; that /research exists in the live asset layer
  (check 2 shows it). No request was sent to tunnelmind.ai.
- Whether the PR will land as a merge commit (L-E).
- Whether the repo setting lets the workflow token open a PR, and that a PR opened by that token
  gets no CI run of its own (GitHub does not start workflows from GITHUB_TOKEN events); the closeout
  claims neither.
- `npm run build` and the `public/.well-known` porcelain check were not re-run (not asked);
  "no real payment has been made" rests on the owner's records.
- The commit list was checked against the local object store, not a fresh GitHub clone.
