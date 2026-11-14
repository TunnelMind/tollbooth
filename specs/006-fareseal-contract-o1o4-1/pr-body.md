# PR text (draft): fareseal-contract-o1o4-1

Draft for the owner to rewrite. Facts only; the detail and every run is in `closeout.md` in this directory. Written by R004 (2026-11-13); there was no PR text file before it. Brought up to date with the code by R016.

## What this changes

Rows A1 to A13, L6 and T1, as listed in `packages/cloudflare/CHANGELOG.md` under `2.3.0 — Unreleased`. Rows A1 to A8 and T1 are the spec's before/after table (`spec.md`); A9 to A13 and L6 came from the second review. Closeout sections 1 to 8 (A1 to A8, T1), 8b (A9, A10), 13 (A11 to A13) and 10 (L6).

## One fix for behaviour main has today (L6)

This is not one of the spec's rows. The second review found it on main and on this branch alike, and it is about money, so it is fixed here.

- **On main today:** on a cold isolate, every request that arrives while the first request is still building the middleware state builds its own state. Each has its own payment cache, in-flight join, settle bucket and per-payer counts. So 5 concurrent copies of one payment make **5 settle calls** (and 5 x 200 if the facilitator confirms each), and 100 concurrent fresh payments from one payer make **100 settle calls**.
- **After this change:** the build is shared. Those requests wait for one build and use one state. The same bursts make **1 settle call** (one 200 with the receipt, 4 x 402, the same answers as on a warm isolate) and **3 settle calls** (97 x `payer-cooldown`).
- A build that fails is not kept; the next request builds again.
- No response shape changes. The golden snapshot is unchanged.
- Not changed: each isolate still has its own state. Across isolates only the chain refuses a reused nonce.

Code: `packages/cloudflare/src/index.ts` (`building`, in `createPagesMiddleware`). Tests: `packages/cloudflare/test/pages-settle.test.ts`, "cold handler: the first burst shares one state (R004, L6)". Closeout section 10.

## Settle timeout and reservation limit (A9, A10; R002, R006)

Found by the second review (M1): a settle that never answered held its payer's reservation for good.

- **A9.** The settle call now has a hard timeout of **25 s** (`SETTLE_TIMEOUT_MS = 25_000`), on the fetch and on reading its body. A timeout is answered `settle-unconfirmed`: an error-only 402 (no offer body, no `x-payment-required` header, see A11) with the text `settlement status unconfirmed; do not sign a new payment; the same payment may be retried, or contact the operator`. It is not cached, not counted and records no offer, because the transfer may already have been broadcast.
- **A10.** A per-payer reservation stops counting **45 s** after its settle call started (`RESERVATION_TTL_MS = 45_000`: the timeout plus a 20 s margin). The limit is checked on read; there is no timer.
- **Both numbers are reasoned from the route budget, not measured; owner approval pending** (see "Choices for the owner"). The settle route awaits verify, then settle, each with its own 10 s limit, then writes the receipt, so a call that succeeds can take about 20 s plus the write. 25 s clears that case. Nothing shows how long the route really takes, on-chain wait included.
- **Not built:** running the settle under `waitUntil`. The verifier is built once per isolate and hono passes it no request context. If the runtime cancels a request, the reservation is released by the 45 s limit, not at once.

Closeout section 8b. The held-repeat window fix (H1) is in section 8a.

## Maybe-paid answers and the in-flight join (A11, A12, A13; R012, R013)

Found by review round 2 (M2, M1, M3).

- **A11 (R012).** The 402 for `settle-unconfirmed` and `no-transaction-id` (the payer may already have paid) was a full offer: the `x-payment-required` header and a body with `accepts`, `options`, `price_usd` and `v` beside the error. It is now error-only: body `{"x402Version":1,"error":"…"}`, headers `cache-control: no-store` and `content-type`, no `x-payment-required`, no Stripe `link`. A client that acts on `accepts` is no longer invited to sign a second payment. The `settle-unconfirmed` text is now `settlement status unconfirmed; do not sign a new payment; the same payment may be retried, or contact the operator`. Status 402 and the reason names are unchanged. The `no-transaction-id` text is unchanged.
- **A12 (R012).** A payment answered `settle-unconfirmed` is remembered per isolate: at most 512 payments, oldest out, 10 minutes each. Both numbers are judgments, not measurements. While remembered, a payer-class settle answer for the same payment (for example a spent nonce, because the first transfer landed) was cached for the nonce and counted toward the payer's cooldown; it is now answered `settle-unconfirmed` again (the A11 402), not cached, not counted. A later successful settle of that payment is served as usual.
- **A13 (R013).** Copies of a payment whose settle is in flight join that settle. The join had no age limit: if the settle never returned and its release never ran (a request the runtime cancelled), the same payment sent again on that isolate waited for ever and the entry was never removed. The join now ends **45 s** after the settle started (the A10 limit; same status: reasoned, not measured, owner approval pending). The same payment sent again after that is a new attempt with one new settle call and an answer; old entries are removed when the next settle starts. With a custom `fetch` that ignores the abort signal the first settle can still be running then, so the payment can get a second settle call; one authorization still moves money at most once. No response shape changes.

Closeout section 13.

## Choices for the owner

- **Row A7 cap (R003).** A hold's due pass survives at most 3 operator-fault answers, so a cooled-down payer with one due hold makes at most 3 settle calls through a facilitator outage. The cap of 3 is one constant; the owner may prefer another number, or none. Closeout section 9.
- **Settle timeout of 25 s and the 45 s reservation and join limit (R010, R013).** `SETTLE_TIMEOUT_MS = 25_000` and `RESERVATION_TTL_MS = 45_000` are reasoned from the settle route's budget (see above). No latency data backs them: the data-api settle route was not measured, and no log was read. A settle answer slower than 25 s is answered `settle-unconfirmed` (the error-only 402: do not sign a new payment; the same payment may be retried, or contact the operator) and the payer is not served, while the transfer may already have confirmed. Main had no such path. The owner decides: approve 25 s and 45 s explicitly, or give a measured p99 of the data-api settle route under congestion, including its on-chain wait, and both constants follow it.
- **O2 variant b.** `retry-after: 1` on `settle-throttled` is not built. Spec OQ2.
- **Golden file on main's source.** It fails on 4 entries, not 1: `held` (row A2, expected), `no tx id` and `unconfirmed` (row A11, the error-only 402) and `fourth concurrent payment (A1)` (the entry T004 added). SC-002 as written ("fails only on the held-repeat entry") is not met; the reviewer accepts the listed differences or changes SC-002. Closeout section 3 (R015's re-run).

## Not done, and whose

Live facilitator and workerd measurements, deploy, npm publish, the merge word: the owner's (O001). Every settle answer in this work is an in-process stub.

## Checks

See closeout section 10 for the R004 runs (full verify, golden comparison, fuzz counts). Its golden comparison predates R012; the current one is section 3. R016 changed this file only and ran nothing.
