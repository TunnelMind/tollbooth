# Plan: fareseal-hono-advisories-1

## Constitution check (`constitution.md`)

- Art. I (zero infrastructure): no new service; the dependency stays the same package. Pass.
- Art. II / III / IV / VI: no pipeline order, receipt, crypto or maze code touched. Pass.
- Art. V (honest claims): the closeout states only what was run; CI is the authority at GATE F.
- Art. VII.21 (every FR has a test): FR-002/FR-005 → T002 encoded-terminator tests; FR-001/FR-003 → `pnpm audit --json` output in the notes; FR-004/FR-006/FR-007 → diff checks in the closeout.
- Art. VII.23 (dependency budget): no new dependency; core's runtime deps unchanged (hono is not a core dependency). The PR text carries the one-line justification for the version move.
- Art. VII.24 (ADR before a decision that contradicts `plan.md`): a patch bump of an existing dependency contradicts nothing in the root `plan.md`; no ADR, no ADR gate.

## Where the change goes

- `pnpm-lock.yaml`: `hono@4.13.13` (:574, :1121), the `@hono/node-server@2.1.1(hono@4.13.13)` snapshot (:891-893), the importer specifiers for hono (:38, :62, :111, :142 region).
- Manifests, hono range `^4.13.7` → `^4.13.16` (or the chosen patch): `packages/hono/package.json:25` (dev) and `:28` (peer), `packages/cloudflare/package.json:23`, `bench/package.json:9`, `examples/package.json:12`.
- `packages/cloudflare/CHANGELOG.md` "2.3.0 — Unreleased": one bullet (caller-visible floor). `packages/hono` has no CHANGELOG; the bullet names both packages (no new file).
- `specs/007-fareseal-hono-advisories-1/exposure.md` (T001: ranges, versions, per-advisory verdicts).
- New tests (T002): `packages/cloudflare/test/hono-line-terminator.test.ts` (Pages app, through the exported Pages entry the existing `pages-settle.test.ts` uses) and a `fareseal()` Hono app case in `packages/hono/test/line-terminator.test.ts`. Reuse the helpers/patterns already in `pages-settle.test.ts` and `packages/hono/test/middleware.test.ts`; no new helper file.
- Not touched: `packages/cloudflare/src/**`, `packages/core/src/**` (tollbooth#17 owns them), any Stripe file, workflows, `"version"` fields.

## Approach

1. **T001 decide** (notes only, `exposure.md`). `pnpm audit --json` on main (registry only) gives each id's affected range; `pnpm view hono versions --json` gives the smallest fixed 4.13.x. Grep every hono use (spec.md list) and write the per-advisory verdict. If 4.13.13 is in no range, T002/T003 are skipped and T004 writes the docs-only closeout (FR-006).
2. **T002 test, then bump.** The encoded-terminator tests assert the fixed behaviour; the note shows them red on 4.13.13. Then `pnpm up -r hono@<fixed>` (scoped to hono; no blanket update, no `audit --fix`), ranges to `^<fixed>`, `pnpm install`, every lockfile change listed. The new tests go green and every existing test passes unedited.
3. **T003 changelog + 3× routing run.** CHANGELOG bullet; run the routing/middleware tests three times; record counts.
4. **T004 closeout + PR text draft** (merge-order note vs tollbooth#17, owner steps).

## Risks

- The red test could fail on 4.13.13 for a reason other than the advisory (wrong helper, wrong path encoding). Guard: T002's note shows the red failure message names the 404/not-run assertion, and a control path (`/x`) passes.
- tollbooth#17 might also touch the lockfile or manifests → merge conflict on `pnpm-lock.yaml`. The PR text says merge order; whichever lands second runs `pnpm install` to regenerate.
- pnpm 11 may rewrite unrelated lockfile formatting; if the diff is more than hono lines, stop and list it rather than hand-edit.
- `pnpm audit` uses the npm registry's audit endpoint; it is what the prompt allows. No osv-scanner, no GitHub advisory site.

## Verify (every task)

From `.github/workflows/ci.yml` (job `ci`), in order:

```
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check
```

`pnpm test` = `vitest run` (pretest `tsc -b` = the build); `pnpm lint` = `biome check .`; `pnpm typecheck` = `tsc -b && tsc -p tsconfig.tests.json`. Build is also `pnpm build` (`tsc -b`, as publish.yml runs it). Tests use in-process apps and one loopback socket; no network beyond loopback, except `pnpm audit` / `pnpm view` against registry.npmjs.org in T001/T002.

## Invariants (pinned by existing tests, not edited)

402 texts and reasons (`packages/hono/test/payment-errors.test.ts`, PS "README table"), receipts and signed bytes (core tests), exit codes (cli tests), bench `--check` thresholds. No Stripe line in the diff.
