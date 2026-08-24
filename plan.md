# PLAN — tollbooth

## 1. Architecture

```
                         ┌────────────────────────────────────────────┐
 request ──► middleware  │ 1 free_paths?          ──► pass            │
             (hono)      │ 2 identify: WBA verify | heuristics | none │
                         │ 3 human/ambiguous      ──► pass            │
                         │ 4 spoofed signature    ──► maze + SPOOF    │
                         │ 5 voucher valid?       ──► pass, resign −1 │
                         │ 6 x402 proof valid?    ──► pass (+receipt) │
                         │ 7 offers exhausted?    ──► maze + receipt  │
                         │ 8 else                 ──► 402 offer       │
                         └────────────────────────────────────────────┘
 state: in-memory LRUs only        crypto: site Ed25519 keypair
 side effects: receipt batch queue (optional, non-blocking)
```

Decision order is normative (Constitution II). Steps 1–3 are the hot path and must be allocation-light.

## 2. Repo layout (pnpm monorepo)

```
tollbooth/
├─ constitution.md  spec.md  plan.md  tasks.md
├─ packages/
│  ├─ core/            # zero-framework logic: identify, offer state, voucher,
│  │                   # receipts, canonicalize, config schema. No HTTP imports.
│  ├─ hono/            # the middleware: thin binding of core to Hono
│  │                   # (one package → Node, Bun, Cloudflare Workers)
│  ├─ adapter-x402/    # x402 offer headers + proof verification
│  ├─ adapter-stripe/  # webhook route handler + voucher mint
│  ├─ maze/            # corpus loader + handler; corpus generator lives in cli
│  └─ cli/             # keygen · verify · corpus · voucher inspect
├─ examples/
│  ├─ express-node/  ├─ bun-hono/  ├─ cloudflare-worker/
│  └─ agent-client.ts
├─ bench/bench.ts
└─ docs/adr/
```

## 3. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript strict | reach; Constitution VII.20 |
| HTTP | Hono middleware | one codebase covers Node/Bun/Workers |
| Crypto | @noble/ed25519 + @noble/hashes | audited, zero-dep, works in Workers |
| Canonicalization | own ~60-line RFC 8785 impl in core | port from TunnelMind's existing JCS code; avoids a dep |
| Config | TOML via `smol-toml`, validated by zod | human-editable; hard startup failure |
| WBA verify | own RFC 9421 subset impl in core | port from P71; only ed25519 profile |
| Tests | vitest + integration via hono test client | ACs verbatim as integration tests |
| Voucher encoding | base64url(JCS JSON) + detached sig header | greppable, inspectable, no JWT dep |

Runtime dep count check (core): noble ed25519, noble hashes, smol-toml, zod = 4. Budget met.

## 4. Key design decisions (pre-made; deviations need an ADR)

**D-1 Voucher format** — `Tollbooth-Voucher: <b64url payload>.<b64url sig>`; payload `{v, agent_key, credits, expires, jti, iat}`; signed by site key; verified and re-signed with `credits-1` **and a freshly generated `jti`** on each pass — each signed voucher state has a unique jti, so the jti LRU (D-2) damps replay of one *state* while sequential spending is unlimited. Spend requires the request's WBA signature to verify against `agent_key` (proof-of-possession). Bearer mode replaces that check with nothing — flag-gated.

**D-2 Double-spend stance** — jti LRU with `replay_window` tolerance per instance. Multi-instance operators share nothing; docs state the honest consequence (soft over-spend bounded by expiry × instances). No shared store. Ever. (Article I, V.)

**D-3 Offer-state ledger** — LRU map agent_key → {offers_sent, first_seen, last_seen, paid_ever}. Bounded (default 50k keys). Eviction = amnesty. Amnesty is acceptable; a database is not.

