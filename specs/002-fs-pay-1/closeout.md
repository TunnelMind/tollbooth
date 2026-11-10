# Closeout: fs-pay-1

Base origin/main `1b566a6`. Branch `crew/fs-pay-1`: T001 `0a1334c`, T002 `65519c7`,
T003 `904fc78`, T004 `56d4ec1`, T005 `6ba90dc`. I checked each origin/main line with
`git show origin/main:<path> | grep -n`. Where the planner's line numbers in spec.md
are off by a few lines, the lines below are the ones I checked.

## C-1: settlement transaction id (T001): fixed

- **origin/main:** `packages/cloudflare/src/index.ts:286-288` (`...(typeof data.transaction === "string" ? { transaction: data.transaction } : {})`).
  The code read only `transaction`. The data-api settle route sends `tx`, so the id never reached `X-PAYMENT-RESPONSE`.
  A `settled:true` answer with no id still returned ok (`:279-289`).
- **Change:** `packages/cloudflare/src/index.ts:290-293` takes `data.transaction` if it is a non-empty string, else `data.tx`.
  When neither is present, `:300-301` remembers the payment as `no-transaction-id` and returns a 402.
  The payer's failure count is not touched (FR-001/FR-002).
- **Tests** (`packages/cloudflare/test/pages-settle.test.ts`):
  - `a settle answering only \`tx\` surfaces it as the transaction`
  - `a settle answering only \`transaction\` surfaces it`
  - `with both \`transaction\` and \`tx\`, \`transaction\` wins`
  - `settled:true with no transaction id stays 402 and is never re-settled`

## C-2: rejection reasons in the 402 (T002): fixed

- **origin/main:** `packages/hono/src/index.ts:654` always answers `error: "X-PAYMENT header is required"` from `offerResponse` (`:640`).
  The verify result `payment` is assigned at `:794`, but `offerResponse` never reads it.
- **Change:** `paymentError(reason)` at `packages/hono/src/index.ts:617` maps each reason through the fixed FR-004 table, so internal text cannot pass through.
  `offerResponse` takes the rejected result and puts the mapped reason in `error` (`:701-704`).
  This applies on both 402 paths: the offer decision at `:978` and the no-maze fallback at `:992`.
  With no header, the 402 is byte-identical to before.
- **Tests** (`packages/hono/test/payment-errors.test.ts`):
  - describe `402 error carries the rejection reason (FR-004)`:
    - parametrised `${JSON.stringify(reason)} -> ${JSON.stringify(want)}`, one case per table row
    - `internal text never leaks into the 402`
    - `no X-PAYMENT header keeps the x402 v1 default text`
    - `only \`error\` differs from the no-header 402`
    - `paymentError with no reason is the generic text`
  - describe `402 error through the real adapter`:
    - `malformed`, `wrong network`, `wrong payTo`, `amount too low`, `expired`, `not yet valid`, `bad signature`
  - describe `the no-maze consequence fallback 402 carries the reason too`:
    - `a toll-ignored agent presenting a bad payment`
  - In `pages-settle.test.ts`: `a replayed nonce's 402 says the nonce is already used`

## C-3: clock skew (T003): fixed

- **origin/main:** `packages/adapter-x402/src/index.ts:253` (`validAfter > nowS`), `:254` (`validBefore < nowS`) and `:257` (`validBefore - nowS > BigInt(MAX_TIMEOUT_SECONDS)`).
  Skew was zero, so a client clock 1 s ahead was rejected.
- **Change:** a new `toll.x402.skew_tolerance: duration("60s")` at `packages/core/src/config.ts:60`.
  The adapter adds it to both bounds: `not-yet-valid` at `packages/adapter-x402/src/index.ts:264-265` and `window-too-long` at `:269`.
  `expired` gets no skew. Offers still advertise 300 s. The default is stated in `README.md:127` and `packages/cloudflare/CHANGELOG.md:16`.
- **Tests:**
  - `packages/adapter-x402/test/x402.test.ts`, describe `T003 - clock skew tolerance (toll.x402.skew_tolerance, default 60s)`:
    - `accepts a client whose clock runs 1 s ahead`
    - `window-too-long only past 300 s + skew`
    - `not-yet-valid only past now + skew`
    - `skew_tolerance = "0s" restores the strict window`
    - `expired gets no skew`
    - `offers still advertise 300 s`
  - `packages/core/test/config.test.ts`: `rejects a malformed x402 skew_tolerance, naming the key`

## C-4: operator-side settle failures (T004): fixed

- **origin/main:** `packages/cloudflare/src/index.ts:291-297`.
  Every non-settled answer is passed to `remember(seenPayments, key, reason)` (`:293`) and counted in `payerFails` (`:294`).
  A non-2xx response with a non-`data` body falls through as `settle-failed`. So operator faults burned the payer's nonce and counted toward the payer's cooldown.
