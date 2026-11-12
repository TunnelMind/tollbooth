# Second review: TunnelMind/tunnelmind-site#118 (site-pay-vendor-1)

VERDICT: PASS for 862b91efe978a9a7b4fa682997200cc45628afb2 (no HIGH, no MEDIUM; 8 LOW; 4 items not determinable offline).

Head confirmed 862b91e; base origin/main = f3e778e = merge-base = GitHub main (git ls-remote). Nothing changed, committed, pushed, merged or deployed. No call to a facilitator, wallet, Stripe, Cloudflare or tunnelmind.ai.

## Findings

No HIGH. No MEDIUM.

### LOW-1  Any non-2xx from the settle route is "operator fault", including 4xx the client caused
- Where: vendor/fareseal-cloudflare/dist/index.js:212 (`!resp.ok`), text at vendor/fareseal-hono/dist/index.js:397.
- Steps: (1) sign a valid authorization with any throwaway key; (2) add a junk field so the base64 X-PAYMENT is over 8192 chars (the site has no size cap; local verifyProof still passes); (3) data-api fareseal-settle.js:74 answers 400 before any facilitator call; (4) the site returns `settle-retryable`: not cached, not counted toward the payer cooldown.
- Measured in my copy: 30 such requests gave 20 settle calls (only the per-isolate bucket of 20, refill 5/s, stopped them); the old vendor stops at 3 (cooldown). A real payer-fault answer (HTTP 200, settled:false) still cools down after 3 on the new vendor.
- Gain/loss: no content, no money. The attacker spends data-api invocations without the cooldown and can hold the isolate's settle bucket empty (honest payers there get the operator-fault 402). Rotating payer keys already allowed this on the old vendor, so the marginal gain is small. A payer with an oversize header is told to "retry the same payment", which can never work.
- Smallest fix (Fareseal): treat only 5xx, 401, 403 and 429 as operator faults; treat other 4xx as a payer-side reject (cache and count). Or cap X-PAYMENT at 8192 chars in verifyProof and answer `malformed`.

### LOW-2  The validAfter half of the clock tolerance moves the reject to the facilitator, where it is cached and counted
- Where: vendor/fareseal-adapter-x402/dist/index.js:160-162; cache at vendor/fareseal-cloudflare/dist/index.js:220-224.
- Measured bounds: validAfter up to now+60 s passes locally (now+62 refused); validBefore up to now+360 s passes (now+363 refused); expired has no tolerance (now-1 refused). Was now+0 and now+300.
- Steps: (1) a wallet N seconds fast (1 < N <= 60) signs validAfter = its now; (2) local check passes; (3) data-api calls the facilitator, whose clock agrees with ours; USDC on chain also requires block time > validAfter; (4) the facilitator answers a payer-fault reason with HTTP 200; (5) the site caches that reason for the nonce and counts 1 of 3 toward the 10-minute cooldown.
- Gain/loss: no free content (serving still needs settled:true plus an id). The paying agent loses that signed authorization in this isolate and can reach a cooldown; on the old vendor the local `not-yet-valid` was not cached and the same payment worked a few seconds later. Each early authorization also costs one facilitator verify. The validBefore half (window up to 360 s) does work end to end. AC-3.1 stubs settle, so the PR line "wallet clocks up to 60 s fast are accepted" is proven only for the local check.
- Smallest fix: no code change needed to merge; correct the PR sentence. In Fareseal, do not cache or count a facilitator `..._valid_after` reason, or keep the validAfter bound strict.

### LOW-3  A settle response with a non-2xx status and `settled:true` in the body still serves
- Where: vendor/fareseal-cloudflare/dist/index.js:179-206 (the `data.settled === true` branch runs before the `!resp.ok` test at :212).
- Measured: HTTP 500 with `{data:{settled:true,tx:"0xTX"}}` gives 200 and content, on old and new vendor alike. Not a regression; only data-api (over the service binding) can send it.
- Smallest fix: require `resp.ok` in the settled branch.

### LOW-4  A settle whose answer is lost still costs the payer, and the new text invites the losing retry
- Where: vendor/fareseal-cloudflare/dist/index.js:212-219, 227-229; data-api api/routes/fareseal-settle.js:110-118.
- Steps: (1) the facilitator settles on chain; (2) the answer is lost (data-api 5xx after settle, a `settle-error:` timeout, or the binding call throws); (3) the site answers "operator fault; retry the same payment"; (4) the retry reaches the facilitator, the nonce is spent, data-api answers settled:false with HTTP 200; (5) the site caches the reason and counts a failure.
- Gain/loss: the payer has paid one toll (0.001 USD today, 10 USD at the price cap) and is never served. The old vendor lost the payment in the same case, so this is not new, but the fix does not cover it. No double charge is possible (one EIP-3009 nonce moves funds once) and no double serve.
- Smallest fix (data-api, not this PR): on a spent nonce, look up the recorded settlement for payer+nonce and return it once.

