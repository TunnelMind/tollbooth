# @tunnelmindai/fareseal-cloudflare

Tollbooth was renamed Fareseal on 2026-11-10.

## Unreleased

- An `X-PAYMENT` header longer than 8192 characters is refused as `malformed X-PAYMENT header` (402) before decoding or settling.
- A misspelled `[toll.x402] network` is now a startup/config error:
  `parseConfig` throws a `ConfigError` naming `toll.x402.network` and the
  supported networks (`base-sepolia`, `base`), and the Pages middleware
  rethrows a `ConfigError` instead of failing open to the origin.
- Operator-side settle failures (settle HTTP non-2xx, `retryable: true`,
  `settlement-not-configured`, `network-mismatch`, `verify-error:` /
  `settle-error:`, `(verify|settle)-failed(5xx)`) now return
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