- **Change:** `packages/cloudflare/src/index.ts:314-326` returns `settle-retryable` without caching or counting when the settle call is an operator fault:
  - a non-2xx response
  - `retryable:true`
  - `settlement-not-configured` or `network-mismatch`
  - `verify-error:*` or `settle-error:*`
  - `(verify|settle)-failed(5xx)`

  The hono table maps `settle-retryable` to `settlement unavailable (operator fault); retry the same payment` (`packages/hono/src/index.ts:595,614`).
  Payer-side failures are still cached and counted (`:327-332`).
- **Tests** (`packages/cloudflare/test/pages-settle.test.ts`, describe `makeSettlingVerify — operator-side settle failures (T004)`):
  - parametrised `${name}: retryable, not cached, no cooldown, operator-fault 402`, where `name` is each of: `HTTP 401 {ok:false,error}`, `HTTP 503`, `HTTP 502 non-JSON body`, `retryable:true`, `settlement-not-configured`, `verify-error: timeout`, `settle-error: boom`, `settle-failed(502)`
  - `payer-side insufficient_funds is still cached and still cools down`

## S3: unknown network fails at config validation (T005): fixed

- **origin/main:** `packages/core/src/config.ts:50` (`network: z.string().min(1).prefault("base-sepolia")`).
  A typo passes config validation. `networkOf` in `packages/adapter-x402/src/index.ts:116-120` then throws on every request.
  The fail-open catch in `packages/hono/src/index.ts:956-958` calls `next()`, so the content is served free.
- **Change:**
  - `X402_NETWORKS = ["base-sepolia", "base"]` at `packages/core/src/config.ts:52`, with `network: z.enum(X402_NETWORKS)` at `:57`. A typo is now a `ConfigError` that names the key and the supported set.
  - `X402_NETWORKS` is exported from `packages/core/src/index.ts`.
  - The Pages middleware rethrows `ConfigError` instead of failing open (`packages/cloudflare/src/index.ts:628-634`).
- **Tests:**
  - `packages/core/test/config.test.ts`: `an unknown x402 network is a ConfigError naming the path and the supported set`
  - `packages/cloudflare/test/pages.test.ts`: `an unknown x402 network is an operator error: it rejects, never serves the origin`

## Verify

Command: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check; echo exit=$?`

Tail of the real run on 2026-11-10 (verbatim):

```
Checked 122 files in 76ms. No fixes applied.
Found 1 warning.
Found 4 infos.
$ tsc -b && tsc -p tsconfig.tests.json
$ tsc -b
$ vitest run

 RUN  v4.1.12 /home/o2k/.crew/work/fs-pay-1/code


 Test Files  55 passed (55)
      Tests  554 passed (554)
   Start at  16:33:27
   Duration  9.99s (transform 10.61s, setup 0ms, import 27.07s, tests 31.89s, environment 10ms)

bun-hono example OK: human 200, agent 402, arrival 200
| scenario | p50 | p99 |
|---|---|---|
| baseline app, no fareseal | 0.013 ms | 0.102 ms |
| human pass-through | 0.016 ms | 0.115 ms |
| free path pass-through | 0.018 ms | 0.096 ms |
| agent 402 offer | 0.020 ms | 0.147 ms |
| voucher spend + re-sign (ed25519 x2) | 2.319 ms | 4.657 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.003 ms, added p99 0.013 ms)
exit=0
```

The lint warning and infos are biome's. They do not fail lint, which exits 0.

## Diff vs origin/main

`git diff origin/main --stat` lists only files in this repo:

```
 README.md                                          |   6 +-
 packages/adapter-x402/src/index.ts                 |  24 ++-
 packages/adapter-x402/test/x402.test.ts            |  64 ++++++-
 packages/cloudflare/CHANGELOG.md                   |  27 +++
 packages/cloudflare/src/index.ts                   |  54 +++++-
 packages/cloudflare/test/pages-binding.test.ts     |   5 +-
 packages/cloudflare/test/pages-settle.test.ts      | 207 +++++++++++++++++++--
 packages/cloudflare/test/pages.test.ts             |   9 +
 .../cloudflare/test/receipts-waituntil.test.ts     |   5 +-
 packages/core/src/config.ts                        |  11 +-
 packages/core/src/index.ts                         |   1 +
 packages/core/test/config.test.ts                  |  19 ++
 packages/hono/src/index.ts                         |  59 +++++-
 packages/hono/test/payment-errors.test.ts          | 205 ++++++++++++++++++++
 specs/002-fs-pay-1/plan.md                         |  49 +++++
 specs/002-fs-pay-1/spec.md                         | 118 ++++++++++++
 specs/002-fs-pay-1/tasks.md                        |  14 ++
```

This closeout.md also shows up once it is committed. No `package.json` changed, so there is no version bump.

## Owner tasks

- **O001 (Josh):**
  1. Re-vendor this release into tunnelmind-site.
  2. Make one real mainnet payment against tunnelmind.ai.
  3. Record the tx hash and the decoded `X-PAYMENT-RESPONSE`.

  The re-vendor and `npm publish` are Josh's to do.
- **O002 (Josh):** start a follow-up run in tunnelmind-data-api so the settle route:
  - returns `transaction` alongside `tx`
  - returns `retryable: true` for transport and config errors

  This branch already accepts both today's shape and the new one.
