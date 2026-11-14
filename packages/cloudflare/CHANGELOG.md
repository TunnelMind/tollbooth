# @tunnelmindai/fareseal-cloudflare

Tollbooth was renamed Fareseal on 2026-11-10.

## 2.3.0 — Unreleased

- The site vendored 514bb79 as 2.2.0; 2.3.0 marks this payment-path refresh.
- A1: a fresh payment from a payer whose live failures plus settles in flight already total 3, with fewer than 3 live failures (e.g. a 4th concurrent payment), was settled; it now gets the 402 `payer cooling down after repeated failures; retry later` (`payer-cooldown`, byte-identical to the existing one): no settle call, not cached, not counted, offer recorded. Known cost: an honest payer's 4th concurrent payment is refused with that text (README, "Known costs").
- A2: the held repeat (`not-yet-valid-held`) 402 had the headers `cache-control: no-store`, `content-type` and `x-payment-required`; it now also carries `retry-after: <validAfter − now, integer s ≥ 1>`. Body unchanged.
- A3: a held repeat beyond 60 in a held window (`toll.window` long, opened by the first held repeat, cleared when the offer window rolls or the key pays) from a verified agent key got a 402 with no offer recorded; it now gets the same 402 (as A2) and an offer is recorded, and once `offer_grace` is spent the existing 302 to `maze.prefix`.
- A4: a due attempt (the hold has come due) while the payer is cooled down or reserved out got 402 `payer-cooldown` with no settle call; it now gets one settle call, with the result per the README table (200 + `x-payment-response` on success).
- A5: a retry after a due attempt that got row 5 again was held again, and the next request settled again, every time; it is now not held, and the next request is an ordinary attempt (`payer-cooldown` if cooled, else a settle call).
- A6: a due attempt that met an empty bucket got 402 `settle-throttled` and lost its hold, so the retry was an ordinary attempt; it still gets 402 `settle-throttled` (same bytes) but the hold stays, so the retry is still the due attempt.
- A7: a due attempt that got an operator fault got the operator-fault 402 and lost its hold; it gets the same 402 and the hold is put back, so the retry is still the due attempt. Bounded: the third operator-fault answer for one hold drops it, so a cooled-down payer with one due hold makes at most 3 settle calls through a facilitator outage, then gets `payer-cooldown` (README, "Known costs").
- A8: a cooldown ended 600 s after the start of the failing settle; it now ends 600 s after its failure was written. No response shape changes.
- A9 (R006): the settle call now has a hard timeout of 25 s, on the fetch and on reading its body (a 2xx or a non-2xx body alike). A settle that answered after more than 25 s was waited for and served per its answer (200 + `x-payment-response` on success); it is now not served: 402 `settlement status unconfirmed; do not pay again, contact the operator` (`settle-unconfirmed`, the existing reason and text), not cached, not counted, no offer recorded. The payer's money may already have moved: the facilitator may have broadcast the transfer before the timeout. 25 s is approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured: the settle route awaits verify, then settle, each with its own 10 s limit, then writes the receipt, so a call that succeeds can take about 20 s plus the write (an earlier draft of this change used 10 s, which was below that).
- A10 (R002): a payer's reservation (A1) stops counting 45 s after its settle call started (the A9 timeout plus a 20 s margin; approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured), even if that settle has not answered and its release never ran (a request the runtime cancelled). The limit is checked when the payer's reservations are next read; there is no timer. So one stuck settle cannot keep counting against its payer for the life of the isolate. No response shape changes.
- A11 (R012): the 402 for `settle-unconfirmed` and `no-transaction-id` (the payer may already have paid) was a full offer: the `x-payment-required` header and a body with `accepts`, `options`, `price_usd` and `v` beside the error. It is now error-only: body `{"x402Version":1,"error":"…"}`, headers `cache-control: no-store` and `content-type`, no `x-payment-required`, no Stripe `link`. A client that acts on `accepts` is no longer invited to sign a second payment. The `settle-unconfirmed` text changes from `settlement status unconfirmed; do not pay again, contact the operator` to `settlement status unconfirmed; do not sign a new payment; the same payment may be retried, or contact the operator` (this replaces the text quoted in A9 and below); status 402 and the reason names are unchanged. The `no-transaction-id` text is unchanged.
- A12 (R012): a payment answered `settle-unconfirmed` is remembered per isolate (at most 512 payments, oldest out, 10 minutes each; both numbers are judgments, not measurements). While remembered, a payer-class settle answer for the same payment (README rows 6, 6b, 7, e.g. a spent nonce because the first transfer landed) was cached for the nonce and counted toward the payer's cooldown with 402 `facilitator rejected: …` or `settle failed`; it is now `settle-unconfirmed` again (the A11 402), not cached, not counted. A later successful settle of that payment is served as usual. The `@internal` `_sizes()` test hook gains `unconfirmed`.
- A13 (R013): copies of a payment whose settle is in flight join that settle (one call; only the starter is served). The join had no age limit: if the settle never returned and its release never ran (a request the runtime cancelled), the same payment sent again on that isolate waited for ever, and the entry was never removed. The join now ends 45 s after the settle started (the A10 limit, same status: approved by the owner 2026-11-14; reasoned from the settle route's budget, not measured): the same payment sent again after that is a new attempt with one new settle call and an answer, and old entries are removed when the next settle starts. With a custom `fetch` that ignores the abort signal the first settle can still be running then, so the payment can get a second settle call; one authorization still moves money at most once. No response shape changes.
- A14 (R020): a retry of a payment that is remembered as `settle-unconfirmed` (A12) and met a second fault got that fault's 402 with a full offer (`x-payment-required`, `accepts`, `options`): `settle-retryable` (e.g. a 502 from the settle route), `settle-unreachable` (a connection failure), `settle-throttled`, `payer-cooldown`, `not-yet-valid` / `not-yet-valid-held` (a `valid_after` answer from the settle route), or the local check's `expired` / `not-yet-valid` / `window-too-long` (in practice `authorization expired`: a payment lives about 300 s, the memory 600 s). A client acting on `accepts` could sign a second payment although the first may have moved money. Every such answer is now `settle-unconfirmed` again: the A11 error-only 402 (no `x-payment-required`, no `accepts`, no `Retry-After`). It is not cached, not counted toward the payer's cooldown, records no offer, and writes no `valid_after` hold; before this change a `valid_after` answer for a remembered payment was counted and held. The memory entry is kept and its time is not renewed, so it still ends 600 s after its last row 3a answer. The retry is not stopped early: it still makes a settle call when the cooldown and the bucket allow and the payment is still inside its validity window, and is served if the route confirms it. So while a payment is remembered, every 402 for it is the error-only one. A payment that is not remembered is unchanged, and so is a copy whose signed fields were altered (it does not verify, so it is not that payment). No new header or metric.
- L6, a fix for behaviour 2.2.0 and main have today: requests that arrived while the first request of an isolate was still building the middleware state each built their own state, so the payment cache, the in-flight join, the settle bucket and the per-payer limit did not hold for a cold isolate's first burst (5 concurrent copies of one payment: 5 settle calls, and 5 x 200 if the facilitator confirmed each; 100 concurrent fresh payments from one payer: 100 settle calls). The build is now shared: those requests wait for one build and use one state (1 settle call and one 200; 3 settle calls and 97 `payer-cooldown`), as on a warm isolate. A failed build is not kept; the next request builds again. No response shape changes.
- T1: exported types: `X402VerifyResult.retryAfterS?: number` (hono, optional); `OfferState.heldInWindow: number` and `OfferLedger.recordHeld()` (core). The `@internal` `makeSettlingVerify` return value gains a `_sizes()` test hook.
- Concurrent failures from one payer now each count toward the cooldown (the count is re-read after the settle answer; N at once used to count as 1). Settles in flight now count too (A1), so a concurrent burst from one payer makes 3 settle calls.
- Known cost, now bounded by A3: held repeats stretch the offer grace. A verified unfunded agent sending one held early payment per 60 s from throwaway payer keys got 402 for 121 requests at 1 request/s before the first 302 (main: 3), with 5 settle calls in 280 s (measured by the second review on dd35fc2). No content is served; it is mazed once three first attempts are recorded (README, "Known costs").
- Settle-route HTTP 404 and 405 (a wrong settle URL or method) are now operator faults, `settle-retryable`, not cached, not counted. A settle-route 400 for an out-of-bounds `price_usd` (our misconfiguration) is still charged to the payer.
- `no-transaction-id` and the new `settle-unconfirmed` record no offer (core `isNoOfferFault`, exported): a payer who may have paid is never mazed for it. Known cost: such a payer is not served either.
- The settle classifier uses core's `isOperatorFault`, so a route reason `settle-throttled`, `settle-unreachable`, `settle-retryable` or `settlement-unconfigured` is `settle-retryable`, not cached, not counted (it was cached and counted while hono said "retry the same payment").
- A non-2xx settle answer with `settled: true` is now `settle-unconfirmed` (402 `settlement status unconfirmed; do not pay again, contact the operator`), not cached, not counted; it was `settle-retryable` ("retry the same payment") on 5xx/401/403/429 and a cached, counted `settle-failed` on other 4xx.
- A facilitator reject whose reason contains `valid_after` (authorization not yet valid, e.g. `invalid_exact_evm_payload_authorization_valid_after`) is now transient: 402 `authorization not yet valid` (`not-yet-valid`), not cached, so the same `X-PAYMENT` can be retried. It was cached, counted and `facilitator rejected: …`. That payment is held locally until its `validAfter`: repeats are answered `not-yet-valid-held` (same 402 text) with no settle call and no offer recorded; the first attempt records an offer and counts once per nonce toward the payer's cooldown (a later successful settle clears it), so fresh early nonces from one payer cost 3 settle calls, as on main. On a settle HTTP 5xx it stays `settle-retryable`.
- `settle-throttled` (our settle bucket is empty) records an offer again, so draining the bucket cannot keep a verified agent out of the maze. The README table's "Counted" and "Offer recorded" columns are corrected to match (rows 0b and 5).
- Settle answers are classified by one table (README, "Facilitator damping"). Moved: a settle-route HTTP 400, 404, 413 or 422 (whatever the body, including `settled: true` or non-JSON) is now a payer fault, cached for the nonce and counted toward the cooldown (402 `settle failed`), where it was `settle-retryable`. A facilitator answer `(verify|settle)-failed(401|403|429)` is now an operator fault, `settle-retryable`, not cached, not counted (402 operator-fault text), where it was cached, counted and `settle failed`. Settle-route HTTP 401, 403, 429 and 5xx stay operator faults.
- `settled: true` on a non-2xx settle response is no longer accepted as payment: the origin is not served (402); a 5xx stays `settle-retryable`.
- A settled response now needs a tx id (`transaction`, else `tx`) that is a `0x` + 64-hex hash once trimmed; anything else is `settle failed: no transaction id` (402, `no-transaction-id`), remembered and not counted toward the payer's cooldown.
- An `X-PAYMENT` header longer than 8192 characters is refused as `malformed X-PAYMENT header` (402) before decoding or settling.
- A payment rejected for an operator fault (`isOperatorFault`, now exported from core: `settle-retryable`, `settle-throttled`, `settlement-unconfigured`, `settlement-not-configured`, `settle-unreachable`, `(verify|settle)-error:*`, `(verify|settle)-failed(5xx|401|403|429)`) no longer counts toward or triggers the maze: a verified agent gets the 402 offer again and no offer is ledgered. Exception: `settle-throttled` still records an offer (see above). Payer faults (e.g. `expired`) still count.
- A misspelled `[toll.x402] network` is now a startup/config error:
  `parseConfig` throws a `ConfigError` naming `toll.x402.network` and the
  supported networks (`base-sepolia`, `base`), and the Pages middleware
  rethrows a `ConfigError` instead of failing open to the origin.
- Operator-side settle failures (settle HTTP 401/403/429/5xx, `retryable: true`,
  `settlement-not-configured`, `network-mismatch`, `verify-error:` /
  `settle-error:`, `(verify|settle)-failed(401|403|429|5xx)`) now return
  `settle-retryable`: the payment is not cached and does not count toward
  the payer's cooldown, so the same `X-PAYMENT` can be retried.
- `[toll.x402] skew_tolerance` (default `"60s"`) absorbs client clock drift:
  a proof is `not-yet-valid` only when `validAfter` is past now + skew, and
  `window-too-long` only when `validBefore` is more than 300 s + skew away, so
  a wallet 1 s fast (`validBefore = now+301`) is no longer refused. `expired`
  gets no skew; offers still advertise `maxTimeoutSeconds: 300`. Set `"0s"`
  for the old strict window.
- A rejected `X-PAYMENT` now gets its reason in the 402 body's `error`
  (e.g. `wrong payTo`, `authorization expired`, `nonce already used`), from a
  fixed table so no internal text reaches the payer. With no `X-PAYMENT`
  header `error` stays `X-PAYMENT header is required`.
- The settle verifier takes the transaction id from `data.transaction`, else
  `data.tx`, so a settle answering only `tx` no longer yields an empty
  `X-PAYMENT-RESPONSE.transaction`. A `settled: true` answer with neither now
  stays 402 with reason `no-transaction-id`; that payment is never settled
  again and the payer is not damped.
- The hono floor is raised from `^4.13.7` to `^4.13.16` for
  `@tunnelmindai/fareseal-cloudflare` (dependency) and
  `@tunnelmindai/fareseal-hono` (peer; an installer on an older hono 4.13 gets
  a peer warning). It fixes GHSA-3gg2-335m-rxc6, GHSA-46wx-v44x-9hh2,
  GHSA-4h7h-rv7c-7m2v, GHSA-4m76-xfj5-7975 and GHSA-h7mg-cq63-vhpq.
  Behaviour change from GHSA-h7mg-cq63-vhpq: a path with an encoded line
  terminator (`%0A`, `%0D`, `%E2%80%A8`, `%E2%80%A9`) now passes through the
  fareseal middleware and reaches the origin; on 4.13.13 it returned a 404
  that skipped both.

## 2.2.0

- Renamed the npm packages from `@tunnelmindai/tollbooth-*` to
  `@tunnelmindai/fareseal-*`.
- All seven packages move to one version, 2.2.0, the next minor over 2.1.0,
  because publish.yml refuses mixed versions.

## 2.1.0 — Unreleased

DRAFT (Josh rewrites public prose)

- Renamed on 2026-11-04 from the tollbooth npm scope to the tunnelmindai
  scope: every published package is now `tunnelmindai/tollbooth-<name>` on npm.
- New option `exists: "assets"`: in toll mode, before an offer, HEAD the path
  on `env.ASSETS`; a 404 there answers a plain 404 with no offer, settle,
  maze or receipt. A throwing check falls through to the normal 402 offer and
  is not cached. Answers are cached per isolate (bounded at 1024, oldest out).
  With the option set and no `ASSETS.fetch`, construction throws
  `TollboothBindingMissingError`.
- Built on the new `exists?: (path) => Promise<boolean>` option in
  `@tunnelmindai/tollbooth-hono` (toll mode only, never asked for `free_paths`; a throw
  means "exists"; 404s counted as `not_found` in the report stats).
  `@tunnelmindai/tollbooth-core` now exports `isFreePath`.
- The settle POST body now carries `resource`, the requested URL (origin,
  path and query): `{ payment, price_usd, resource }`.
- New route `GET /_tollbooth/arrival` (from `@tunnelmindai/tollbooth-hono`, so it works
  through `createPagesMiddleware` unchanged): free, never tolled, returns the
  requester's own arrival reading as JSON with `cache-control: no-store` and
  `vary: *` — one row per field read (`name`, `value`, `read`, `used_for`,
  `kept`, `present`), plus identity, decision and `never_read`. Presence-only
  rows (cookie and the secret headers) report `present` while `value` stays
  `null`. Returned only to the
  requester and never stored. New `@tunnelmindai/tollbooth-core` exports, each public for
  the bindings' arrival route or to keep it from drifting:
  - `arrivalReading` (types `ArrivalReading`, `ArrivalRow`, `ArrivalKept`):
    builds the reading; pure, shared by the bindings.
  - `REQUEST_HEADERS_READ`: every header the bindings' request parser reads,
    so the parser and the reading cannot drift (a hono test checks it).
  - `keptFor`: the one rule for what `record()` keeps for a decision, so the
    reading's `kept` column and the agent ledger cannot drift.
  - `LEDGER`: the `kept` value for the agent ledger; hono `record()` compares
    `keptFor` against it.
  - `ARRIVAL_KEPT_SCOPE`: the `kept_scope` of every reading (the arrival
    request itself is never recorded).
  - `SIGNATURE_UNVERIFIED`: the `identity.via` marker for a signed request on
    the arrival route, which never fetches the signer's directory.
  - `identify`: the arrival route is a free path, where `decide()` skips
    identity, so the route calls it directly.
  - `verifiedPass`: `decide()` Step 1b as a pure check, so the route reads the
    same verified search/preview outcome without running `decide()`.
- `@tunnelmindai/tollbooth-core`, `@tunnelmindai/tollbooth-hono` and `@tunnelmindai/tollbooth-cloudflare` move to
  2.1.0 together. The site vendors the dist by hand ("built from bb68bbd",
  tunnelmind-site/vendor/README.md:7), so the site run (connect-arrival-1b)
  must re-vendor the 2.1.0 dist of core, hono and cloudflare.

## 2.0.1 — 2026-10-06

DRAFT (Josh rewrites public prose)

- The service-binding fetch was called detached, so on workerd it threw
  "Illegal invocation" and the settle, snapshot and report paths that route
  through the binding failed. The fix calls `binding.fetch(...)` as a method.

## 2.0.0 — 2026-09-17

**Breaking.** No global-fetch fallback (TunnelMind estate hardening, spec 088).

- `binding` named but absent from env (or without a `fetch()`) → construction
  throws `TollboothBindingMissingError` on the first request, before any
  outbound call. The middleware rethrows it instead of failing open: a missing
  outbound route is a deployment error, and the 1.x fallback posted test-suite
  snapshots into a production collector on 2026-09-14/15.
- Outbound reporting configured (site key + `report_url`, `settle`, or
  `snapshots`) with neither `binding` nor the new `fetch` option → the same
  error. Nothing outbound configured → no route needed, nothing changes.
- New option `fetch?: FetchLike` — an explicit fetcher for hosts without a
  service binding and for tests (a recording stub). Never defaulted.
- Every outbound write carries `x-tollbooth-env`: `production` unless a test
  runner is detectable (`VITEST`, `NODE_ENV=test`, a vitest worker global) or
  `TOLLBOOTH_ENV` is set (sent verbatim). A collector refuses anything but
  `production`. A site that sets nothing writes as production.
- The authed `/_tollbooth/report` response carries `x-tollbooth-env`.
- Exports: `TollboothBindingMissingError`, `tollboothEnvMarker`,
  `testRunnerDetected`, `ENV_HEADER`, type `FetchLike`.

Migration: sites already passing `binding: "DATA_API"` with the binding
present need no change. Tests must bind a stub (or pass `fetch`), which the
1.x fallback let them skip — that was the bug.

## 1.0.0 — 2026-08-25

Initial release (T-025 acceptance).
