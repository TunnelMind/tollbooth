# Plan: fareseal-rename-1

## Constitution check (`constitution.md`, tollbooth constitution)

- Title says "*(working name — rename freely; nothing below depends on it)*": the rename itself is pre-authorised. Editing the constitution file is an amendment ("a PR against this file, merged by the maintainer (Josh)"); T012 changes only names in it, and the run's merge needs Josh's word anyway (GATE F), so no separate gate. The "What the door reads" section names `GET /_tollbooth/arrival`; that route keeps working (FR-006), so no code depends on the amendment before it merges.
- Art. II §7 / Art. VI §18: aliased routes and the old maze prefix must keep the same free-path / noindex behaviour — tested in T006/T008.
- Art. III §10: snapshot `kind` stays (signed format constant) — old records verify (FR-009).
- Art. VII §20: zero `any` in exports; deprecated aliases are typed (`export type TollboothConfig = FaresealConfig`, `export const tollbooth = fareseal`).
- Art. VII §23: no new dependencies.
- Art. VII §24 (ADR before contradicting plan.md): nothing in root `plan.md` is contradicted by a rename; the npm-scope ADR 005 is history. No new ADR required; `docs/RENAME-FARESEAL.md` is the record.

## Base

GATE 0 includes the coordinator fast-forwarding `crew/fareseal-rename-1` from 78ce01b to origin/main 26effd7 (`git merge --ff-only origin/main`; verified ancestor). No rebase of any other run's branch.

## Where the change goes (origin/main paths)

| Area | Files |
|---|---|
| Package names/versions | `package.json`, `packages/*/package.json`, `bench/package.json`, `examples/package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `vitest.config.ts` (aliases, if any), `.github/workflows/publish.yml` (comment + list), `packages/cloudflare/CHANGELOG.md` |
| Imports | every `packages/*/src`, `packages/*/test`, `examples/**`, `bench/bench.ts` |
| Env helper | new `packages/core/src/env.ts` (exported from `packages/core/src/index.ts`); callers `packages/cloudflare/src/index.ts` (`str(env, "TOLLBOOTH_*")` at lines ~175, 378–379, 522–525, 558), `examples/node/index.ts:23` |
| Public API | `core/src/config.ts` (`TollboothConfig`), `hono/src/index.ts` (`tollbooth`, `TollboothOptions`), `cloudflare/src/index.ts` (`CloudflareTollboothOptions`, `tollboothEnvMarker`, `ENV_HEADER`), `cloudflare/src/errors.ts` (`TollboothBindingMissingError`) |
| Routes/headers | `hono/src/index.ts` (`REPORT_PATH`, `WEBHOOK_PATH`, `VOUCHER_PATH_PREFIX`, `ARRIVAL_PATH`, `header("tollbooth-voucher")`, `c.header("tollbooth-voucher", …)`, UA at ~295), `cloudflare/src/index.ts` (`REPORT_PATH`, `startsWith("/_tollbooth")`, `x-tollbooth-*` at 545–548 and 507), `core/src/reporter.ts:94`, `core/src/pipeline.ts` (`voucher_header`), `core/src/arrival.ts` (secret header list) |
| Defaults | `core/src/config.ts` (`site_key_path`, `maze.prefix`), `core/src/node.ts` (`loadOrCreateSiteKey`), `maze/src/index.ts` (robots fragment, handler prefix), `cli/src/cli.ts` (`--key` default, seed) |
| CLI | `packages/cli/package.json` `bin`, `packages/cli/src/cli.ts` (usage), new `packages/cli/src/tollbooth-bin.ts` shim, `packages/cli/test/*` |
| Well-known | `cli/src/cli.ts:74–110` (`tollbooth-site.json` fetch), `cli/test/fixtures/fakesite.mjs` |
| Docs | `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `constitution.md`, root `spec.md`/`plan.md`/`tasks.md` (v1 build record), `docs/*.md`, `docs/adr/*.md`, `packages/*/README.md`, new `docs/RENAME-FARESEAL.md` |

## Approach

1. Mechanical package rename first (T001) — one atomic task because a half-renamed workspace does not build. Lockfile regenerated with `pnpm install`. Creates `docs/RENAME-FARESEAL.md` with the table skeleton and the npm/repo-slug rows; every later task appends its own rows (so the doc never lags the code).
2. Additive aliases next: new names primary, old names re-exported/accepted. Never remove an old name in this run.
3. Wire names one family per task, each with tests that would fail on the old code (new name not served/read) and tests that pin the old name still working.
4. Prose last, then the closeout counts every remaining match.

Alias pattern (ponytail: no wrapper layers):
```ts
/** @deprecated Renamed FaresealConfig on 2026-11-10; removed in 3.0.0. */
export type TollboothConfig = FaresealConfig;
/** @deprecated Renamed fareseal() on 2026-11-10; removed in 3.0.0. */
export const tollbooth = fareseal;
```
Env helper (the one lookup, FR-005):
```ts
export function readEnv(env: Record<string, unknown>, suffix: string): string {
  for (const k of [`FARESEAL_${suffix}`, `TOLLBOOTH_${suffix}`]) {
    const v = env[k]; if (typeof v === "string" && v !== "") return v;
  }
  return "";
}
```
Every alias's removal is "3.0.0 (next major)" unless the reader outside the repo moves first (then: "after <consumer> reads the new name").

## Risks

- **Lockfile churn / frozen install** — T001 must commit the regenerated `pnpm-lock.yaml`; verify starts with `--frozen-lockfile`, which catches drift.
- **Signed fixtures** — a blanket sed over `packages/cli/test/fixtures/commons/*.ndjson` breaks signatures. Fixtures and `SOURCE.md` are history; never edited except the one-line note in `SOURCE.md`.
- **Blanket sed of `tollbooth-observe-snapshot`** would break verification of every stored record. Explicitly excluded.
- **Live site** relies on `x-tollbooth-*` headers, `/_tollbooth/*` routes, `TOLLBOOTH_*` Cloudflare secrets: all kept as aliases.
- **Key-file default** — creating a fresh `./fareseal.key` beside a live `./tollbooth.key` would orphan vouchers; fallback tested.
- **Branch base** — the worktree is behind origin/main; GATE 0 fast-forwards before any task.

## Verify (every task)

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test
```
Tasks touching `examples/` or `bench/` also run `bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check` (CI's extra steps, `.github/workflows/ci.yml:26–27`).
