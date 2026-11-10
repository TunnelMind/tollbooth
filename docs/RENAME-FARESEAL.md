# Tollbooth → Fareseal rename

Tollbooth was renamed Fareseal on 2026-11-10. One row per renamed surface.

| Surface | Old | New | Old still works? | Removed in |
| --- | --- | --- | --- | --- |
| npm package names | `@tunnelmindai/tollbooth-*` | `@tunnelmindai/fareseal-*` | Old names stay published, deprecated; no code alias | never unpublished |
| Repo slug | `TunnelMind/tollbooth` | `TunnelMind/fareseal` (after N007; until then the slug and the `repository` URLs stay) | GitHub redirects after the rename | n/a |
| Env vars (`SITE_KEY`, `SETTLE_TOKEN`, `ENV`, `FLUSH_INTERVAL_MS`, `EXAMPLE_SERVE`, `REPORT_TOKEN`) | `TOLLBOOTH_<X>` | `FARESEAL_<X>` | Yes: `readEnv()` in core reads `FARESEAL_` first, falls back to `TOLLBOOTH_`; a blank new value falls back. `REPORT_TOKEN` is read by the site's own config builder (`env.FARESEAL_REPORT_TOKEN ?? env.TOLLBOOTH_REPORT_TOKEN`) | not scheduled |
| Config type | `TollboothConfig` | `FaresealConfig` | Yes: `TollboothConfig` stays as a type alias marked `@deprecated` | 3.0.0 |
| Hono middleware | `tollbooth()`, `TollboothOptions` | `fareseal()`, `FaresealOptions` | Yes: `const`/type aliases marked `@deprecated` (same function) | 3.0.0 |
| Cloudflare options and env marker | `CloudflareTollboothOptions`, `tollboothEnvMarker` | `CloudflareFaresealOptions`, `faresealEnvMarker` | Yes: aliases marked `@deprecated` | 3.0.0 |
| Binding error | `TollboothBindingMissingError` (`name`, message prefix `tollbooth:`) | `FaresealBindingMissingError` (`name`, message prefix `fareseal:`) | Yes: same class object, so `instanceof` works under both names; the `name` and message text changed | 3.0.0 |
| Site key file default | `./tollbooth.key` | `./fareseal.key` (config `site_key_path`, `fareseal voucher mint --key`) | Yes: when the default is absent and `./tollbooth.key` exists, it is loaded with one `console.warn` and no new key is written; if both exist the new file wins; explicit paths have no fallback | 3.0.0 |
| Route `/_tollbooth/arrival` | `/_tollbooth/arrival` | `/_fareseal/arrival` | Yes: served as an alias with identical handling (arrival stays free and unrecorded) | 3.0.0 |
| Route `/_tollbooth/report` | `/_tollbooth/report` | `/_fareseal/report` | Yes: served as an alias with identical handling | 3.0.0 |
| Route `/_tollbooth/stripe-webhook` | `/_tollbooth/stripe-webhook` | `/_fareseal/stripe-webhook` | Yes: served as an alias with identical handling | 3.0.0 |
| Route `/_tollbooth/voucher/` | `/_tollbooth/voucher/` | `/_fareseal/voucher/` | Yes: served as an alias with identical handling | 3.0.0 |
| Request/response header `tollbooth-voucher` | `tollbooth-voucher` | `fareseal-voucher` | Yes: the old header is read as a fallback (new wins when both are sent) and emitted alongside the new one | 3.0.0 |

`PRICE_USD` and `LEAK_REPLAY` do not exist on origin/main: `git grep -n 'PRICE_USD\|LEAK_REPLAY'` finds nothing (only the lower-case `price_usd` settle-body field, which is not an env var), so there is nothing to alias.

## T008: headers, markers, user agent, maze

