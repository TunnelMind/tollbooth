# Closeout: fareseal-pay-lows-2

Branch `crew/fareseal-pay-lows-2` at HEAD `f24a66e`, on main `705cc57`. Written by T004 (2026-11-13).
CF = `packages/cloudflare/src/index.ts`, PS = `packages/cloudflare/test/pages-settle.test.ts`, README = `packages/cloudflare/README.md`, CHANGELOG = `packages/cloudflare/CHANGELOG.md`. All line numbers are at HEAD.

## 1. Lows

| Low | Status | Where at HEAD / who decides |
|---|---|---|
| N1 part (a): concurrent failures from one payer counted as 1 | Closed by T002 (`0173d46`) | Both count writes re-read `payerFails.get(payer)` after the settle answer: row 5 at CF:376-380, rows 6/7 at CF:390-394. The cooldown check at CF:261-263 still uses the pre-await snapshot (unchanged). Test: PS:1456 "N1: three concurrent failures from one payer cool it down". Docs: README:111-113, CHANGELOG:8 |
| N1 part (b): no reservation of in-flight attempts before the await | Not fixed | A concurrent burst from one payer still reaches the settle bucket (20 calls) before the cooldown applies (recorded at README:111-113). Reserving refuses an honest payer with 3 payments in flight before any has failed: a caller would notice. Owner decides **O1**: (a) leave it, keys are free and rotation reaches the same ceiling (A11b, 315 calls); (b) reserve, with a new reason text or reuse `payer-cooldown`; (c) reserve only for nonces that are failing |
| N2: surviving mutant M13 | Closed by T001 (`b476db6`), test only | Test: PS:1430 "N2: a row-5 count from an expired cooldown window is dropped". The expression it pins is at CF:378 at HEAD (`cur && now < cur.untilMs ? cur.n : 0`); it was CF:375 on main, T002 moved it. Red/green in section 3 |
| N3: no `Retry-After` on `settle-throttled` / held `not-yet-valid` | Not fixed | A new header on a public 402 response shape. Owner decides **O2**: (a) leave it; (b) add both (`1` on `settle-throttled`, seconds until `validAfter` on held); (c) add only on held, where the number is exact |
| N4: held repeats stretch the offer grace | Docs closed by T003 (`825f88a`); the cap is not fixed | Recorded at README:105-110 ("Known costs") and CHANGELOG:9 (2.3.0 — Unreleased). Capping held repeats per agent key changes when a verified agent is mazed. Owner decides **O3**: cap after N held repeats, or accept and keep the README record |
| N5: recorded costs (A16 clock-fast funded payer; A17 facilitator clock behind) | Already recorded, no change; the softening is not fixed | README:99-104. Letting a due hold through a payer cooldown changes the cooldown contract. Owner decides **O4** |
| N6: cooldown map eviction is amnesty | Already recorded, no change | README:67 "Eviction is amnesty." The review asked for no change |

GATE 0 answer (coordinator, 2026-11-13, tasks.md): this run takes option (a) "leave it" for O1–O4; the choices are Josh's and travel with the draft PR.

## 2. Could-not-determine items

| Item | Where it went | Result |
|---|---|---|
| CI steps not run by the second review: `bun examples/bun-hono/check.ts`, `bench/bench.ts --check`, lint, typecheck, tests | Run by the verify command on every task | Exit code 0 at HEAD (section 5): 56 test files / 684 tests passed, `bun-hono example OK`, NFR-1 PASS. CI itself (GitHub Actions) has not run on this branch from here; GATE F requires it green |
| Live facilitator's `valid_after` reason string and clock | Owner item O001 in tasks.md | Not agent work (needs the network) |
| Real Pages / workerd per-isolate budgets | Owner item O001 | Not agent work (needs a deploy) |
| A hung settle route (no timeout; cost recorded at README:91-93) | Owner item O001 | Not agent work |
| 5xx from the facilitator for a locally valid payload | Owner (live facilitator measurement) | Not agent work. Note: O001's text names the first three items; this one is not spelled out there |

## 3. T001 mutant: red with the mutant, green on real code

Reproduced by T004 in a throwaway copy (`~/agent-crew/bin/crew-scratch`), so the worktree source was never edited. T002 renamed the variable in this expression (`fails` → the re-read `cur`) and moved it from CF:375 to CF:378, so M13 at HEAD is `cur ? cur.n : 0`. Both spellings were run; both are red.

Red, M13 as it reads at HEAD (`sed -i '378s/cur && now < cur.untilMs ? cur.n : 0/cur ? cur.n : 0/'`, then `pnpm exec vitest run packages/cloudflare/test/pages-settle.test.ts -t "N2: a row-5 count"`):

