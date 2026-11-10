# Plan: fs-pay-1

## Constitution check (`constitution.md`, Fareseal)

- **Art. I** (zero infrastructure): no new service, no datastore. Caches stay in-isolate `Map`s. Pass.
- **Art. II §6** (humans never tolled; fail open on ambiguity): untouched. T005 moves one failure from per-request fail-open to config-time fail-loud. That is a config error, not ambiguous traffic, and Art. VII §20 requires it ("invalid config MUST fail at startup with a message naming the bad key"). Pass.
- **Art. III §9** (no bodies captured): the public `error` strings come from a fixed table (FR-004). No settle-route text is echoed except a facilitator code matching `^[a-z0-9_]{1,64}$`. Pass.
- **Art. IV §13** names clock skew as "a fault, not a forgery" for WBA. T003 applies the same reasoning to x402 windows. Pass.
- **Art. V §15**: README states the skew default and makes no settlement claims. Pass.
- **Art. VII §20**: `skew_tolerance` and `network` are validated by zod and errors name the key. §21: every FR maps to a test (tasks list them). §23: no new dependency. Pass.
- **Art. VII §24** (ADR before contradicting `plan.md`): root `plan.md` §5 lists config defaults. Adding `toll.x402.skew_tolerance` is an addition, not a contradiction. No ADR and no gate needed; the README and CHANGELOG record it.
- Prompt rule "Existing behaviour not named here stays byte-identical": the 402 body changes only in `error`, and only when an `X-PAYMENT` header was presented and rejected. With no header the body stays byte-identical.

## Where the change goes (origin/main `1b566a6`)

| Task | Files |
|---|---|
| T001 | `packages/cloudflare/src/index.ts` (`makeSettlingVerify`, `:278-287`), tests in `packages/cloudflare/test/pages-settle.test.ts`. Existing stubs answering `{settled:true, payer}` with no tx that expect 200 get `tx` added: `pages-settle.test.ts` (lines 114, 124, 134, 156, 181, 197, 206, 221, 229, 251, 267, 306, 326, 335, 349), `packages/cloudflare/test/receipts-waituntil.test.ts:24`, `packages/cloudflare/test/pages-binding.test.ts:182` |
| T002 | `packages/hono/src/index.ts` (`offerResponse` `:640-664` gains an optional reason; callers at `:927` and `:941` pass `payment?.reason` when `req.payment !== undefined`; a `paymentError(reason)` table function next to it), tests in `packages/hono/test/toll-x402.test.ts` (keeps the `:63` no-header assertion) or a new `packages/hono/test/payment-errors.test.ts`, plus one cloudflare case in `pages-settle.test.ts` for `already-settled` / `payer-cooldown` |
| T003 | `packages/core/src/config.ts` (`x402Schema` `:47-53`: `skew_tolerance: duration("60s")`), `packages/adapter-x402/src/index.ts` (`verifyProof` `:256-262`), `packages/adapter-x402/test/x402.test.ts`, `packages/core/test/config.test.ts` (default assertion), `README.md` (`[toll.x402]` block near `:124` + one prose line), `packages/adapter-x402/README.md` if it documents the window, `packages/cloudflare/CHANGELOG.md` |
| T004 | `packages/cloudflare/src/index.ts` (`makeSettlingVerify` `:268-297`: read `resp.status`, classify before `remember`), `packages/hono/src/index.ts` (table row `settle-retryable`), `packages/cloudflare/test/pages-settle.test.ts`, `packages/cloudflare/CHANGELOG.md` |
| T005 | `packages/core/src/config.ts` (exported `X402_NETWORKS = ["base-sepolia","base"] as const`; `network: z.enum(X402_NETWORKS).prefault("base-sepolia")`), `packages/core/src/index.ts` (export), `packages/adapter-x402/src/index.ts` (`NETWORKS: Record<(typeof X402_NETWORKS)[number], …>`; `networkOf` stays as a guard), tests `packages/core/test/config.test.ts` (or `config-tollmode.test.ts`), `packages/cloudflare/test/pages.test.ts` (first request throws at state build), and the test this breaks: `packages/adapter-x402/test/x402.test.ts:45-53` ("throws on an unknown network"), which must build its bad cfg without `parseConfig` (spread a parsed cfg with `network: "mars"`) |

The adapter-x402 package already depends on core (devDependency for tests, and imports `FaresealConfig`). The type-only import of `X402_NETWORKS` stays type-level, so no runtime dependency is added. If a value import is needed, the coder states it in the task note. Duplicating the literal with a compile-time equality check is an acceptable alternative.

## Approach

1. **T001**: `const tx = nonEmpty(data.transaction) ?? nonEmpty(data.tx)`. On `settled:true` with no tx: `remember(seenPayments, key, "no-transaction-id")`, leave `payerFails` alone, return `ok:false`. On success, set `transaction: tx`.
2. **T002**: one pure function `paymentError(reason: string | undefined): string` in hono implementing the FR-004 table, unit-tested directly and through the middleware. `offerResponse(c, body, rejected?: string)` sets `error` to `paymentError(rejected)` when given and keeps the literal otherwise.
3. **T003**: read `cfg.toll.x402.skew_tolerance` (ms) and compute `skewS = BigInt(Math.floor(ms / 1000))`. Change two comparisons. `expired` is unchanged.
4. **T004**: before `remember`, compute `operatorSide`. `resp.ok === false`, or the reason matches the FR-008 set, or `data.retryable === true`. Then return `{ok:false, payer:null, reason:"settle-retryable"}` without caching or counting. hono maps `settle-retryable` to the operator-fault string.
5. **T005**: zod enum. `parseConfig`'s existing issue formatter names the path. The Cloudflare binding calls `parseConfig` in `buildState`, so the first request throws instead of failing open per request.

Order: T001 → T002 → T003 → T004 → T005. T002 owns the reason table, so T004 (which adds a row) must follow it. T003 and T005 both edit `x402Schema` in `config.ts`, so they run one after the other. None is `[P]`, because they share `packages/cloudflare/src/index.ts`, `packages/hono/src/index.ts` and `config.ts`.

## Risks

- **T001 "fail when no transaction id"** follows the prompt. If a settle endpoint reports `settled:true` without a tx, the payer may have paid and still gets a 402. The data-api returns `tx = settle.json.transaction ?? null`, and the CDP facilitator returns `transaction` on success, so today this happens only on a broken endpoint. The payment is remembered so it is never settled twice, and the payer is not put on cooldown. The coordinator or Josh may overturn this at GATE F (the alternative is to serve with `transaction:""`).
- **T004** classifies by the data-api's current reason strings. If that route renames them, the middleware falls back to payer-side (today's behaviour, safe for the operator). The `retryable` flag is the durable contract, and a data-api follow-up (O002) adds it.
- **T005** breaks any deployed config with a misspelled network. That deploy is broken today anyway: it serves paid pages for free. The CHANGELOG entry says so.
- The FR-004 strings become public API. Changing them later is a breaking change for clients that match on them.

## Verify (every task)

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check
```

This is the CI job in `.github/workflows/` (`pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, the bun example check, the bench check).
