# Development — spec-driven workflow

Four artifacts, Capobianco/Spec Kit style. The spec is the source of truth; code is the derived artifact.

| file | role | phase |
|---|---|---|
| `constitution.md` | non-negotiables — every generated file is checked against it | /constitution |
| `spec.md` | what & why — stories, FRs, acceptance criteria | /specify |
| `plan.md` | how — architecture, stack, pre-made decisions D-1…D-8 | /plan |
| `tasks.md` | ordered build — T-001…T-024, each with done-when | /tasks → /implement |

## Driving it with Claude Code

1. Drop all four files in the repo root.
2. Session prompt template:

```
Read constitution.md, spec.md, plan.md, tasks.md.
Implement T-00N exactly. Honor every MUST in the constitution.
Write the acceptance test named in the task BEFORE the implementation.
If anything forces a deviation from plan.md, STOP and draft an ADR instead of coding around it.
```

3. One task per session. Review the diff against the constitution checklist before the next task.
4. Amend the spec, not the code, when requirements change — then regenerate the affected task.

## Working in this repo

```bash
pnpm install
pnpm build      # tsc -b — emits every package's dist/ (project references)
pnpm test       # runs pnpm build first, then vitest
pnpm typecheck  # tsc -b + the tests-project typecheck
pnpm lint       # biome
```

`dist/` is only produced by `tsc -b`, so **build before anything that imports a
package by its `@tollbooth/*` name** — cross-package tests resolve to `dist/`,
not `src/`. `pnpm test` builds for you (via `pretest`); if you run vitest
directly, `pnpm build` first or those cross-package suites go red on a clean
clone.

## Order of operations
Phase 1 alone yields a working x402 tollbooth (T-010 milestone). Ship value before the maze exists — the offer must predate the consequence in the codebase, same as in the pipeline.

