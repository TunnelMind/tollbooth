# Spec: fareseal-hono-advisories-1 — hono 4.13.13 → smallest fixed 4.13.x, if it is the right fix here

**Source:** Josh's prompt (2026-11-13), brought from another chat: "hono: yes, apply the same bump to Fareseal and scry-server if it's the right fix for them. Open a PR for each, run the usual review, and leave the merges to me."
**Base:** main `6825c30` (after tollbooth#16).
**Reference run:** tunnelmind-site#123, closeout at `~/.crew/work/site-hono-advisories-1/code/specs/009-site-hono-advisories-1/closeout.md`. Its per-advisory method is used here: verdict + file:line per advisory, with the evidence and the gap written down.

## Intent

hono 4.13.12 has five advisories published since 2026-11-12, fixed in 4.13.16. This repo locks hono 4.13.13. The run decides FIRST whether that version is affected and which advisories are reachable here. If it is affected, it bumps hono to the smallest fixed 4.13.x in the lockfile and in every manifest that declares it, and says what moves for people who install the published packages. One DRAFT PR goes back to Josh: nothing is merged, deployed or published.

Key sentences from the prompt:
- "FIRST decide whether the bump is the right fix here: confirm the locked version is in the affected range of each advisory (read the advisory ranges from `npm audit --json` / `pnpm audit --json` or the lockfile's audit data; the npm registry as the repo's CI uses it is allowed, no other site)"
- "If the locked version is NOT affected by any of them, change nothing and write that up as the result (a docs-only PR with the finding)."
- "bump hono to the smallest fixed 4.13.x (4.13.16 or the latest 4.13 patch; no minor or major jump) ... with no other dependency moving unless the package manager forces it (list every lockfile change)."
- "check each package.json's declared RANGE as well as the lock: a range that still admits an affected version matters for people who install the packages ... (do not bump any package version and do not publish)."
- "Stripe stays: touch no Stripe code. Draft PR tollbooth#17 (payment contract O1-O4) is open and changes packages/cloudflare/src and packages/core/src: do not touch those source files"
- "Full test suite, typecheck, lint and build as CI runs them, three times for the tests that touch routing or middleware; state any behaviour change the bump brings"

## The advisories (ids from the prompt; ranges are read in T001, not assumed)

| id | Area | CVSS (prompt) |
|---|---|---|
| GHSA-3gg2-335m-rxc6 | `hono/css` helper, closing tag split across an interpolation | 3.4 |
| GHSA-46wx-v44x-9hh2 | `csrf()` and hyperlink auditing (`text/ping`) | 5.3 |
| GHSA-4h7h-rv7c-7m2v | `validator('form')` and `multipart/form-data` with extra parameters | 5.3 |
| GHSA-4m76-xfj5-7975 | `mount()` and middleware scoped in a mount prefix | 5.3 |
| GHSA-h7mg-cq63-vhpq | RegExpRouter and wildcard middleware, encoded line terminators | 5.3 |

## Where hono is in this repo (planner read, 2026-11-13; T001 re-checks)

Manifests (all `^4.13.7`):
- `packages/hono/package.json:25` devDependency and `:28` **peerDependency** (published `@tunnelmindai/fareseal-hono`).
- `packages/cloudflare/package.json:23` **dependency** (published `@tunnelmindai/fareseal-cloudflare`).
- `bench/package.json:9`, `examples/package.json:12` (both `"private": true`).
- Lock: `pnpm-lock.yaml:574` `hono@4.13.13`, `:1121` snapshot, `:891-893` `@hono/node-server@2.1.1(hono@4.13.13)` (peer `hono: ^4`, `:218`).

Uses:
- `packages/hono/src/index.ts:36` imports only the `Context` and `MiddlewareHandler` types.
- `packages/cloudflare/src/index.ts:61` `new Hono()` at `:530` (default router), `app.use(fareseal(...))` at `:536` (no path: wildcard middleware), `app.all("*", (c) => c.env.NEXT())` at `:562`. This is the same shape the site run found reachable-as-404 for GHSA-h7mg case 3.
- `examples/node/index.ts:20`, `examples/bun-hono/index.ts:15`, `examples/cloudflare-worker/worker.ts:16`, `bench/bench.ts:58,69`: `app.use(fareseal(...))`.
- Tests import `Hono` from `"hono"`: `packages/hono/test/*.test.ts` (13 files), `packages/cloudflare/test/pages-settle.test.ts:16`, `examples/node/check.test.ts:9`.
- No `hono/` subpath import (so no `hono/css`, `hono/csrf`, `hono/validator`) and no `.mount(` / `.route(` in `packages/*/src`, `examples`, `bench` (grep on 2026-11-13).

## User Scenarios

### US1 — Josh knows whether this repo is affected, per advisory (P1)
**Acceptance:**
1. Given the lockfile at main, when T001 runs `pnpm audit --json` (npm registry only), then the note lists each of the five ids with its affected range and whether 4.13.13 falls in it.
2. Given the grep of every hono use, then each advisory has a verdict exposed / not reachable / cannot tell, with file:line, in the closeout table.

### US2 — the lock and the declared ranges no longer admit an affected hono (P1, only if US1 says affected)
**Acceptance:**
1. Given the bump, when `pnpm audit --json` runs, then none of the five ids is reported.
2. Given `git diff main -- pnpm-lock.yaml`, then the only changed packages are hono and the `@hono/node-server` snapshot key that names hono's version; anything else is listed with the reason pnpm moved it.
3. Given `packages/hono/package.json` and `packages/cloudflare/package.json`, then the hono range's lower bound is the fixed version, and `packages/cloudflare/CHANGELOG.md` "2.3.0 — Unreleased" says so as a caller-visible change. No `"version"` field changes.

### US3 — nothing a caller relies on moves by accident (P1)
**Acceptance:**
1. Given the CI command, it passes before and after; the routing/middleware tests pass three times in a row after the bump.
2. Given a request whose path carries an encoded line terminator (`%0A`, `%0D`, `%E2%80%A8`, `%E2%80%A9`) to the Pages app (`packages/cloudflare/src/index.ts:530-562`) and to a `@tunnelmindai/fareseal-hono` app, the result before and after the bump is recorded (status, whether the fareseal middleware ran, whether `NEXT()` / the origin handler ran), and the change is named.

## Functional Requirements

- **FR-001** T001 records, for hono 4.13.13, each advisory's affected range as reported by `pnpm audit --json` (or `npm audit --json` against the registry), and the smallest fixed 4.13.x that `pnpm view hono versions --json` lists (≥ 4.13.16, < 4.14.0).
- **FR-002** T001 records every hono import/route/middleware with file:line and a verdict per advisory, and T002 replaces GHSA-h7mg-cq63-vhpq's "cannot tell" with a test-backed verdict on the real `packages/cloudflare` app and on a `fareseal()` Hono app.
- **FR-003** If affected: the lock resolves hono to the chosen fixed 4.13.x; every manifest's hono range has that version as its lower bound (`^4.13.16` or the chosen patch); no other dependency moves unless pnpm forces it, and every lockfile change is listed.
- **FR-004** If affected: `packages/cloudflare/CHANGELOG.md` "2.3.0 — Unreleased" gains one bullet naming the raised hono floor for both published packages (`@tunnelmindai/fareseal-cloudflare` dependency, `@tunnelmindai/fareseal-hono` peer). No package `"version"` field changes; nothing is published.
- **FR-005** The GHSA-h7mg encoded-line-terminator behaviour is pinned by a test that states the after-bump result for the Pages app (kept in the suite).
- **FR-006** If NOT affected by any advisory: no manifest or lockfile changes; the closeout is the result (docs-only PR).
- **FR-007** The diff touches no file under `packages/cloudflare/src/`, `packages/core/src/`, `packages/adapter-stripe/`, and no line containing `stripe`.

## Success Criteria

- **SC-001** `pnpm audit --json` after T002 reports zero advisories for hono (or, if FR-006, the note shows 4.13.13 outside all five ranges).
- **SC-002** `git diff main --name-only` lists only: `pnpm-lock.yaml`, the 4 `package.json` files above, `packages/cloudflare/CHANGELOG.md`, the two new test files from T002, and `specs/007-fareseal-hono-advisories-1/*`.
- **SC-003** The verify command in plan.md exits 0 at the end of every task.
- **SC-004** `pnpm vitest run packages/hono packages/cloudflare examples` passes 3 of 3 consecutive runs after the bump (counts in the closeout).
- **SC-005** `git diff main -- packages | grep -iE '^[+-].*stripe'` is empty; `git diff main -- packages/cloudflare/src packages/core/src` is empty.

## Edge Cases

- `pnpm audit` returns no data or the registry is unreachable → T001 records "cannot tell (audit)" for the range check and falls back to the lockfile version vs the "fixed in 4.13.16" fact from the prompt; it does not fetch from any other site.
- 4.13.13 is outside some ranges (e.g. an advisory introduced after 4.13.13): that advisory is "not affected" regardless of reachability.
- pnpm moves another package when hono changes (e.g. re-resolves `@hono/node-server`): listed, not reverted by hand unless the move is avoidable with `pnpm update hono` scoped to hono.
- The encoded-line-terminator path: on 4.13.13 both the middleware and `app.all("*")` may be skipped (404 without `NEXT()`); after the fix both may run, so the toll now applies and `NEXT()` is reached. That is the behaviour change to state: a tolled agent sending such a path now meets the toll instead of a 404.
- tollbooth#17 also touches manifests/lockfile? The PR text carries the merge-order note either way (FR in T004).

## Assumptions

- The latest 4.13 patch is ≥ 4.13.16; T001 reads it from the registry and picks the smallest fixed patch.
- Raising a peer-dependency floor is a caller-visible change but not a major one: hono ^4.13.16 is still hono 4, and every hono that admits the fix is ≥ 4.13.16.
- No `.specify/templates/` exist in this repo; the shapes of `specs/005-fareseal-pay-lows-2/` are followed.

## Out of Scope

- scry-server (its own PR, its own run).
- Any package `"version"` bump, any npm publish, tag, or release — owner.
- Any change to `packages/cloudflare/src`, `packages/core/src`, Stripe code, workflows.
- A hono minor/major upgrade, or moving any other dependency on purpose.
