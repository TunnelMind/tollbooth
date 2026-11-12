# Plan: fareseal-residue-fareseal-1

## Constitution check (`constitution.md`)

- Art. VII §21 (every FR maps to an automated test): FR-001 gets a new vitest file that reads `.gitignore`; FR-002 is a doc comment (checked by grep in the verify clause) and its behaviour half is already covered by `packages/cli/test/verify.test.ts:407`; FR-003 is the existing `keyfile.test.ts:33` and `verify.test.ts:407`, unedited.
- Art. VII §23 (no new dependencies): none. The test uses `node:fs` only.
- Art. VII §24 (ADR before contradicting `plan.md`): nothing in root `plan.md` is contradicted; `docs/RENAME-FARESEAL.md` stays the record (class (b), untouched). No ADR, no ADR gate.
- No money path touched (no Stripe, x402 or settle file), so no second-review gate.

## Where the change goes

| Row | File | Change |
|---|---|---|
| E1 | `.gitignore` (line 5 `tollbooth.key`) | add `fareseal.key` line above it; keep `tollbooth.key` |
| E1 test | new `packages/core/test/gitignore.test.ts` | asserts `.gitignore` lines include `fareseal.key` and `tollbooth.key` (resolved via `new URL("../../../.gitignore", import.meta.url)`) |
| E2 | `packages/core/src/config.ts:134` (`report_domain` doc comment) | `/.well-known/tollbooth-site.json` → `/.well-known/fareseal-site.json (tollbooth-site.json still read until 3.0.0)` |

Readers that prove old names still work (kept, not edited): `packages/core/src/node.ts:21,40` + `packages/core/test/keyfile.test.ts:33`; `packages/cli/src/cli.ts:124` + `packages/cli/test/verify.test.ts:407`.

## Approach

Two tiny edits, one task each, then a closeout. Test first for E1: the new test fails on main (`fareseal.key` missing) and passes after the line is added. E2 is a comment; no test edit. `dist/` is gitignored, so the comment change regenerates nothing tracked.

## Risks

- Vitest `include` may not pick up a new file name: check `vitest.config.ts` and name the file `*.test.ts` under `packages/core/test/` like its siblings.
- Biome may flag the test style: run `pnpm lint` (part of verify).
- Someone "tidies" `.gitignore` by replacing `tollbooth.key`: the test pins both lines.

## Verify (every task)

`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check`

(the CI steps in `.github/workflows/ci.yml`; the audit's "`npm test`" is the `pnpm test` step within it).
