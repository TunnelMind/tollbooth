# Closeout: fareseal-residue-fareseal-1

## Rows fixed
- **E1** `.gitignore:5` now `fareseal.key` (above `tollbooth.key` at line 6), pinned by `packages/core/test/gitignore.test.ts` (expects both names).
- **E2** `packages/core/src/config.ts:134` doc comment now names `/.well-known/fareseal-site.json (tollbooth-site.json still read until 3.0.0)`. Comment only.
- **R001 (1)** `packages/core/src/config.ts:134-136` comment now says `tollbooth-site.json` is tried only when `fareseal-site.json` returns 404, until 3.0.0, and any other failure throws (matches `cli.ts:79-81`, `:124`). Wording only.
- **R001 (2)** `README.md:339` names `/.well-known/fareseal-site.json` first and says the old `tollbooth-site.json` is still read on a 404 until 3.0.0. Wording only.

## Rows skipped
- `docs/adr/006-verify-export-lines-and-snapshots.md:37` (R001): ADR-006 is history; not edited, by design.

E1/E2: none skipped. Both rows still said tollbooth when re-measured, so no re-measure output applies.

## What changes
- Operator: a generated `./fareseal.key` is no longer committable by accident.
- Reader: the doc comment names the current file.
- Visitor / agent: nothing. No runtime, wire, route, env or storage change.

## Existing tests that pin old names (unedited)
- `packages/core/test/keyfile.test.ts:33` (legacy `./tollbooth.key` fallback)
- `packages/cli/test/verify.test.ts:407` (`tollbooth-site.json` fallback on 404)

Both pass unchanged. No existing test file, and no Stripe, settle or x402 file, was edited.

## Generated files
No `dist/` or tracked generated file changed (`git diff main --name-only` has none).

## Checks
`git check-ignore fareseal.key tollbooth.key` prints:
```
fareseal.key
tollbooth.key
```

Full verify (`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check`) exit 0. Lint reported warnings/infos only, in untouched files (`keyfile.test.ts`, `pages-arrival.test.ts`); not failures. Tail:
```
 Test Files  56 passed (56)
      Tests  682 passed (682)
bun-hono example OK: human 200, agent 402, arrival 200
NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.003 ms, added p99 0.000 ms)
```

## git diff main --stat
```
 .gitignore                                        |  1 +
 README.md                                         |  2 +-
 packages/core/src/config.ts                       |  4 +-
 packages/core/test/gitignore.test.ts              | 11 ++++
 specs/004-fareseal-residue-fareseal-1/closeout.md | 55 ++++++++++++++++++
 specs/004-fareseal-residue-fareseal-1/plan.md     | 34 +++++++++++
 specs/004-fareseal-residue-fareseal-1/spec.md     | 70 +++++++++++++++++++++++
 specs/004-fareseal-residue-fareseal-1/tasks.md    | 13 +++++
 8 files changed, 188 insertions(+), 2 deletions(-)
```
Source/test changes are four files: `packages/core/src/config.ts` (4 lines, comment and wording only, no code change), `packages/core/test/gitignore.test.ts`, plus `.gitignore` and `README.md` (1 and 2 lines). The four `specs/004-fareseal-residue-fareseal-1/` files (this closeout, `plan.md`, `spec.md`, `tasks.md`) are the crew's own records, not code.