```
diff --git a/packages/cloudflare/src/index.ts b/packages/cloudflare/src/index.ts
index 2330a58..ca933f0 100644
--- a/packages/cloudflare/src/index.ts
+++ b/packages/cloudflare/src/index.ts
@@ -378 +378 @@ export function makeSettlingVerify(
-            n: (cur && now < cur.untilMs ? cur.n : 0) + 1,
+            n: (cur ? cur.n : 0) + 1,
Scope: all 10 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 641ms using pnpm v11.5.1

 RUN  v4.1.12 /tmp/crew-scratch.Q6nEJm/repo

 ❯ packages/cloudflare/test/pages-settle.test.ts (136 tests | 1 failed | 135 skipped) 83ms
     × N2: a row-5 count from an expired cooldown window is dropped 57ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/cloudflare/test/pages-settle.test.ts > makeSettlingVerify — not-yet-valid is answered locally until validAfter (R001) > N2: a row-5 count from an expired cooldown window is dropped
AssertionError: expected 'payer-cooldown' to be 'insufficient_funds' // Object.is equality

Expected: "insufficient_funds"
Received: "payer-cooldown"

 ❯ packages/cloudflare/test/pages-settle.test.ts:1444:62
    1442|       // Two failures in this window, not three: the next payment reac…
    1443|       // settle. With the old count carried over it would be cooled do…
    1444|       expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
       |                                                              ^
    1445|         "insufficient_funds",
    1446|       );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 135 skipped (136)
   Start at  04:02:16
   Duration  680ms (transform 363ms, setup 0ms, import 505ms, tests 83ms, environment 0ms)

exit code: 1
crew-scratch: ran in /tmp/crew-scratch.Q6nEJm/repo (deleted)
```

Red, M13 as the task line spells it (`fails ? fails.n : 0` on CF:378), same command, blank lines dropped:

```
diff --git a/packages/cloudflare/src/index.ts b/packages/cloudflare/src/index.ts
index 2330a58..2a91193 100644
--- a/packages/cloudflare/src/index.ts
+++ b/packages/cloudflare/src/index.ts
@@ -378 +378 @@ export function makeSettlingVerify(
-            n: (cur && now < cur.untilMs ? cur.n : 0) + 1,
+            n: (fails ? fails.n : 0) + 1,
Scope: all 10 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 640ms using pnpm v11.5.1
 RUN  v4.1.12 /tmp/crew-scratch.PshE3m/repo
 ❯ packages/cloudflare/test/pages-settle.test.ts (136 tests | 1 failed | 135 skipped) 87ms
     × N2: a row-5 count from an expired cooldown window is dropped 58ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  packages/cloudflare/test/pages-settle.test.ts > makeSettlingVerify — not-yet-valid is answered locally until validAfter (R001) > N2: a row-5 count from an expired cooldown window is dropped
AssertionError: expected 'payer-cooldown' to be 'insufficient_funds' // Object.is equality
Expected: "insufficient_funds"
Received: "payer-cooldown"
 ❯ packages/cloudflare/test/pages-settle.test.ts:1444:62
    1442|       // Two failures in this window, not three: the next payment reac…
    1443|       // settle. With the old count carried over it would be cooled do…
    1444|       expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
       |                                                              ^
    1445|         "insufficient_funds",
    1446|       );
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
 Test Files  1 failed (1)
      Tests  1 failed | 135 skipped (136)
   Start at  04:02:29
   Duration  880ms (transform 515ms, setup 0ms, import 668ms, tests 87ms, environment 0ms)
exit code: 1
crew-scratch: ran in /tmp/crew-scratch.PshE3m/repo (deleted)
```

Green, real code at HEAD in the worktree (`git diff --stat packages/cloudflare/src` prints nothing, then the same vitest command):

```

 RUN  v4.1.12 /home/o2k/.crew/work/fareseal-pay-lows-2/code


 Test Files  1 passed (1)
      Tests  1 passed | 135 skipped (136)
   Start at  04:02:31
   Duration  862ms (transform 481ms, setup 0ms, import 647ms, tests 83ms, environment 0ms)

exit code: 0
```

`git diff packages/cloudflare/src` is empty at the end (0 bytes).

## 4. T002: red on main's source, green at HEAD

Throwaway copy with `git show main:packages/cloudflare/src/index.ts > packages/cloudflare/src/index.ts` (HEAD's test file, main's source; `git diff --stat main -- packages/cloudflare/src` prints nothing there), then `pnpm exec vitest run packages/cloudflare/test/pages-settle.test.ts -t "N1: three concurrent"`:

