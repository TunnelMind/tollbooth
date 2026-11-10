# Feature: fareseal-rename-1 — the product repo becomes Fareseal

**Spec dir:** `specs/001-fareseal-rename-1` · **Created:** 2026-11-10 · **Owner:** Josh

## Intent

Rename the product from Tollbooth to Fareseal across packages, CLI, public API, env vars, wire names and docs, because "an open-source x402 crawler gate already uses the name Tollbooth" (Josh, 2026-11-10).
Nothing live may break: every name that crosses a boundary this repo does not control alone gets the new name as primary and keeps the old one as a documented alias, and old signed records still verify.

Key sentences from the prompt:

> "Rename Tollbooth to Fareseal everywhere. An open-source x402 crawler gate already uses the name Tollbooth." Write Fareseal in prose and fareseal in identifiers (FARESEAL_ in env vars).

> Nothing that is live may break at merge or deploy. Every identifier that crosses a boundary this repo does not control alone … gets the NEW name as primary and keeps the OLD name working as a documented alias or fallback. List every such alias in docs/RENAME-FARESEAL.md with what removes it later. Old signed records must still verify.

> A dated historical record (CHANGELOG entries for released versions, ADR decision history, signed fixtures) keeps the old name where changing it would falsify history; add one line at its top: "Tollbooth was renamed Fareseal on 2026-11-10."

> Count remaining matches with `git grep -i tollbooth` in the closeout and justify each one left.

## Measured baseline (origin/main 26effd7, read 2026-11-10)

- The run branch `crew/fareseal-rename-1` sits at 78ce01b, **24 commits behind origin/main**. It still has the `@tollbooth/*` names; origin/main has `@tunnelmindai/tollbooth-*` (ADR 005). The prompt's facts describe origin/main, so the plan is written against origin/main (GATE 0 fast-forwards; it is a fast-forward, nothing is rebased).
- `git grep -i tollbooth origin/main`: **94 files, 601 lines** (the prompt said 637 matches; lines ≠ matches).
- Package versions: core, hono, cloudflare at 2.1.0; maze, adapter-x402, adapter-stripe, cli at 2.0.0. `publish.yml` refuses a tag that differs from any package version.
- Env vars actually read or documented: `TOLLBOOTH_SITE_KEY`, `TOLLBOOTH_SETTLE_TOKEN`, `TOLLBOOTH_ENV`, `TOLLBOOTH_FLUSH_INTERVAL_MS`, `TOLLBOOTH_EXAMPLE_SERVE` (code) and `TOLLBOOTH_REPORT_TOKEN` (cloudflare README only). **`PRICE_USD` and `LEAK_REPLAY` do not appear anywhere** on origin/main.
- Config: there is **no `tollbooth` key** in the TOML schema (`packages/core/src/config.ts`). `toll` is the payment table (`[toll]`, `[toll.x402]`, `[toll.stripe]`) and also a `mode` value (`mode = "toll"`). Defaults that carry the old name: `site_key_path = "./tollbooth.key"`, `maze.prefix = "/.well-known/tollbooth-maze"`.
- No issue templates exist (`.github/` holds only `workflows/ci.yml`, `workflows/publish.yml`).

## Open Questions (GATE 0 — the planner's recommended answer is listed first; tasks are written to it)

1. **The `[toll]` config table and `mode = "toll"`.** The prompt asks for "`fareseal` key primary, `tollbooth`/`toll` keys accepted as before with one startup warning". No `tollbooth` key exists; `toll` names the act of tolling (the payment section), not the product. **Recommended: keep `[toll]` and `mode = "toll"` unchanged; no config key rename (nothing to rename).** Alternative: add a `[fareseal]` table as the primary spelling of `[toll]`, accept `[toll]` with one startup warning (adds schema aliasing and a warning path to every binding).
2. **Default maze prefix `/.well-known/tollbooth-maze`.** Changing the default moves every maze URL and the robots.txt fragment on any site that relies on the default (tunnelmind.ai does, unless its config sets `prefix`). **Recommended: new default `/.well-known/fareseal-maze`, and the maze handler + robots fragment also cover the old prefix** (old links keep resolving into the maze, both prefixes disallowed). Alternative: keep the old default and document it.
3. **Default `site_key_path = "./tollbooth.key"`** (also `tollbooth voucher mint --key` default). **Recommended: default becomes `./fareseal.key`; when that file is absent and `./tollbooth.key` exists, the old file is used with one startup warning** (never mint a fresh key over a live one — a new key would orphan every issued voucher and receipt).
4. **Signed snapshot `kind: "tollbooth-observe-snapshot"`.** It is inside signed records (Data API Commons stores them; `verifySnapshot` checks it). **Recommended: keep the value unchanged in v1; a `fareseal-…` kind needs a format version and a Data API change, out of scope.** Confirm.
5. **Corpus default seed `"tollbooth"`** (`packages/cli/src/cli.ts:46`). Changing it changes every regenerated maze corpus and its `corpusHash`. **Recommended: keep the seed value; document it as a frozen constant.**
6. **Version:** the planner chooses **2.2.0** for all seven packages (next minor over the highest, 2.1.0). Say otherwise at GATE 0.