### LOW-5  A verified agent that retries during an operator fault is sent to the maze
- Where: vendor/fareseal-core/dist/pipeline.js:176-196 (unchanged code), site config `offer_grace = 3`, `window = "10m"`.
- Steps: a Web-Bot-Auth verified agent pays, gets the operator-fault 402 and retries as told; each failed attempt is recorded as an offer; the 4th attempt inside 10 minutes gets a 302 into the maze with no reason. A later successful payment clears it. Anonymous agents are not affected.
- Smallest fix (Fareseal): do not record an offer when the payment result is an operator fault.

### LOW-6  CI binds vendor/ to its own hash files, not to the Fareseal commit
- Where: test/vendor-provenance.test.js:21-46, test/vendor-bytes.test.js.
- The tests recompute every tree hash from disk (I recomputed them independently: all five match). `source`, `commit` and `built_with` are free text to CI, and an edit to a dist file plus SHA256SUMS plus PROVENANCE.json together passes. A new top-level directory under vendor/ not named fareseal-* is not checked either (nothing imports one). The spec lists this as out of scope. The binding to the commit is the rebuild, which I did (see "What I ran").
- Smallest fix: a CI job that runs scripts/vendor-fareseal.mjs at PROVENANCE.commit and fails on `git status --porcelain vendor`.

### LOW-7  The middleware header comment is now wrong
- Where: functions/_middleware.js:12-14 says the toll fails open on its own errors. With this vendor a ConfigError is rethrown (vendor/fareseal-cloudflare/dist/index.js:468-469), so a bad toll config is a 500 on every tolled path instead of an untolled site. "/" and the alias routes return before the toll and stay up.
- I checked that no Pages variable can cause it: the price and report token are shape-checked in tomlConfig (lines 63-77) and every other value is a constant; a price such as "01.5" passes both checks. The closeout records the comment as deferred (FR-008 not met).
- Smallest fix: the comment, in the PR that next regenerates the x402 surface.

### LOW-8  No size limit on X-PAYMENT in the site or the vendor
- Where: vendor/fareseal-adapter-x402/dist/index.js:123 and vendor/fareseal-cloudflare/dist/index.js:132.
- A 200 KB header was base64-decoded and JSON-parsed (twice when the signature is valid) and answered 402. Unchanged from the old vendor; the Cloudflare header limit is the only bound.
- Smallest fix: refuse over 8192 chars as `malformed` before atob (also closes LOW-1).

## Answers to the six questions

1. PROVENANCE. vendor/ at 862b91e is exactly what Fareseal 514bb79 builds: I cloned /home/o2k/crewbase-fareseal into a temp dir, checked out 514bb79, ran `pnpm install --frozen-lockfile` and `pnpm build` (node v22.22.0, pnpm 11.5.1, the versions in PROVENANCE.json), and `diff -r` of each of the five dist trees and `cmp` of each README against vendor/ showed no difference. `sha256sum -c vendor/SHA256SUMS` is clean; the only tracked files in vendor/ outside the sums are PROVENANCE.json, README.md and SHA256SUMS; no symlink, no node_modules, no ignored file. The five vendored package.json files are unchanged from main and have no `scripts` key, so no install or postinstall script. package-lock.json, .github/, wrangler.toml, functions/, public/ and src/ are not in the diff; package.json gains one script line. No new dependency, no new fetch, URL, dynamic import or eval in the changed dist. The vendor script is not on the build or deploy path. Range 1b566a6..514bb79 is 8 commits: 3e63e8d spec, 0a1334c T001, 65519c7 T002, 904fc78 T003, 56d4ec1 T004, 6ba90dc T005, 4da870c closeout, 514bb79 merge of #13. Nothing outside #13. Inside #13, beyond the four fixes: T005 (unknown network is a ConfigError, and ConfigError is rethrown; see LOW-7), and a refused payment now reaches the facilitator in the cases of LOW-1 and LOW-2. packages/maze is untouched and its tree hash is unchanged.

2. PAYMENT AND REPLAY. Path: onRequest -> createPagesMiddleware -> hono handler -> decide() step 6 -> makeSettlingVerify -> local verifyProof -> DATA_API settle -> serve only on `settled === true` plus a non-empty string id.
- Bound before serving: network (must equal "base"), payTo (case-insensitive equality), value >= price in atomics (BigInt), asset and chain (through the EIP-712 domain, so a signature for another token or chain fails recovery), validity window, signer == from. The resource is NOT in the signed authorization (the code says so); cross-path reuse is stopped by the nonce, not by the resource.
- Nonce tracking: per-isolate memory only (Map keyed payer:normalised nonce, cap 512, oldest out). No KV, no D1. Measured: same payment again, on another path, and re-encoded (upper-case hex, extra JSON field) all give 402 "nonce already used" with one settle call; three concurrent copies give one 200 and one settle call. Across isolates, or after eviction, the only guard is the facilitator refusing a spent EIP-3009 nonce (see "Could not determine").
- Tx id: `transaction` or `tx`, string and non-empty, else 402 "settle failed: no transaction id", cached, payer not counted. A number, an empty string, `settled:"true"`, `data:null`, a null or array body, or top-level `settled` all give 402. If the facilitator ever reports success with no id, a payer who did pay gets 402; that is the fail-closed choice the fix makes.
- Operator-fault retry: never serves; every attempt goes through settle again; there is no path that skips settle and no exception swallowed into a pass (a throw or a non-JSON 2xx gives 402). It can be driven by a client only through LOW-1. It cannot double-charge.
- Clock tolerance: LOW-2 has the measured bounds. It cannot serve an expired or not-yet-valid authorization without a settle.

