# TASKS — tollbooth

Format: `T-nnn (deps) — task → done-when`. Sized for one Claude Code session each. Do them in order; ACs reference spec.md.

## Phase 0 — Scaffold
- **T-001** — pnpm monorepo per plan §2; strict tsconfig; vitest; CI (lint, typecheck, test) → repo builds green empty.
- **T-002** (T-001) — `core`: config schema (zod) + TOML loader; startup failure names bad key → AC-1.3 test green.
- **T-003** (T-001) — `core`: RFC 8785 canonicalizer (port from TunnelMind JCS code) → RFC appendix vectors pass.
- **T-004** (T-003) — `core`: keygen/load (0600), sign/verify helpers → AC-1.2 test green.

## Phase 1 — Identify · Offer · x402
- **T-005** (T-004) — `core`: WBA verifier, RFC 9421 ed25519 subset (port from P71) → valid/invalid/tampered fixtures pass.
- **T-006** (T-002) — `core`: heuristics module + UA fixtures file → D-4 ladder unit tests, human fixtures all pass-through.
- **T-007** (T-005,T-006) — `core`: decision pipeline steps 1–3,8 (free_paths, identify, human pass, 402 offer w/ JSON body) → US-5 ACs + AC-2.1 (offer shape only).
- **T-008** (T-007) — `hono`: middleware binding + observe mode + `/_tollbooth/report` (bearer `report_token`; 404 until set) → AC-1.1 integration test incl. unauthenticated 404.
- **T-009** (T-007) — `adapter-x402`: buildOffer + verifyProof, testnet fixture proofs → AC-2.1, AC-2.2, AC-2.3.
- **T-010** (T-008,T-009) — offer-state LRU (D-3) + toll mode wiring → an agent with valid payment passes; unpaid gets 402s. *Milestone: usable x402 tollbooth.*

## Phase 2 — Vouchers · Stripe
- **T-011** (T-004) — `core`: voucher mint/verify/decrement/resign (fresh jti each re-sign, D-1), key-bound + bearer flag → AC-3.2, AC-3.4, property tests (credits never increase; jti unique across a resign chain).
- **T-012** (T-011) — jti LRU damping → AC-3.3.
- **T-013** (T-011) — `adapter-stripe`: webhook route (sig verify, custom-field agent_pubkey, mint into TTL'd session map) + `GET /_tollbooth/voucher/{CHECKOUT_SESSION_ID}` render-once redemption (D-8) → AC-3.1 with mocked Stripe events; second redemption attempt 404s.
- **T-014** (T-010,T-012,T-013) — pipeline step 5 wiring + `Link` header on 402 → full US-3 integration test.

## Phase 3 — Maze · Receipts · Verify
- **T-015** (T-002) — `cli corpus`: seeded deterministic generator per D-5 → same seed ⇒ same corpus hash; 2k pages ≤ 7 MB.
- **T-016** (T-015) — `maze`: handler w/ prefix, X-Robots-Tag, delay, size cap, robots.txt fragment output → AC-4.3.
- **T-017** (T-010,T-016) — consequence wiring: offers-exhausted → maze; spoof → maze; redemption on payment → AC-4.1, AC-4.2, AC-4.4.
- **T-018** (T-003,T-004) — `core`: receipt build/sign per AC-6.2 (path_class only, no bodies; SPOOF → claimed_key, agent_key null) → schema + signature tests; sentinel test: request whose body contains a known marker ⇒ marker appears in no emitted receipt.
- **T-019** (T-018) — batched reporter (bounded, drop-oldest, non-blocking) → AC-6.3; queue-full drops counted.
- **T-020** (T-018) — `cli verify` offline → AC-6.1 test runs with network disabled.

## Phase 4 — Ship
- **T-021** (T-014,T-017) — examples: express-node, bun-hono, cloudflare-worker, agent-client.ts (≤ 80 lines) → each runs against local instance in CI; AC-7.1, AC-7.2.
- **T-022** (all) — `bench/bench.ts` → NFR-1 met or hot path fixed; table auto-inserted into README.
- **T-023** (T-022) — README: 10-minute quickstart (observe → toll), honest-limits section covering every bullet of spec §8, receipt verification walkthrough → a cold reader test: hand it to someone, time them.
- **T-024** (T-023) — constitution compliance sweep: checklist review of every article against the code; license headers; `npm publish --dry-run` clean → v1.0.0 tag.

## Phase 5 — Distribution
- **T-025** (T-024) — `cloudflare`: batteries-included Pages middleware, `createPagesMiddleware(options)` (ADR-004) — TOML config (or an env→TOML builder for tokens/prices in vars); per-isolate state cache keyed off the built config; seeded maze corpus; receipt reporting + signed traffic snapshots, optionally over a service binding (same-zone fetches 522 on Cloudflare); settle-then-serve x402 (local verifyProof, then a settle POST — pass ONLY on `settled:true`, fails closed) with facilitator damping (seen-payment cache + payer cooldown, LRU-capped, eviction = amnesty); whole middleware fails OPEN. Widens hono's `X402Adapter.verifyProof` to allow a Promise return (core's `VerifyPayment` always did; the pipeline awaits) → acceptance tests port every behavior the tunnelmind.ai deployment proved live: human pass, offer, free paths exact+prefix, settle pass/fail/garbage/unconfigured, damping, price forwarding, report diagnostics, snapshot signature, fail-open, env-driven config rebuild.

## Post-v1 backlog (do not start)
sidecar single binary (nginx auth_request) · WordPress wrapper · Caddy/Traefik modules · voucher top-up flow · conduct-history query client.
