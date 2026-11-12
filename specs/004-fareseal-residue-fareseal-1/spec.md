# Spec: fareseal-residue-fareseal-1

## Intent

Rename the Tollbooth mentions in this repo that the measured residue audit marks class (e) MISSED to Fareseal, on one PR that comes back to Josh. Only those rows change, each to the replacement the audit proposes. Every old name the code accepts today is still accepted, and nothing is merged, deployed or published.

Prompt, quoted:

> Josh, 2026-11-12: "Tollbooth to Fareseal rename across code and docs, on PRs. Stripe code stays. Renaming the GitHub repo, packages or domains comes back to me as an ask and isn't done in this run."

> Fix ONLY the rows that section marks class (e) MISSED, each to the replacement it proposes. Re-measure each row against current main first (file:line may have moved); a row that is gone or no longer says tollbooth is skipped and listed.

> No behaviour change: every old name the code accepts today is still accepted; add or keep a test that proves it where a touched file reads a name.

Source of truth: `~/.crew/coord/fix5/RENAME-FARESEAL-RESIDUE-d8fbbfe.md` (draft PR tunnelmind-spec#13), section `## fareseal` (SHA 977a7c8) and the follow-up line `fareseal-residue-fareseal-1 — size S (2 files): .gitignore, packages/core/src/config.ts. Verify: npm test`.

## The class (e) rows (re-measured by the planner at HEAD 977a7c8 = current main)

| # | file:line (audit) | at HEAD | audit's replacement |
|---|---|---|---|
| E1 | `.gitignore:5` | still `tollbooth.key` on line 5, no `fareseal.key` line | add `fareseal.key` on its own line; KEEP `tollbooth.key` (the legacy fallback `LEGACY_SITE_KEY_PATH` at `packages/core/src/node.ts:21`, read at `:40`, still loads it) |
| E2 | `packages/core/src/config.ts:134` | still `/.well-known/tollbooth-site.json` in the `report_domain` doc comment | `/.well-known/fareseal-site.json`; the old file still works until 3.0.0 (`packages/cli/src/cli.ts:124` reads `fareseal-site.json` first, then `tollbooth-site.json`) |

No other row in the section is class (e). Each coder task re-measures its row before editing; a moved line is followed, a vanished row is skipped and listed in the closeout.

## User Scenarios

### US1 — operator generating a site key (E1)
An operator runs a Fareseal site in a git checkout; `loadOrCreateSiteKey("./fareseal.key")` writes a new key there.
- **Given** the repo `.gitignore`, **when** `git check-ignore fareseal.key` runs, **then** it prints `fareseal.key` (today it exits 1, so the key could be committed).
- **Given** the same `.gitignore`, **when** `git check-ignore tollbooth.key` runs, **then** it still prints `tollbooth.key`.

### US2 — reader of the config docs (E2)
A developer reads the `report_domain` doc comment.
- **Given** `packages/core/src/config.ts`, **then** the comment names `/.well-known/fareseal-site.json` and says the old `tollbooth-site.json` is still read until 3.0.0.
- **Given** a domain that serves only `tollbooth-site.json`, **when** `fareseal verify --domain` runs, **then** it still falls back to it (existing test `packages/cli/test/verify.test.ts:407`, unchanged).

## Functional Requirements

- **FR-001** `.gitignore` has a line `fareseal.key` and keeps the line `tollbooth.key`.
- **FR-002** The `report_domain` doc comment in `packages/core/src/config.ts` names `/.well-known/fareseal-site.json` and notes the `tollbooth-site.json` fallback until 3.0.0. Comment only; no schema, default or code change.
- **FR-003** No behaviour change: the legacy key fallback (`packages/core/test/keyfile.test.ts:33`) and the well-known fallback (`packages/cli/test/verify.test.ts:407`) tests pass unedited.
- **FR-004** No file outside E1/E2, the new test for FR-001, and this spec directory changes. No Stripe file, no class (a)/(b)/(c)/(d) row.
- **FR-005** Closeout lists rows fixed, rows skipped and why, and what visitors/agents/operators see change.

## Success Criteria

- **SC-001** `git check-ignore fareseal.key tollbooth.key` prints both names (exit 0).
- **SC-002** `grep -n 'tollbooth' packages/core/src/config.ts` prints only a line that names it as the fallback (or nothing), and `grep -n 'fareseal-site.json' packages/core/src/config.ts` prints ≥1 line.
- **SC-003** The full verify (plan.md) passes; the test count is the main count + the one new test file's cases, and 0 existing tests edited.
- **SC-004** `git diff main --stat` lists only `.gitignore`, `packages/core/src/config.ts`, one new test file under `packages/core/test/`, and `specs/004-fareseal-residue-fareseal-1/*`.

## Edge Cases

- The audit's line numbers drift on main before the coder runs: follow the content, not the line.
- A row already fixed on main: skip it and list it (closeout).
- Dropping `tollbooth.key` from `.gitignore` would let a legacy key be committed while `node.ts` still loads it: forbidden (FR-001).
- `dist/` output: config.ts is a comment change; `tsc` emits comments into `dist/` but `dist/` is gitignored (class (c) not tracked), so nothing to regenerate or commit.

## Assumptions

- Current main = 977a7c8, the audit's SHA (checked by the planner 2026-11-12).
- The audit's (e) classification is correct; this run does not re-audit the other 71 files.
- Biome lints `.ts` test files; the new test follows the style of `packages/core/test/*.test.ts`.

## Out of Scope

- Class (a) aliases (`TOLLBOOTH_*` env fallback, `/_tollbooth/*` routes, `tollbooth` CLI bin, `./tollbooth.key` fallback, `tollbooth-site.json` fallback), class (b) history, class (c) generated output, class (d) GitHub slug / package names / domains / Worker names: owner asks 1–15 in the audit's "## Asks for Josh".
- Any Stripe code.
- Version bumps, CHANGELOG entries for a release, tags, npm publish, merge, deploy.
