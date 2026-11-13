# T001 — exposure of hono 4.13.13 (locked at pnpm-lock.yaml:574)

Run 2026-11-13 on branch crew/fareseal-hono-advisories-1 (lock == main 6825c30). No source, test, manifest or lock change.

## (a) Ranges — `pnpm audit --json` (npm registry)

| id | audit severity | affected range (as audit reports) | patched | 4.13.13 in range? |
|---|---|---|---|---|
| GHSA-3gg2-335m-rxc6 | low | >=3.12.0 <=4.13.15 | >=4.13.16 | **yes** |
| GHSA-46wx-v44x-9hh2 | moderate | <4.13.16 | >=4.13.16 | **yes** |
| GHSA-4h7h-rv7c-7m2v | moderate | >=4.5.1 <=4.13.15 | >=4.13.16 | **yes** |
| GHSA-4m76-xfj5-7975 | moderate | <4.13.16 | >=4.13.16 | **yes** |
| GHSA-h7mg-cq63-vhpq | moderate | >=4.1.4 <=4.13.15 | >=4.13.16 | **yes** |

All five report finding version 4.13.13. So 4.13.13 is in every range: **T002/T003 ARE needed** (the "not needed" branch does not apply).

`pnpm view hono versions --json`: 4.13.x lists 4.13.0 … 4.13.18. **Smallest fixed 4.13.x = 4.13.16** (4.13.17 and 4.13.18 also exist; no 4.14 considered).

Other audit findings, outside this task's five ids and not acted on here (supervisor's call): `@hono/node-server` 2.1.1 (GHSA-rmxm-3fg6-px4f <2.1.3, GHSA-qv5m-9pm6-hqp3 and GHSA-jpvv-r467-5p4w <2.1.6, moderate) and `zod` 4.4.3 (GHSA-mrhx-c7xc-m3w5 <4.6.6, high). The spec says no other dependency moves unless pnpm forces it.

## (b) Reachability

Grep over packages/, examples/, bench/ (no node_modules/dist) for `from "hono`, `hono/`, `.use(`, `.all(`, `.mount(`, `.route(`, `csrf`, `validator(`, `css`.

Hono use sites:
- packages/cloudflare/src/index.ts:61 `import { Hono } from "hono"`; :530 `new Hono<…>()` (default router); :536 `app.use(fareseal(…))` with NO path (wildcard middleware); :562 `app.all("*", (c) => c.env.NEXT())`.
- packages/hono/src/index.ts:36 type-only import (`Context`, `MiddlewareHandler`); no runtime hono.
- examples/node/index.ts:7,20; examples/bun-hono/index.ts:4,15; examples/cloudflare-worker/worker.ts:5,16 — `new Hono` + `app.use(fareseal(…))` (no path).
- bench/bench.ts:15,58,69 — `tolled.use(…)`, `voucherApp.use(…)`.
- Tests only: packages/hono/test/*.test.ts (`new Hono` + `.use(`; arrival.test.ts:69 `app.all("*")`), packages/cloudflare/test/pages-settle.test.ts:16,1324,1606, examples/node/check.test.ts:9,71.
- Not found anywhere: `hono/` subpath imports (so no `hono/css`, `hono/csrf`, `hono/validator`), `.mount(`, `.route(`, `csrf`, `validator(`. The only `css` hit is packages/core/src/pipeline.ts:166, a file-extension regex, not hono.

Verdicts:

| id | verdict | evidence |
|---|---|---|
| GHSA-3gg2-335m-rxc6 (`hono/css`) | **not reachable** | no `hono/css` import or `css` helper use; only grep hit is the extension regex at packages/core/src/pipeline.ts:166 |
| GHSA-46wx-v44x-9hh2 (`csrf()`) | **not reachable** | no `hono/csrf` import, no `csrf(` call in packages/examples/bench |
| GHSA-4h7h-rv7c-7m2v (`validator('form')`) | **not reachable** | no `hono/validator` import, no `validator(` call |
| GHSA-4m76-xfj5-7975 (`mount()`) | **not reachable** | no `.mount(` and no `.route(` anywhere; apps are single flat `new Hono()` at packages/cloudflare/src/index.ts:530 and the example/bench sites above |
| GHSA-h7mg-cq63-vhpq (RegExpRouter, wildcard middleware, encoded line terminators) | **cannot tell** (pending T002's test) | shape matches: wildcard `app.use(fareseal(…))` at packages/cloudflare/src/index.ts:536 + `app.all("*")` at :562 on the default router; same for packages/hono users (examples/node/index.ts:20, examples/bun-hono/index.ts:15, examples/cloudflare-worker/worker.ts:16, bench/bench.ts:58,69). Whether a `%0A`/`%0D`/`%E2%80%A8`/`%E2%80%A9` path skips the middleware or 404s is not read from code; T002 measures it. |

Note: "not reachable" for four ids covers this repo's own code; a caller of the published `@tunnelmindai/fareseal-hono` (peer) may use those hono features in their own app, which is why T003 still raises the declared floor.

## Decision
4.13.13 is in all five ranges → T002 (test GHSA-h7mg) and T003 (bump to 4.13.16 in lock + 4 manifests + CHANGELOG) proceed.