## User Scenarios

### US1 — A new integrator installs Fareseal (P1)
Installs `@tunnelmindai/fareseal-hono`, imports `fareseal` and `FaresealConfig`, sets `FARESEAL_SITE_KEY`, runs `fareseal verify`.
- **Given** the renamed packages, **When** `import { fareseal } from "@tunnelmindai/fareseal-hono"` is built, **Then** it compiles and the middleware behaves exactly as `tollbooth()` did.
- **Given** `FARESEAL_SITE_KEY` set, **When** the Cloudflare middleware starts, **Then** receipts are signed with that key.

### US2 — An existing integrator upgrades without code changes (P1)
Keeps `import { tollbooth, type TollboothConfig }`, keeps `TOLLBOOTH_*` secrets in Cloudflare, keeps sending `Tollbooth-Voucher`.
- **Given** code using the old exported names, **When** it compiles against 2.2.0 (imported from the new package names), **Then** it compiles, and the editor shows `@deprecated`.
- **Given** only `TOLLBOOTH_SITE_KEY` is set, **When** the middleware starts, **Then** it signs with it. **Given** both are set, **Then** `FARESEAL_SITE_KEY` wins.
- **Given** an agent sends `tollbooth-voucher`, **When** the voucher is valid, **Then** it is spent as before and the successor voucher rides back on both `fareseal-voucher` and `tollbooth-voucher`.
- **Given** a request to `/_tollbooth/arrival`, **Then** it returns the same reading as `/_fareseal/arrival`.

### US3 — A verifier checks old records (P1)
- **Given** the committed Commons fixtures (`packages/cli/test/fixtures/commons/*.ndjson`, kind `tollbooth-observe-snapshot`), **When** `fareseal verify` runs, **Then** every record verifies as before.
- **Given** a domain that only publishes `/.well-known/tollbooth-site.json`, **When** `fareseal verify --domain` runs, **Then** it falls back to that file and verifies.

### US4 — The CLI under both names (P2)
- **Given** the cli package is installed, **When** `fareseal --help` runs, **Then** help text says fareseal. **When** `tollbooth --help` runs, **Then** exactly one deprecation line goes to stderr and the same output follows on stdout.

## Functional Requirements

