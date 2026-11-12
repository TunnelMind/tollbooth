# Closeout: fareseal-pay-lows-1

Run branch `crew/fareseal-pay-lows-1`, base main `514bb79`. Eight task commits:
T001 `8987052` · T002 `ee1e845` · T003 `74c3b05` · T004 `bd84797` · T005 `8cdc2b9` ·
T006 `aa3c5d9` · T007 `18a7f94` · T008 `318e964`.

## How the red-on-main evidence was taken (T009, 2026-11-11)

The six test files this branch changed were copied over a clean checkout of
main `514bb79` (`crew-scratch --rev main`), then `pnpm install --frozen-lockfile`,
`pnpm build`, and `vitest run` on those six files. Result on main: **184 tests,
47 failed, 137 passed** (4 of 6 files failed). The same six files on the branch:
184 tests, 184 passed. (A first run passed the whole `packages/cloudflare/test`
directory and counted 213; the 47 failures were the same.) Every failure listed
below is from that run, not from memory. The
tests that passed on main are the ones that pin existing behaviour (FR-001 rows
0a–0c, 1, 3-retryable, 6; the F3 row-4 guard; the F6 payer-fault case; the bare
8193-char case). That is expected.

The `file:line` cited under each fix was re-read from `git show main:<path>`.

## F1 — operator fault versus payer fault (LOW-1 + LOW-9)

- **Main checked:** `packages/cloudflare/src/index.ts:317-326` (`!resp.ok ||` made every
  non-2xx an operator fault; `/^(verify|settle)-failed\(5\d\d\)$/` at `:324` left
  401/403/429 as payer faults). `packages/hono/src/index.ts:621-623` (`Number(status) < 500
  ? "settle failed"`).
- **Change (`8cdc2b9`):** the classifier follows the FR-001 table, rows 3 → 4 → 6/7
  (`packages/cloudflare/src/index.ts:318-345`). Row 3 adds 401/403/429 to the reason regex,
  row 4 is `resp.status >= 500 || [401, 403, 429]`, and any other non-2xx is cached and
  counted. hono `paymentError` maps `(verify|settle)-failed(401|403|429)` to the
  operator-fault string. The table is in `packages/cloudflare/README.md`.
- **Tests** (`packages/cloudflare/test/pages-settle.test.ts`, describe
  `makeSettlingVerify — FR-001 classifier table (T005)`, and
  `packages/hono/test/payment-errors.test.ts` TABLE rows):
  - `row 0a` / `row 0b` / `row 0c` (×2) / `row 1` / `row 6` (×2): pin existing behaviour, pass on main.
  - `row 3: HTTP 200 reason {verify,settle}-failed({401,403,429}) → settle-retryable, not cached, not counted` (6 cases)
  - `row 3: retryable:true beats a 400 status → settle-retryable`, `row 3: reason <r> → settle-retryable`
  - `row 4: HTTP <n> <name> → settle-retryable, not cached, not counted`
  - `row 7: HTTP {400,404,413,422} {ok:false,error} → settle-failed, cached, counted` and `… non-JSON body …` (8 cases)
  - `row 7: HTTP 400 settled:true → settle-failed, not served, cached, counted`
  - `row 7: HTTP 422 with a string data.reason → that reason, cached, counted`
  - hono: `"settle-failed(401)"`, `"verify-failed(403)"`, `"settle-failed(429)"` `-> "settlement unavailable (operator fault); retry the same payment"`
- **Red on main:**
  - all 6 `row 3 … -failed(401|403|429)` cases: `expected { ok: false, payer: null, …(1) } to match object { ok: false, …(1) }` (the reason was the raw one, and the payment was cached).
  - all 8 `row 7: HTTP 400/404/413/422 …` cases: `… to match object { ok: false, reason: 'settle-failed' }` (main returned `settle-retryable`, not cached). `row 7 … 422 with a string data.reason`: `… to match object { ok: false, reason: 'bad_payload' }`.
  - `row 7: HTTP 400 settled:true` and `row 4: HTTP {401,403,429,500,503} settled:true` (6 cases): `expected { ok: true, …(2) } to match object { ok: false, …(1) }`. This is the F4 hole showing up in the F1 table.
  - `row 2: … no-transaction-id`: `expected undefined to be 'no-transaction-id'` (F5 hole).
  - the 3 hono rows: `expected 'settle failed' to be 'settlement unavailable (operator faul…'`.

## F2 — X-PAYMENT size cap (LOW-8)

- **Main checked:** `packages/adapter-x402/src/index.ts:226` `JSON.parse(atob(xPayment))`
  inside `verifyProof` (`:213`), with no length check.