| Surface | Old | New | Old still works? | Removed in |
| --- | --- | --- | --- | --- |
| Env marker header on every outbound write | `x-tollbooth-env` | `x-fareseal-env` (`ENV_HEADER`) | Yes: sent beside the new one; exported as `ENV_HEADER_LEGACY` | 3.0.0 |
| `/_fareseal/report` response headers | `x-tollbooth-mode`, `-reporting`, `-settling`, `-env` | `x-fareseal-*` of the same names | Yes: both sets emitted | 3.0.0 |
| Report POST domain header (cloudflare snapshots, core `ReceiptReporter`) | `x-tollbooth-domain` | `x-fareseal-domain` | Yes: both sent | 3.0.0 |
| WBA directory fetch user agent | `tollbooth-wba-verifier/0.0` | `fareseal-wba-verifier/0.0` | No alias (outbound only) | n/a |
| Maze prefix default (GATE 0 Q2) | `/.well-known/tollbooth-maze` | `/.well-known/fareseal-maze` | Yes: the handler and the hono route still serve the old prefix with `noindex, nofollow`, and `robotsFragment` Disallows both (`LEGACY_MAZE_PREFIX`, `mazePrefixes()` in core) | 3.0.0 |
| Log prefixes, robots comment, node maze message | `tollbooth …` | `fareseal …` | n/a | n/a |

The signed snapshot `kind` stays `tollbooth-observe-snapshot` (Q4), and the corpus seed and Commons fixtures are untouched.

## T009: CLI

| Surface | Old | New | Old still works? | Removed in |
| --- | --- | --- | --- | --- |
| CLI bin | `tollbooth` | `fareseal` | Yes: `tollbooth` (`dist/tollbooth-bin.js`) prints one stderr line, then runs the same main with the same stdout and exit code | 3.0.0 |
| `verify --domain` site file | `/.well-known/tollbooth-site.json` | `/.well-known/fareseal-site.json` | Yes: tried only after the new file returns 404 | 3.0.0 |

The corpus default seed stays `tollbooth` (Q5, frozen constant) so corpus output is unchanged.

## Remaining matches

`git grep -i tollbooth`: before (origin/main) 94 files / 601 lines; after 399 lines in 77 files. Reasons: (a) deprecated alias, fallback, or the test that proves it; (b) signed/frozen constant or fixture; (c) history record; (d) repo URL/slug pending N007; (e) `.gitignore` entry.

