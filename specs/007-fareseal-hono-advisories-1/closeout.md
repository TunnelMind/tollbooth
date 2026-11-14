# Closeout: fareseal-hono-advisories-1

Branch `crew/fareseal-hono-advisories-1` at HEAD `7376530`, on main `6825c30`. Written by T004 (2026-11-13). The eight-section order follows the T004 brief; §5–§7 (verify tail, diff stat, emptiness checks) mirror the layout of `specs/005-fareseal-pay-lows-2/closeout.md` §5–§7 (§7 there is the Stripe grep only; here it also holds the src diff check).

## 1. Per-advisory table

Locked hono on main: 4.13.13 (`pnpm-lock.yaml:574`). Smallest fixed 4.13.x: 4.13.16 (all five report patched `>=4.13.16`). Source: `exposure.md`.

| id | what it affects | range vs 4.13.13 | verdict | file:line | gap |
|---|---|---|---|---|---|
| GHSA-3gg2-335m-rxc6 (low) | `hono/css` | `>=3.12.0 <=4.13.15`: in range | not reachable | no `hono/css` import; only `css` hit is the extension regex at `packages/core/src/pipeline.ts:166` | A caller of the published peer may use it in their own app; the raised floor covers them |
| GHSA-46wx-v44x-9hh2 (moderate) | `csrf()` middleware | `<4.13.16`: in range | not reachable | no `hono/csrf` import, no `csrf(` call in packages/examples/bench | same |
| GHSA-4h7h-rv7c-7m2v (moderate) | `validator('form')` | `>=4.5.1 <=4.13.15`: in range | not reachable | no `hono/validator` import, no `validator(` call | same |
| GHSA-4m76-xfj5-7975 (moderate) | `mount()` | `<4.13.16`: in range | not reachable | no `.mount(` and no `.route(`; flat `new Hono()` at `packages/cloudflare/src/index.ts:530` | same |
| GHSA-h7mg-cq63-vhpq (moderate) | RegExpRouter, wildcard middleware, encoded line terminators | `>=4.1.4 <=4.13.15`: in range | **exposed on 4.13.13, fixed by 4.13.16** (T002 measured) | wildcard `app.use(fareseal(…))` at `packages/cloudflare/src/index.ts:536`, `app.all("*")` at `:562`; examples/node/index.ts:20, examples/bun-hono/index.ts:15, examples/cloudflare-worker/worker.ts:16, bench/bench.ts:58,69 | none after the bump; tests pin it |

Outside this task, not acted on (spec: no other dependency moves): `@hono/node-server` 2.1.1 (GHSA-rmxm-3fg6-px4f, GHSA-qv5m-9pm6-hqp3, GHSA-jpvv-r467-5p4w) and `zod` 4.4.3 (GHSA-mrhx-c7xc-m3w5).

## 2. What moved

Manifests (five `hono` specifier edits in four files, `^4.13.7` → `^4.13.16`):

- `bench/package.json`: `hono`
- `examples/package.json`: `hono`
- `packages/cloudflare/package.json`: `dependencies.hono`
- `packages/hono/package.json`: `peerDependencies.hono` and `devDependencies.hono`

Side effect: pnpm rewrote `—` as a literal em dash in the `description` of `packages/cloudflare/package.json` and `packages/hono/package.json`. Same JSON value.

`pnpm-lock.yaml` (`git diff main -- pnpm-lock.yaml`), every changed key:

- `importers.bench` → `hono`: specifier `^4.13.7` → `^4.13.16`, version `4.13.13` → `4.13.16`
- `importers.examples` → `hono`: same; `@hono/node-server`: version `2.1.1(hono@4.13.13)` → `2.1.1(hono@4.13.16)`
- `importers.packages/cloudflare` → `hono`: same specifier/version change
- `importers.packages/hono` → `hono`: same specifier/version change
- `packages: hono@4.13.13` → `hono@4.13.16` (resolution integrity `sha512-AOLOEhvrV+iH92xXCnFr/5+3KjPKcI3xP63XJtX5spAnkznPdHijlIsUTpi7/9EhWqrTCekw5c5zh1K+YsVw7A==`)
- `snapshots: '@hono/node-server@2.1.1(hono@4.13.13)'` → `(hono@4.13.16)`, its `hono:` dependency `4.13.13` → `4.13.16`
- `snapshots: hono@4.13.13: {}` → `hono@4.13.16: {}`

Also: one CHANGELOG bullet (`packages/cloudflare/CHANGELOG.md`, "2.3.0 — Unreleased") and two new test files. No source, version field or Stripe change.

## 3. T002 before/after line-terminator table

Tests: `packages/hono/test/line-terminator.test.ts`, `packages/cloudflare/test/hono-line-terminator.test.ts`. Agent request, `NEXT`/origin stubbed and counted. "Middleware ran" = the agent got 402 (fareseal answered); "NEXT ran" = origin called. Before = hono 4.13.13 (red: 8 of 8 encoded cases failed with `expected 404 to be 402`); after = hono 4.13.16 (all 10 tests green).

| path | before: status | middleware ran? | NEXT ran? | after: status | middleware ran? | NEXT ran? |
|---|---|---|---|---|---|---|
| `/%0A` | 404 | no | no | 402 | yes | no |
| `/%0D` | 404 | no | no | 402 | yes | no |
| `/%E2%80%A8` | 404 | no | no | 402 | yes | no |
| `/%E2%80%A9` | 404 | no | no | 402 | yes | no |
| `/x` (control) | 402 | yes | no | 402 | yes | no |