- **Change (`ee1e845`):** `export const MAX_X_PAYMENT_CHARS = 8192` (`:214`) and
  `if (xPayment.length > MAX_X_PAYMENT_CHARS) return fail("malformed")` before the decode
  (`:228`). Stated in `packages/adapter-x402/README.md`.
- **Tests:** `packages/adapter-x402/test/x402.test.ts` describe
  `T002 F2 - X-PAYMENT is capped at MAX_X_PAYMENT_CHARS (8192)`:
  `a validly signed payment of exactly 8192 chars passes`,
  `a validly signed payment over 8192 chars is malformed`,
  `a bare 8193-char string is malformed`; `pages-settle.test.ts`:
  `an X-PAYMENT over 8192 chars is malformed and never settled (T002 F2)`.
- **Red on main:**
  - `an X-PAYMENT over 8192 chars is malformed and never settled`: `expected 200 to be 402`. A decodable header over 8192 chars reached settle and was served.
  - `a validly signed payment over 8192 chars is malformed`: `expected undefined to be 'malformed'` (main accepted it).
  - `exactly 8192 chars passes`: `expected undefined to be 8192`. It is red on main only because the `MAX_X_PAYMENT_CHARS` export does not exist there. The behaviour it checks (8192 passes) was already true on main.
  - `a bare 8193-char string is malformed` passes on main, as spec US-2 predicts (`atob` already throws on length ≡ 1 mod 4).

## F3 — a facilitator `valid_after` reject is transient (LOW-2)

- **Main checked:** `packages/cloudflare/src/index.ts:327-332`: every `settled:false` reason
  not caught by the operator test was `remember`ed for the nonce and counted.
- **Change (`aa3c5d9`):** row 5, `if (reason.includes("valid_after")) return { …, reason:
  "not-yet-valid" }`, placed after rows 3/4 and before the cache-and-count
  (`packages/cloudflare/src/index.ts:335-336`). hono maps `not-yet-valid` to
  `authorization not yet valid` (`packages/hono/src/index.ts:603`).
- **Tests** (`pages-settle.test.ts`):
  `row 5 (AC-3.1/3.2): valid_after reject → 402 authorization not yet valid; the same X-PAYMENT retried later serves`,
  `row 5 (AC-3.3): valid_after → not-yet-valid, payer null, not cached, not counted`,
  `row 5 guard: a valid_after reason on HTTP 503 → settle-retryable (row 4 wins)`.
- **Red on main:**
  - AC-3.1/3.2: `expected 'facilitator rejected: invalid_exact_e…' to be 'authorization not yet valid'`. Main cached the nonce, so the retry never reached settle again.
  - AC-3.3: `expected { ok: false, payer: null, …(1) } to deeply equal { ok: false, payer: null, …(1) }` (the raw reason, not `not-yet-valid`).
  - The row-5 guard passes on main, as it should: it pins row 4.

## F4 — `settled` requires HTTP 2xx (LOW-3)

- **Main checked:** `packages/cloudflare/src/index.ts:286` `if (data.settled === true)`,
  tested before any `resp.ok` check.
- **Change (`bd84797`):** `if (resp.ok && data.settled === true)` (same line). A non-2xx
  `settled:true` now goes to the classifier.
- **Tests** (`pages-settle.test.ts`, describe
  `createPagesMiddleware — settled:true on non-2xx is not payment (F4)`):
  `HTTP 500 + settled:true: 402 operator fault, not served, retry reaches settle again`,
  `HTTP 400 + settled:true: 402, not served`.
- **Red on main:** both `expected 200 to be 402`. A 500 or 400 with `settled:true` was served.

## F5 — only a real transaction hash serves (L-2, review 2)

- **Main checked:** `packages/cloudflare/src/index.ts:289-294`: any non-empty string in
  `transaction` or `tx` was accepted, so `" "` served.
- **Change (`74c3b05`):** the id is the first of `data.transaction`, `data.tx` that matches
  `^0x[0-9a-fA-F]{64}$` after `.trim()`. The trimmed value is surfaced. No valid id gives
  `no-transaction-id`, remembered and not counted (`packages/cloudflare/src/index.ts:290-301`).
- **Tests** (`pages-settle.test.ts`, describe `createPagesMiddleware — settle-then-serve`):
  `settled:true with tx <value> is 402 no transaction id, remembered, not counted`
  (parametrised over `" "`, `""`, `123`, `null`, `"0xTX"`, 63-hex, 65-hex, 64-hex without `0x`),
  `a whitespace-padded valid tx serves, trimmed in X-PAYMENT-RESPONSE`,
  `an invalid \`transaction\` with a valid \`tx\` serves \`tx\``.