- `.github/workflows/publish.yml` · repo URL/slug pending N007
- `.gitignore` · .gitignore entry for `tollbooth.key`
- `README.md` · a/b/d: alias mentions, frozen snapshot kind and `v1/tollbooth/*` endpoints, repo clone URL pending N007
- `bench/bench.ts` · deprecated alias, fallback or alias test
- `constitution.md` · c: governing history text; mentions `/_tollbooth/arrival` as the alias
- `docs/RENAME-FARESEAL.md` · history record
- `docs/adr/001-defer-noble-hashes.md` · history record
- `docs/adr/002-examples-node-not-express.md` · history record
- `docs/adr/003-base-mainnet-known-never-default.md` · history record
- `docs/adr/004-cloudflare-batteries-included.md` · history record
- `docs/adr/005-npm-scope-tunnelmindai.md` · history record
- `docs/adr/006-verify-export-lines-and-snapshots.md` · history record
- `docs/adr/README.md` · history record
- `docs/constitution-sweep-v1.0.0.md` · history record
- `docs/vendoring.md` · repo URL/slug pending N007
- `examples/node/check.test.ts` · deprecated alias, fallback or alias test
- `packages/adapter-stripe/README.md` · repo URL/slug pending N007
- `packages/adapter-stripe/package.json` · repo URL/slug pending N007
- `packages/adapter-x402/README.md` · repo URL/slug pending N007
- `packages/adapter-x402/package.json` · repo URL/slug pending N007
- `packages/cli/README.md` · a/d: deprecated bin, site-file fallback, frozen snapshot kind, repo URLs pending N007
- `packages/cli/package.json` · a/d: deprecated `tollbooth` bin entry and repo URLs pending N007
- `packages/cli/src/cli.ts` · a/b: site-file fallback, frozen corpus seed `tollbooth`, frozen snapshot kind
- `packages/cli/src/tollbooth-bin.ts` · deprecated alias, fallback or alias test
- `packages/cli/test/fixtures/commons/SOURCE.md` · signed/frozen constant or fixture (`tollbooth-observe-snapshot`, corpus seed, Commons data, jcs vectors, `data.tunnelmind.ai/v1/tollbooth/*`)
- `packages/cli/test/fixtures/commons/reports.ndjson` · signed/frozen constant or fixture (`tollbooth-observe-snapshot`, corpus seed, Commons data, jcs vectors, `data.tunnelmind.ai/v1/tollbooth/*`)
- `packages/cli/test/verify.test.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/CHANGELOG.md` · history record
- `packages/cloudflare/README.md` · a/d: legacy env names, repo URL pending N007
- `packages/cloudflare/package.json` · repo URL/slug pending N007
- `packages/cloudflare/src/errors.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/src/index.ts` · a/b: legacy headers, route, env, type aliases; frozen snapshot kind; settle route comment naming the data-api file
- `packages/cloudflare/test/alias.test.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/test/pages-arrival.test.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/test/pages-binding.test.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/test/pages-settle.test.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/test/pages.test.ts` · deprecated alias, fallback or alias test
- `packages/cloudflare/test/receipts-waituntil.test.ts` · deprecated alias, fallback or alias test
- `packages/core/README.md` · repo URL/slug pending N007
- `packages/core/package.json` · repo URL/slug pending N007
- `packages/core/src/arrival.ts` · deprecated alias, fallback or alias test
- `packages/core/src/config.ts` · deprecated alias, fallback or alias test
- `packages/core/src/env.ts` · deprecated alias, fallback or alias test
- `packages/core/src/index.ts` · deprecated alias, fallback or alias test
- `packages/core/src/node.ts` · deprecated alias, fallback or alias test
- `packages/core/src/receipt.ts` · b: signed snapshot kind `tollbooth-observe-snapshot` (frozen)
- `packages/core/src/reporter.ts` · deprecated alias, fallback or alias test
- `packages/core/test/arrival.test.ts` · deprecated alias, fallback or alias test
- `packages/core/test/deprecated-names.test.ts` · deprecated alias, fallback or alias test
- `packages/core/test/env.test.ts` · deprecated alias, fallback or alias test
- `packages/core/test/keyfile.test.ts` · deprecated alias, fallback or alias test
- `packages/core/test/receipt.test.ts` · deprecated alias, fallback or alias test
- `packages/core/test/reporter.test.ts` · deprecated alias, fallback or alias test
- `packages/core/test/vectors/jcs.json` · signed/frozen constant or fixture (`tollbooth-observe-snapshot`, corpus seed, Commons data, jcs vectors, `data.tunnelmind.ai/v1/tollbooth/*`)
- `packages/hono/README.md` · repo URL/slug pending N007
- `packages/hono/package.json` · repo URL/slug pending N007
- `packages/hono/src/index.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/alias.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/arrival.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/bounded-memory.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/exists.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/maze-wiring.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/middleware.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/nonce-replay.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/reporter-wiring.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/us3.test.ts` · deprecated alias, fallback or alias test
- `packages/hono/test/verified-bots.test.ts` · deprecated alias, fallback or alias test
- `packages/maze/README.md` · repo URL/slug pending N007
- `packages/maze/package.json` · repo URL/slug pending N007
- `packages/maze/test/maze.test.ts` · deprecated alias, fallback or alias test
- `plan.md` · history record
- `spec.md` · history record
- `specs/001-fareseal-rename-1/closeout.md` · history record
- `specs/001-fareseal-rename-1/plan.md` · history record
- `specs/001-fareseal-rename-1/spec.md` · history record
- `specs/001-fareseal-rename-1/tasks.md` · history record
- `tasks.md` · history record