Provenance: the "before" columns come from `exposure.md:41` (prose: T002 measured on 4.13.13 that `/%0A`, `/%0D`, `/%E2%80%A8`, `/%E2%80%A9` return 404 before fareseal runs and NEXT/origin does not run; control `/x` is tolled, 402) and from the T002 QA note that all 8 encoded cases (4 paths × 2 test files) failed with `expected 404 to be 402` on 4.13.13. It is not a recorded per-path table; the per-path rows are inferred from that prose, the count and the test assertions. The "after" columns are the 4.13.16 test results (10 tests green). The red state was not re-run here.

A human on the same encoded paths reaches the origin (200, NEXT called once); this was measured on 4.13.16 only, not on 4.13.13.

## 4. Routing runs (T003)

Three runs of the routing suite after the CHANGELOG bullet: **343 passed / 0 skipped** each (27 files). The supervisor's two clean sequential runs gave the same.

## 5. Full verify tail

`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check`: exit 0. Lint reports 1 warning and 4 infos (existing, e.g. `pages-arrival.test.ts:168`), no errors.

```
packages/cloudflare/test/pages-arrival.test.ts:168:54 lint/suspicious/noTemplateCurlyInString ━━━━━━━━━━

  ! Unexpected template string placeholder.
  
    166 │       "utf8",
    167 │     );
  > 168 │     expect(src).toContain("`https://fareseal.internal${REPORT_PATH}`");
        │                                                      ^^^^^^^^^^^^^^
    169 │     expect(src).toContain('REPORT_PATH = "/_fareseal/report"');
    170 │     expect(src).not.toContain("tollbooth.internal");
  
  i Turn the string into a template string.
  

Checked 125 files in 162ms. No fixes applied.
Found 1 warning.
Found 4 infos.
$ tsc -b && tsc -p tsconfig.tests.json
$ tsc -b
$ vitest run

 RUN  v4.1.12 /home/o2k/.crew/work/fareseal-hono-advisories-1/code


 Test Files  58 passed (58)
      Tests  694 passed (694)
   Start at  11:48:37
   Duration  15.29s (transform 7.42s, setup 0ms, import 23.10s, tests 41.58s, environment 10ms)

bun-hono example OK: human 200, agent 402, arrival 200
| scenario | p50 | p99 |
|---|---|---|
| baseline app, no fareseal | 0.038 ms | 0.208 ms |
| human pass-through | 0.042 ms | 0.322 ms |
| free path pass-through | 0.020 ms | 0.129 ms |
| agent 402 offer | 0.044 ms | 0.368 ms |
| voucher spend + re-sign (ed25519 x2) | 3.911 ms | 9.314 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.004 ms, added p99 0.113 ms)
exit 0
```

## 6. `git diff main --stat`

```
 bench/package.json                                 |  2 +-
 examples/package.json                              |  2 +-
 packages/cloudflare/CHANGELOG.md                   |  9 ++
 packages/cloudflare/package.json                   |  4 +-
 .../cloudflare/test/hono-line-terminator.test.ts   | 28 ++++++
 packages/hono/package.json                         |  6 +-
 packages/hono/test/line-terminator.test.ts         | 48 +++++++++++
 pnpm-lock.yaml                                     | 28 +++---
 specs/007-fareseal-hono-advisories-1/exposure.md   | 46 ++++++++++
 specs/007-fareseal-hono-advisories-1/plan.md       | 47 ++++++++++
 specs/007-fareseal-hono-advisories-1/spec.md       | 99 ++++++++++++++++++++++
 specs/007-fareseal-hono-advisories-1/tasks.md      | 12 +++
 12 files changed, 310 insertions(+), 21 deletions(-)
```

(closeout.md is untracked and not in the stat above.)

## 7. Emptiness checks

- `git diff main -- packages/cloudflare/src packages/core/src`: **empty**
- `git diff main -- packages | grep -iE '^[+-].*stripe'`: **empty**

## 8. PR-body draft

> Draft. Not merged, not published.

**Title:** fix(deps): raise hono floor to ^4.13.16 (five advisories)

Hono 4.13.13 is inside the affected range of five advisories. Four are not reachable from this repo's code (`hono/css`, `csrf()`, `validator('form')`, `mount()`). GHSA-h7mg-cq63-vhpq is: on 4.13.13 the RegExpRouter answers 404 before our wildcard middleware runs for `/%0A`, `/%0D`, `/%E2%80%A8`, `/%E2%80%A9`, so an agent is not tolled and origin/`NEXT` is skipped. Tests added first (red on 4.13.13, green on 4.13.16), then the bump. The lock resolves hono 4.13.16. No source change.

**Caller-visible change:** the `hono` floor goes `^4.13.7` → `^4.13.16` for `@tunnelmindai/fareseal-cloudflare` (dependency) and `@tunnelmindai/fareseal-hono` (peer). Installers on an older hono 4.13 get a peer warning. Recorded in `packages/cloudflare/CHANGELOG.md`, "2.3.0 — Unreleased".

**Merge order:** this PR shares only the manifests and `pnpm-lock.yaml` with tollbooth#17. Whichever merges second re-runs `pnpm install` to regenerate the lock.

**Verify:** full verify exit 0 (58 files / 694 tests, bun-hono example OK, NFR-1 PASS).

**Owner steps (O001):** Josh reviews this draft, decides merge order with tollbooth#17, and merges. Any package version bump, tag or npm publish of the raised hono floor is his.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