**D-4 Identification ladder** — (a) valid WBA sig → identified agent. (b) sig presented but *cryptographically* invalid → spoofer; sig valid but temporally stale (expiry / `created` beyond skew tolerance, default ±300 s) → fall through to (c), never spoofer (Constitution IV.13). (c) no sig + heuristics (UA contains bot/crawler/spider token list, or known agent-UA prefixes, or `Accept` lacks text/html with no cookies AND no `Sec-Fetch-Site`) → anonymous agent: gets offers, never maze (II.5, II.6). (d) none of the above → human, pass. Heuristic list is data (`core/src/heuristics.ts`), unit-tested against a fixtures file of real UA strings.

**D-5 Maze corpus** — generated at build/CLI-time: templated pseudo-articles from a wordlist grammar, deterministic from a seed, internal links only within prefix, sitemap-free. Default 2,000 pages ≈ 6 MB. Served via streamed file reads with `maze_delay_ms` (default 800) via timer, not busy-wait.

**D-6 Receipts pipeline** — synchronous sign (fast), async batched POST if enabled; queue bounded, drop-oldest, drops counted in report. Never blocks or fails a request.

**D-7 x402 adapter boundary** — adapter exposes `buildOffer(cfg) → headers/body` and `verifyProof(req, cfg) → {ok, payer}`. Chain specifics stay inside; testnet defaults in examples (Constitution V.15).

**D-8 Stripe flow** — Payment Link with custom field `agent_pubkey` and success URL pointing at the package-mounted redemption route; webhook verifies Stripe signature with operator secret and mints the voucher into a TTL'd in-memory session→voucher map (`redeem_ttl`, LRU-capped; the webhook's own response goes to Stripe and reaches no buyer). `GET /_tollbooth/voucher/{CHECKOUT_SESSION_ID}` renders exactly once, then deletes. Expired unredeemed → operator re-mints via `cli voucher mint`; Stripe is the record of purchase. No customer table.

## 5. Config surface (complete, with defaults)

```toml
mode = "observe"              # observe | toll
site_key_path = "./tollbooth.key"
free_paths = ["/robots.txt", "/favicon.ico"]
report = false                # receipt reporting off by default
# report_url = "https://…"    # e.g. a transparency log ingest; no default
report_token = ""             # bearer token for GET /_tollbooth/report; endpoint 404s until set
wba_skew_tolerance = "300s"   # temporal slack before a sig counts as stale (D-4b)

[toll]
price_usd = "0.001"
offer_grace = 3               # distinct 402s before consequence
window = "10m"
[toll.x402]
enabled = true
network = "base-sepolia"      # testnet example; operator sets real values
pay_to = "0x…"
[toll.stripe]
enabled = false
payment_link = ""
webhook_secret = ""
credits_per_purchase = 5000
voucher_ttl = "30d"
redeem_ttl = "15m"            # session→voucher map TTL for the success-URL redemption route (D-8)

[maze]
enabled = true
prefix = "/.well-known/tollbooth-maze"   # operator SHOULD change
corpus_path = "./maze-corpus"
maze_delay_ms = 800
page_bytes_max = 4096

[limits]
agent_ledger_max = 50000
jti_lru_max = 100000
replay_window = 2
```

## 6. Test strategy

Unit: JCS vectors (RFC 8785 appendix), WBA fixtures (valid/invalid/tampered), voucher lifecycle, heuristics fixture file. Integration: every AC as a named test (`us4_ac41_freeloader_mazed_after_grace`). Property: voucher resign chain never increases credits; receipt JCS stable under key reordering. Bench: `bench/bench.ts` drives pass-path p50/p99 (NFR-1) and prints the README table.

## 7. Phases → tasks.md

P0 scaffold · P1 core identify/offer/402 + x402 (a usable toll with no Stripe, no maze) · P2 vouchers + Stripe · P3 maze + receipts + verify CLI · P4 polish, bench, examples, README, publish. Sidecar binary and WordPress wrapper are post-v1.