- **FR-001** All seven packages are named `@tunnelmindai/fareseal-<x>`; the root is `fareseal-monorepo`; `bench`/`examples` workspace names and every workspace reference, import, tsconfig path, exports map and publish.yml comment follow. No `@tollbooth/*` or `@tunnelmindai/tollbooth-*` reference remains outside history records.
- **FR-002** All seven packages carry version 2.2.0; `packages/cloudflare/CHANGELOG.md` has a 2.2.0 entry stating the rename and the version choice.
- **FR-003** The CLI package exposes bins `fareseal` and `tollbooth`; `tollbooth` prints exactly one deprecation line to stderr then runs the same code with the same exit code.
- **FR-004** Every exported type/class/function/const containing Tollbooth/tollbooth has a Fareseal-named primary export; the old name remains exported as a `@deprecated` alias of the same value/type (`instanceof` works across both names for the error class).
- **FR-005** One helper (`readEnv(env, suffix)` in `@tunnelmindai/fareseal-core`) resolves `FARESEAL_<suffix>` first, else `TOLLBOOTH_<suffix>`; every env read in packages and examples uses it. Tests cover new-only, old-only, both-set (new wins) for each of SITE_KEY, SETTLE_TOKEN, ENV, FLUSH_INTERVAL_MS, EXAMPLE_SERVE; REPORT_TOKEN is documented (README TOML builder) for both spellings.
- **FR-006** Routes: every `/_tollbooth/*` route (arrival, report, stripe-webhook, voucher/) is served at `/_fareseal/*` and still at `/_tollbooth/*`; both prefixes are excluded from snapshot-flush triggering.
- **FR-007** Voucher header: `fareseal-voucher` is read first, `tollbooth-voucher` as fallback; successor vouchers are emitted on both; the 402 body's `voucher_header` names `Fareseal-Voucher`; the arrival reading treats both as secret, presence-only.
- **FR-008** Diagnostic and report headers (`x-…-env`, `-mode`, `-reporting`, `-settling`, `-domain`) are emitted under `x-fareseal-*` AND `x-tollbooth-*` (readers outside this repo: the site, the Data API Commons). `ENV_HEADER` becomes `x-fareseal-env` with `ENV_HEADER_LEGACY` for the old name.
- **FR-009** The signed snapshot `kind` stays `tollbooth-observe-snapshot` (per GATE 0 Q4); all committed signed fixtures verify unchanged.
- **FR-010** `fareseal verify --domain` fetches `/.well-known/fareseal-site.json` and falls back to `/.well-known/tollbooth-site.json` on 404.
- **FR-011** Defaults per GATE 0 Q2/Q3/Q5 (maze prefix both-covered, key-file fallback with one warning, seed frozen).
- **FR-012** User-Agent `tollbooth-wba-verifier/0.0` → `fareseal-wba-verifier/0.0`; log/error message prefixes say `fareseal:`; maze robots comment, stripe voucher page and node maze message say Fareseal.
- **FR-013** `docs/RENAME-FARESEAL.md` holds the wire-name table (name, old → new, read outside this repo by whom, decision: new+accept-both / kept-and-why, what removes the alias) and the alias list; N007 (repo slug/npm) is noted there.
- **FR-014** Docs: README (with one line near the top: the project was called Tollbooth until 2026-11-10 and why), ARCHITECTURE, SECURITY, constitution, docs/, ADR prose, examples, package READMEs use Fareseal. Dated history records keep old names and get the line "Tollbooth was renamed Fareseal on 2026-11-10." at their top.
- **FR-015** `package.json` `repository`/`homepage`/`bugs` URLs keep `TunnelMind/tollbooth` until Josh renames the repo (N007).

## Success Criteria

- **SC-001** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` exits 0 after every task.
- **SC-002** `bun examples/bun-hono/check.ts` and `node --experimental-strip-types bench/bench.ts --check` exit 0 (CI parity) at T001 and at closeout.
- **SC-003** `git grep -il '@tunnelmindai/tollbooth-\|@tollbooth/'` returns only files listed as history records in docs/RENAME-FARESEAL.md.
- **SC-004** `node -p` over `packages/*/package.json` prints `2.2.0` seven times.
- **SC-005** Per env var: ≥3 tests (new / old / both) — at least 15 env tests in `packages/core/test/env.test.ts`.
- **SC-006** Every committed signed fixture verifies: `packages/cli/test/verify.test.ts` passes unchanged in its fixture assertions.
- **SC-007** Closeout records the final `git grep -i tollbooth | wc -l` and `git grep -il tollbooth | wc -l`, with every remaining file justified in docs/RENAME-FARESEAL.md.

## Edge Cases

- Both `FARESEAL_X` and `TOLLBOOTH_X` set to different values → new wins, silently (documented).
- `FARESEAL_X` set to empty string → treated as unset (matches the existing `str()` semantics in cloudflare `index.ts`), falls back to old.
- Agent sends both voucher headers with different values → `fareseal-voucher` is used.
- Request to `/_tollbooth/arrival` must stay free/never-tolled like `/_fareseal/arrival` (constitution "What the door reads", Article II §7).
- Old maze prefix links still served noindex/nofollow (Article VI §18).
- Key-file fallback: never create a new key when the old file exists.
- `tollbooth` bin exit codes and stdout identical to `fareseal`; the deprecation line is on stderr only (scripts parsing stdout keep working).

## Assumptions

- Base is origin/main 26effd7 after GATE 0's fast-forward.
- The site middleware (tunnelmind.ai) and the Data API Commons read the `x-tollbooth-*` headers and the snapshot `kind`; they are not changed here — emitting both keeps them working.
- npm names `@tunnelmindai/fareseal-*` are unpublished; publishing is N007.

## Out of Scope

- Publishing, npm trusted-publisher setup, GitHub repo rename, Cloudflare secret renames, Data API / site changes, a v2 signed-snapshot format (all owner or other runs).
- The payment-bug fixes (redone on top after merge, per the prompt). Other runs' branches are not touched.