- **Red on main:**
  - `" "`, `"0xTX"`, 63-hex, 65-hex and no-`0x` (5 cases): `expected { ok: true, payer: '0xabc', …(1) } to deeply equal { ok: false, payer: null, …(1) }`. All five served. `""`, `123` and `null` were already refused on main.
  - whitespace-padded: `expected '  0xabab…' to be '0xabab…'` (served untrimmed).
  - invalid `transaction` + valid `tx`: `expected '0xTX' to be '0xcdcd…'` (the invalid one won).

## F6 — no maze for a payment we failed (LOW-5)

- **Main checked:** `packages/core/src/pipeline.ts:322-352`: a failed step-6 payment fell
  through to step 7 (`ledger.exhausted`, `:339`) and step 8 (`recordOffer`, `:350-351`: the `if (identity.kind === "agent")` guard, then the call) whatever
  the reason. `VerifyPayment` (`:90-94`) had no `reason`.
- **Change (`18a7f94`):** core exports `isOperatorFault(reason)` (`pipeline.ts:110`, re-exported
  from `packages/core/src/index.ts`). `VerifyPayment`'s result gains `reason?: string`. Step 6
  returns the offer at once on an operator fault, before steps 7 and 8 (`pipeline.ts:351-353`).
  hono `paymentError` uses the same predicate (`packages/hono/src/index.ts:616`).
- **Tests:** `packages/core/test/pipeline-payment.test.ts` describe
  `FR-006 - no maze for a payment we failed`:
  `<reason>: four attempts are four offers, nothing ledgered` (it.each over `settle-retryable`,
  `settle-throttled`, `settlement-unconfigured`, `settle-unreachable`, `settle-failed(503)`,
  `verify-failed(429)`), `an already-exhausted agent with an operator-fault payment gets the offer`,
  `a payer fault (expired) keeps the consequence after the grace`;
  `packages/hono/test/payment-errors.test.ts`:
  `a verified agent whose settle is retryable gets four 402s, no 302`.
- **Red on main:**
  - the 6 it.each cases: `expected [ 'offer', 'offer', 'offer', …(1) ] to deeply equal [ 'offer', 'offer', 'offer', 'offer' ]`. The 4th attempt was the `consequence`.
  - already-exhausted: `expected 'consequence' to be 'offer'`.
  - hono: `expected [ 402, 402, 402, 302 ] to deeply equal [ 402, 402, 402, 402 ]`.
  - `a payer fault (expired) …` passes on main, as it should: it pins today's behaviour. `packages/core/test/pipeline-consequence.test.ts` is not in the diff (SC-004).

## F7 — the `skew_tolerance` comment (L-3, review 2)

- **Main checked:** `packages/core/src/config.ts:59` "Clock drift accepted on a proof's
  validAfter/validBefore; offers still advertise 300 s."
- **Change (`8987052`):** the comment now reads "Clock drift tolerated by the local check on
  validAfter/validBefore; the facilitator applies its own clock. Offers still advertise 300 s."
  (`config.ts:59-62`). Comment only, no test. `grep -n accepted packages/core/src/config.ts`
  prints no clock-drift line (SC-005).

## Existing tests changed (FR-008)

Only the placeholder transaction-id stubs, all in T003 (`74c3b05`). Why: F5 makes `"0xTX"`
(and the other short placeholders) an invalid id by design. Each assertion keeps its meaning:
the id served equals the id the stub answered.

- `packages/cloudflare/test/pages-settle.test.ts`: 27 removed lines. 24 contain `"0xTX"` or
  `"0xTXHASH"` and now use the shared constant `` TX = `0x${"ab".repeat(32)}` ``. The other 3 are the
  AC-5.3 "`transaction` wins" test, whose `"0xWIN"` / `"0xLOSE"` stubs and `toBe("0xWIN")`
  assertion became valid hashes (`TX` / `TX2`).
- `packages/cloudflare/test/receipts-waituntil.test.ts:26`: one `tx: "0xTX"` → `` `0x${"ab".repeat(32)}` ``.
- `packages/cloudflare/test/pages-binding.test.ts:184`: one `tx: "0xTX"` → `` `0x${"ab".repeat(32)}` ``.

No other existing assertion changed. `git diff main -- '*.test.ts'` shows no removed line in
`x402.test.ts`, `pipeline-payment.test.ts` or `payment-errors.test.ts` (additions only). The
unpaid 402 tests are not in the diff.