3. FAIL-CLOSED. 41 hostile X-PAYMENT values (empty, bad base64, null, arrays, wrong types for nonce, value, validAfter, validBefore, from, signature, `__proto__` and `constructor` as network or keys, version 2, scheme "upto", base-sepolia, 200 KB) all gave 402 with zero settle calls. Settle unreachable, HTML 502, non-JSON 200: 402. Missing settle token: 402, no settle call. Missing DATA_API or ASSETS binding: FaresealBindingMissingError (a 500, as before). The two pre-existing fail-open catches remain (hono wrapper and vendor/fareseal-cloudflare/dist/index.js:470-471: any other throw in toll logic serves the page); I found no attacker input that reaches them, and the only change to them is the added ConfigError rethrow, which is stricter. The one new `catch(() => null)` (:181) applies to non-2xx bodies only and falls into the retryable 402. No `?? true`, no default-allow added.

4. KEYS AND SECRETS. No secret in the diff. The test signing key and "settle-secret" are the constants already in test/fareseal-settle.test.js on main; site keys in tests are generated per run. PROVENANCE.json holds a public URL, a commit and hashes. The new code logs nothing. The 402 `error` comes from a fixed table; a facilitator reason is passed through only if it matches ^[a-z0-9_]{1,64}$; `verify-error:` and `settle-error:` text (which can hold URLs) maps to the fixed operator-fault line; measured with a reason holding a URL and a key. No stack trace, env name or key reaches the caller. No env name is added or changed (env.js is not in the diff); TOLLBOOTH_SETTLE_TOKEN alone still settles. An unset site key still turns receipts and snapshots off silently while payments keep settling: unchanged behaviour.

5. INPUT VALIDATION. No size cap (LOW-8). No header value is reflected into a response. Table lookups use Object.hasOwn (reasons `__proto__` and `constructor` came back as plain text). Amounts are BigInt from decimal strings: "1e9", 1000.5 and objects are malformed; "-1" and `true` are "amount too low"; a 400-digit value fails the signature step. Timestamps are BigInt: negative validAfter fails, a huge validBefore is "window too long".

6. NOTHING ELSE MOVED. The diff touches no file under public/, functions/, src/, .github/, no wrangler.toml, no Stripe file and no existing test. The unpaid /data 402 test passes on both vendors with an unedited fixture (whole header map and body). Humans and free paths: decide() and env.js are unchanged; a browser request with a garbage X-PAYMENT still gets 200. The new tests are real: they import onRequest from functions/_middleware.js. With vendor/ swapped to origin/main in my copy, 9 of the 10 cases in fareseal-pay-fixes.test.js fail (AC-1.1, AC-1.2, AC-2.1, both AC-2.2, AC-3.1, AC-4.1, AC-4.2, T005); AC-2.3 and the 402-shape test pass on both, as the spec says.

## What I ran
- Hash recompute in the worktree (read-only): sha256sum -c clean; five tree_sha256 values equal on disk, in SHA256SUMS and in PROVENANCE.json.
- Rebuild of Fareseal 514bb79 in a temp clone: five dist trees and READMEs byte-identical to vendor/.
- `npm ci` and `npm test` in a temp clone of the branch at 862b91e: 100 files, 1159 passed, 16 skipped, exit 0. (A `git archive` copy has no history and fails 5 files that read git commit dates; that is the copy, not the branch.)
- My own probe file (7 tests, about 90 requests through onRequest) on the new vendor and again on the old vendor.
- The new tests on the old vendor: 9 failed, 3 passed.
- Both temp copies and their logs are removed. Worktree and crewbase-fareseal are clean and unchanged.

## Could not determine
- Whether a spent authorization is refused across isolates. That rests on the CDP facilitator rejecting a used nonce at verify or settle; data-api keeps no nonce state. Not testable without a facilitator call. Unchanged by this PR.
- What the CDP facilitator answers for validAfter in the future (LOW-2 assumes the x402 reference behaviour).
- Whether the deployed data-api matches the local clone I read (/home/o2k/crewbase-tunnelmind-data-api at ed545f6: payer faults are HTTP 200, 4xx only for malformed calls, the id is sent as `tx`). The site calls /v1/tollbooth/settle; the clone documents /v1/fareseal/settle.
- The live Pages variables and the live answers. I reasoned from the code that no variable value can raise a ConfigError; the post-deploy probes in the closeout are the check.
- I did not read the TypeScript line by line against the dist; the byte-identical rebuild stands in for that.
