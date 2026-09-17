# @tollbooth/cloudflare

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
