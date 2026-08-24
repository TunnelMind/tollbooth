# SPECIFICATION — tollbooth

## 1. One-paragraph intent

A self-hosted middleware package that lets any site owner replace "block all bots" with a fair door: identify agents via Web Bot Auth, **offer** them paid access (x402 micropayment or Stripe prepaid voucher), pass humans and paying agents, and apply a **consequence** (static decoy maze) plus a **signed conduct receipt** only to agents that ignored the offer or spoofed identity. No hosted service, no database, MIT-licensed.

## 2. Actors

| Actor | Description |
|---|---|
| Operator | Site owner installing the middleware. Assumed skill: can `npm install` and edit a TOML file. |
| Human visitor | Browser traffic. Must never be affected. |
| Honest agent | Crawler presenting a valid Web Bot Auth signature; willing to pay or obey robots. |
| Freeloader | Agent ignoring 402 offers, or hammering, or crawling disallowed paths. |
| Spoofer | Traffic presenting an invalid/forged Web Bot Auth signature or impersonating a known-good UA. |
| Verifier | Any third party checking a receipt offline with the site's public key. |

## 3. User stories & acceptance criteria

### US-1 · Operator installs in observe mode (default)
As an operator, I install the middleware with a 5-line config and see who's knocking before charging anyone.
- **AC-1.1** Given a fresh install with `mode = "observe"`, when any traffic arrives, then all requests pass unmodified and an in-memory summary (per agent key: request count, paths sampled, robots compliance, would-have-paid estimate) is available at a local, operator-authenticated endpoint `GET /_tollbooth/report`.
- **AC-1.2** Given no `site_key` in config, when the app starts, then a keypair is generated, written to the configured path with mode 0600, and the public key is printed once.
- **AC-1.3** Given an invalid config value, when the app starts, then startup fails with the offending key named. No partial start.

### US-2 · Honest agent pays per-request via x402
- **AC-2.1** Given `mode = "toll"`, when a request arrives bearing a valid Web Bot Auth signature and no payment, then the response is `402` with x402 payment-required headers containing price, pay-to address, and network from config — and a `Link` header to the Stripe voucher option.
- **AC-2.2** Given a valid x402 payment proof on the retry, when verification succeeds locally, then the request passes, and (if `report=true`) a `PASS_PAID` receipt is emitted.
- **AC-2.3** x402 verification MUST be adapter-isolated: core never imports chain libraries.

### US-3 · Agent operator prepays via Stripe, crawler spends a voucher
- **AC-3.1** Given the operator configured `stripe.payment_link` + webhook secret, when Stripe fires `checkout.session.completed` at the package-mounted webhook route, then a voucher is minted: `{ agent_key, credits, expires, jti, site_sig }` — key-bound to the agent public key the buyer supplied in the checkout's custom field — and delivered per §5.3.
- **AC-3.2** Given a request with header `Tollbooth-Voucher` whose signature verifies, whose `expires` is future, whose `agent_key` matches the request's verified Web Bot Auth key, and whose `credits > 0`, then the request passes and the response carries `Tollbooth-Voucher` re-signed with `credits - 1`.
- **AC-3.3** Given a voucher `jti` seen more than `replay_window` times in the in-memory LRU, then further spends of that jti get `402` (soft double-spend damping; Article V.14 applies).
- **AC-3.4** A voucher presented by a *different* verified agent key MUST be rejected `403`, and a `VOUCHER_MISMATCH` receipt emitted.

### US-4 · Freeloader meets the maze
- **AC-4.1** Given an agent key that received ≥ `offer_grace` distinct 402 offers within `window` and continued requesting content paths unpaid, when its next request arrives, then it is routed to the maze prefix and a `TOLL_IGNORED` receipt is emitted.
- **AC-4.2** Given a request whose claimed Web Bot Auth signature fails verification, then route to maze immediately and emit `SPOOF` receipt. (Offer step skipped per Constitution II.5 spoofing clause.)
- **AC-4.3** Maze responses: static pages from the pre-generated corpus, interlinked ≥ depth 20, `X-Robots-Tag: noindex, nofollow`, throttled to `maze_delay_ms`, ≤ `maze_page_bytes` each. Serving cost per maze request MUST be O(file read).
- **AC-4.4** A mazed key that later pays MUST be un-mazed on next valid payment (redemption path — the exit is always open).