```
Scope: all 10 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 592ms using pnpm v11.5.1

 RUN  v4.1.12 /tmp/crew-scratch.f0mczQ/repo

 ❯ packages/cloudflare/test/pages-settle.test.ts (136 tests | 1 failed | 135 skipped) 99ms
     × N1: three concurrent failures from one payer cool it down 68ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/cloudflare/test/pages-settle.test.ts > makeSettlingVerify — not-yet-valid is answered locally until validAfter (R001) > N1: three concurrent failures from one payer cool it down
AssertionError: expected 'insufficient_funds' to be 'payer-cooldown' // Object.is equality

Expected: "payer-cooldown"
Received: "insufficient_funds"

 ❯ packages/cloudflare/test/pages-settle.test.ts:1471:62
    1469|       ]);
    1470|       expect(t.s.calls).toBe(3);
    1471|       expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
       |                                                              ^
    1472|         "payer-cooldown",
    1473|       );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 135 skipped (136)
   Start at  04:02:35
   Duration  1.03s (transform 633ms, setup 0ms, import 800ms, tests 99ms, environment 0ms)

exit code: 1
crew-scratch: ran in /tmp/crew-scratch.f0mczQ/repo (deleted)
```

The run stops at PS:1471 (the reason), so the `s.calls` check at PS:1474 is not reached and "4 settle calls" is not printed. `insufficient_funds` is the facilitator stub's answer, so the 4th payment did reach settle.

Green at HEAD, same command in the worktree:

```

 RUN  v4.1.12 /home/o2k/.crew/work/fareseal-pay-lows-2/code


 Test Files  1 passed (1)
      Tests  1 passed | 135 skipped (136)
   Start at  04:02:38
   Duration  786ms (transform 404ms, setup 0ms, import 572ms, tests 87ms, environment 0ms)

exit code: 0
```

## 5. Full verify tail

`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && bun examples/bun-hono/check.ts && node --experimental-strip-types bench/bench.ts --check; echo "exit code: $?"` from the worktree root at HEAD, run before this file was written. Last 40 lines of 128. The lint notes shown (1 warning, 4 infos) are in files this branch does not touch; `biome check` exits 0 with them. `pnpm lint` was run again after this file was written: same counts, exit 0.

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
  

Checked 123 files in 76ms. No fixes applied.
Found 1 warning.
Found 4 infos.
$ tsc -b && tsc -p tsconfig.tests.json
$ tsc -b
$ vitest run

 RUN  v4.1.12 /home/o2k/.crew/work/fareseal-pay-lows-2/code


 Test Files  56 passed (56)
      Tests  684 passed (684)
   Start at  04:02:47
   Duration  13.82s (transform 10.32s, setup 0ms, import 25.57s, tests 34.44s, environment 9ms)

bun-hono example OK: human 200, agent 402, arrival 200
| scenario | p50 | p99 |
|---|---|---|
| baseline app, no fareseal | 0.013 ms | 0.078 ms |
| human pass-through | 0.015 ms | 0.092 ms |
| free path pass-through | 0.009 ms | 0.049 ms |
| agent 402 offer | 0.017 ms | 0.111 ms |
| voucher spend + re-sign (ed25519 x2) | 2.077 ms | 3.465 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.003 ms, added p99 0.014 ms)
exit code: 0
```

## 6. `git diff main --stat` at HEAD

```
 packages/cloudflare/CHANGELOG.md              |  2 +
 packages/cloudflare/README.md                 |  9 +++
 packages/cloudflare/src/index.ts              |  9 ++-
 packages/cloudflare/test/pages-settle.test.ts | 52 ++++++++++++++++
 specs/005-fareseal-pay-lows-2/plan.md         | 44 +++++++++++++
 specs/005-fareseal-pay-lows-2/spec.md         | 90 +++++++++++++++++++++++++++
 specs/005-fareseal-pay-lows-2/tasks.md        | 13 ++++
 7 files changed, 217 insertions(+), 2 deletions(-)
```

Only SC-004 files: PS, CF, README, CHANGELOG and files under `specs/005-fareseal-pay-lows-2/`. This file (`closeout.md`) is uncommitted when the stat is taken and joins the list when the loop commits it. No other file; no finding.

## 7. Stripe / voucher grep

`git diff main -- packages | grep -iE '^[+-].*(stripe|voucher)'; echo "grep exit: $?"`:

```
grep exit: 1
```

Empty (grep exit 1 = no match).
