# PR text (draft): fareseal-contract-o1o4-1

Draft for the owner to rewrite. Facts only; the detail and every run is in `closeout.md` in this directory. Written by R004 (2026-11-13); there was no PR text file before it.

## What this changes

Rows A1 to A8 and T1 of the spec's before/after table (`spec.md`), as listed in `packages/cloudflare/CHANGELOG.md` under `2.3.0 — Unreleased`. Closeout sections 1 to 8.

## One fix for behaviour main has today (L6)

This is not one of the spec's rows. The second review found it on main and on this branch alike, and it is about money, so it is fixed here.

- **On main today:** on a cold isolate, every request that arrives while the first request is still building the middleware state builds its own state. Each has its own payment cache, in-flight join, settle bucket and per-payer counts. So 5 concurrent copies of one payment make **5 settle calls** (and 5 x 200 if the facilitator confirms each), and 100 concurrent fresh payments from one payer make **100 settle calls**.
- **After this change:** the build is shared. Those requests wait for one build and use one state. The same bursts make **1 settle call** (one 200 with the receipt, 4 x 402, the same answers as on a warm isolate) and **3 settle calls** (97 x `payer-cooldown`).
- A build that fails is not kept; the next request builds again.
- No response shape changes. The golden snapshot is unchanged.
- Not changed: each isolate still has its own state. Across isolates only the chain refuses a reused nonce.

Code: `packages/cloudflare/src/index.ts` (`building`, in `createPagesMiddleware`). Tests: `packages/cloudflare/test/pages-settle.test.ts`, "cold handler: the first burst shares one state (R004, L6)". Closeout section 10.

## Choices for the owner

- **Row A7 cap (R003).** A hold's due pass survives at most 3 operator-fault answers, so a cooled-down payer with one due hold makes at most 3 settle calls through a facilitator outage. The cap of 3 is one constant; the owner may prefer another number, or none. Closeout section 9.
- **O2 variant b.** `retry-after: 1` on `settle-throttled` is not built. Spec OQ2.
- **Golden file on main's source.** It fails on 2 entries, not 1 (`held`, and the A1 entry T004 added). Closeout section 3.

## Not done, and whose

Live facilitator and workerd measurements, deploy, npm publish, the merge word: the owner's (O001). Every settle answer in this work is an in-process stub.

## Checks

See closeout section 10 for the R004 runs (full verify, golden comparison, fuzz counts).