### US-5 · Human is invisible to all of this
- **AC-5.1** Given a request with no Web Bot Auth signature and no agent heuristics matched (heuristics list in plan §6), then pass. No challenge pages, no CAPTCHA, ever.
- **AC-5.2** Given ambiguity (heuristics disagree), then pass (fail-open) and count it in the observe report.
- **AC-5.3** `free_paths` pass for everyone before any other logic runs.

### US-6 · Verifier checks a receipt offline
- **AC-6.1** Given a receipt JSON and the site public key, when `tollbooth verify receipt.json --pubkey <key>` runs with networking disabled, then it prints PASS/FAIL for (canonical form, signature, schema).
- **AC-6.2** Receipt schema (canonicalized per RFC 8785 before signing):
```json
{
  "v": 1,
  "type": "TOLL_IGNORED | SPOOF | PASS_PAID | VOUCHER_MISMATCH",
  "site": "<site ed25519 pub, base64url>",
  "agent_key": "<agent pub | null>",
  "ua": "<user-agent string>",
  "path_class": "<first path segment only>",
  "count": 17,
  "window_start": "<RFC3339>",
  "window_end": "<RFC3339>",
  "sig": "<ed25519 over JCS of all above>"
}
```
Note `path_class`, not full paths, and no bodies — Constitution III.9.
- **AC-6.3** If `report = true`, receipts POST (batched, fire-and-forget, backoff, never blocking a request) to the configured log endpoint. Default endpoint: none. TunnelMind's log is an *example* value in docs, not a default.

### US-7 · Agent developer integrates in minutes
- **AC-7.1** Repo ships `examples/agent-client.ts`: given a 402 response, parse offers, choose x402 or voucher, retry. ≤ 80 lines.
- **AC-7.2** The 402 body is machine-readable JSON listing every enabled payment option with enough data to complete each without human docs.

## 4. Functional requirements (traceable)

- **FR-1** Detect agent traffic: Web Bot Auth verification (RFC 9421 profile) + conservative heuristic fallback.
- **FR-2** Serve 402 offers with x402 headers and machine-readable JSON body.
- **FR-3** Verify x402 payment proofs via adapter.
- **FR-4** Mint, verify, decrement, and re-sign key-bound vouchers; Stripe webhook route included.
- **FR-5** Track offer/ignore state per agent key in bounded in-memory structures (LRU, max entries configurable).
- **FR-6** Serve static maze under one prefix with hygiene headers and throttle.
- **FR-7** Emit signed, canonicalized conduct receipts; optional batched reporting.
- **FR-8** Observe-mode report endpoint.
- **FR-9** CLI: `keygen`, `verify`, `corpus` (maze generation), `voucher inspect`.
- **FR-10** Config: TOML, zod-validated, documented defaults for every key.

## 5. Non-functional requirements

- **NFR-1 Overhead**: pass-path added latency ≤ 1 ms p50 / ≤ 5 ms p99 on the benchmark script (no network calls on the hot path except x402 proof verification, which is the agent's cost to bear via retry).
- **NFR-2 Memory**: bounded — all maps LRU-capped; defaults sized for a 512 MB VPS.
- **NFR-3 Footprint**: core + hono middleware install ≤ 5 MB node_modules added (excluding adapters).
- **5.3 Voucher delivery**: webhook response page shows the voucher once + Stripe receipt email contains it; no storage (Stripe is the record of purchase).

## 6. Explicitly out of scope for v1

Dashboards/UI beyond the report JSON · WordPress plugin (wrap later) · nginx/Caddy sidecar (Phase 4, separate binary) · dynamic/LLM maze content · reputation scoring or any verdict computation · payments other than x402 + Stripe · rate limiting as a general feature (only the toll logic's own windows).

## 7. Success criteria for v1.0 release

All ACs green in CI · a stranger can go from `npm install` to observing traffic in ≤ 10 minutes using only the README · `tollbooth verify` validates a receipt on an air-gapped machine · benchmark script output published in README.