## F8 — follow-up (LOW-4)

LOW-4 → tunnelmind-data-api run: on a spent nonce the settle route returns the recorded settlement for payer+nonce once; not built here

## Version

T008 (`318e964`) set all seven `packages/*/package.json` to `"version": "2.3.0"` (was 2.2.0 on
main; `grep '"version"'` gives 7 × 2.3.0), and the CHANGELOG heading is `## 2.3.0 — Unreleased`.
No tag (`git tag --points-at HEAD` is empty), nothing published.

## Verify

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check
```

Exit code **0** (2026-11-11, on the T008 tree). Tail:

```
  i Turn the string into a template string.


Checked 122 files in 148ms. No fixes applied.
Found 1 warning.
Found 4 infos.
$ tsc -b && tsc -p tsconfig.tests.json
$ tsc -b
$ vitest run

 RUN  v4.1.12 /home/o2k/.crew/work/fareseal-pay-lows-1/code


 Test Files  55 passed (55)
      Tests  632 passed (632)
   Start at  20:19:56
   Duration  16.66s (transform 14.43s, setup 0ms, import 43.07s, tests 53.17s, environment 13ms)

bun-hono example OK: human 200, agent 402, arrival 200
| scenario | p50 | p99 |
|---|---|---|
| baseline app, no fareseal | 0.046 ms | 0.229 ms |
| human pass-through | 0.045 ms | 0.302 ms |
| free path pass-through | 0.017 ms | 0.126 ms |
| agent 402 offer | 0.022 ms | 0.197 ms |
| voucher spend + re-sign (ed25519 x2) | 4.433 ms | 9.951 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.000 ms, added p99 0.073 ms)
```

The one lint warning and four infos are in files this branch does not touch
(`packages/cloudflare/test/pages-arrival.test.ts:168`, `packages/core/test/keyfile.test.ts:93`, …),
so they were already on main.

## `git diff main --stat`

Taken before this file was written. `closeout.md` is the only file added after it.

```
 packages/adapter-stripe/package.json               |   2 +-
 packages/adapter-x402/README.md                    |   3 +
 packages/adapter-x402/package.json                 |   2 +-
 packages/adapter-x402/src/index.ts                 |   5 +
 packages/adapter-x402/test/x402.test.ts            |  34 ++
 packages/cli/package.json                          |   2 +-
 packages/cloudflare/CHANGELOG.md                   |  15 +-
 packages/cloudflare/README.md                      |  17 +
 packages/cloudflare/package.json                   |   2 +-
 packages/cloudflare/src/index.ts                   |  39 +-
 packages/cloudflare/test/pages-binding.test.ts     |   2 +-
 packages/cloudflare/test/pages-settle.test.ts      | 427 +++++++++++++++++++--
 .../cloudflare/test/receipts-waituntil.test.ts     |   2 +-
 packages/core/package.json                         |   2 +-
 packages/core/src/config.ts                        |   5 +-
 packages/core/src/index.ts                         |   1 +
 packages/core/src/pipeline.ts                      |  28 +-
 packages/core/test/pipeline-payment.test.ts        |  62 +++
 packages/hono/package.json                         |   2 +-
 packages/hono/src/index.ts                         |  16 +-
 packages/hono/test/payment-errors.test.ts          |  57 +++
 packages/maze/package.json                         |   2 +-
 specs/003-fareseal-pay-lows-1/plan.md              |  61 +++
 .../site-118-second-review-2.md                    | 171 +++++++++
 .../site-118-second-review-3.md                    | 144 +++++++
 .../site-118-second-review-4.md                    | 158 ++++++++
 .../site-118-second-review.md                      |  88 +++++
 specs/003-fareseal-pay-lows-1/spec.md              | 125 ++++++
 specs/003-fareseal-pay-lows-1/tasks.md             |  21 +
 29 files changed, 1430 insertions(+), 65 deletions(-)
```

Every path is inside this repo. The only `packages/adapter-stripe` change is the
`"version"` field in its `package.json` (2.2.0 → 2.3.0, required because `publish.yml`
refuses mixed versions). No Stripe source file changed. The new files are all under
`specs/003-fareseal-pay-lows-1/`.

## Owner tasks (from tasks.md)

- [ ] O001 (owner) Josh: the tunnelmind-site vendor refresh to this release is a separate run; npm publish and any tag are Josh's. Not done by any agent.
- [ ] O002 (owner) Josh: decide the tunnelmind-data-api follow-up run for LOW-4 (recorded settlement returned once for payer+nonce) and, from fs-pay-1 O002, `retryable: true` from the route. Not part of this run.
