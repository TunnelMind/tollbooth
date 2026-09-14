# tollbooth

Pay the toll or meet the maze. tollbooth is self-hosted middleware that
replaces "block all bots" with a fair door: it identifies agents via
[Web Bot Auth](https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/),
**offers** them paid access (an [x402](https://www.x402.org/) micropayment or
a Stripe-purchased voucher), passes humans and payers untouched, and routes
agents that ignore the offer — or forge an identity — into a static decoy
maze, leaving behind a **signed conduct receipt** anyone can verify offline.

No hosted service. No database. No telemetry. MIT.

## The pipeline (the order is a promise)

| step | check | outcome |
|---|---|---|
| 1 | `free_paths` (robots.txt, favicon, yours) | pass, always, for everyone |
| 2 | identify: Web Bot Auth → heuristics → neither | — |
| 3 | human or ambiguous | pass — no challenge pages, no CAPTCHA, ever |
| 4 | forged signature | maze |
| 5 | valid voucher | pass, re-signed voucher with one credit less |
| 6 | valid x402 payment | pass |
| 7 | ignored ≥ `offer_grace` offers in the window | maze (a later payment un-mazes: the exit is always open) |
| 8 | otherwise | `402` with a machine-readable offer |

The offer always precedes the consequence, and a human is never tolled — a
false positive on a person is treated as the worst failure this software can
have.

## Install

> **v1.0.0 is tagged but not yet on npm.** Until the packages publish, install
> from source — everything below works from a clone, and the `@tollbooth/*`
> imports resolve through the workspace unchanged. They become
> `npm install @tollbooth/core @tollbooth/hono …` the day the packages land on
> npm; the import lines and the code do not change.

```bash
git clone https://github.com/TunnelMind/tollbooth
cd tollbooth
pnpm install && pnpm build
```

`pnpm build` is `tsc -b` — it emits every package's `dist/`. Run it once after
cloning (and `pnpm test` runs it for you). The runnable [examples/](examples/)
are the fastest way to see the snippets below working end to end.

## Quickstart: observe first

Watch who is knocking before charging anyone. Observe mode, every request
passes unmodified:

```ts
import { serve } from "@hono/node-server";
import { tollbooth } from "@tollbooth/hono";
import { Hono } from "hono";

const app = new Hono();
app.use(tollbooth({ config: `report_token = "choose-a-secret"` }));
app.get("/", (c) => c.text("your site"));
serve({ fetch: app.fetch, port: 8787 });
```

Then look at the report:

```bash
curl -H "Authorization: Bearer choose-a-secret" http://localhost:8787/_tollbooth/report
```

```json
{
  "mode": "observe",
  "humans_passed": 1042,
  "free_path_hits": 33,
  "receipts_queued": 0,
  "receipts_dropped": 0,
  "agents": [
    {
      "key": "anon:python-requests/2.32.3",
      "kind": "anonymous-agent",
      "ua": "python-requests/2.32.3",
      "requests": 312,
      "paths": ["/articles", "/pricing"],
      "robots_txt_fetched": false,
      "would_have_paid_usd": "0.3120"
    }
  ]
}
```

The endpoint returns 404 until `report_token` is set, and 401 on a wrong
bearer.

## Turning on the toll

Config is TOML, validated hard at startup — an invalid value names the
offending key and nothing starts. Example values below are **testnet**;
settlement configuration is yours.

```toml
# tollbooth.toml
mode = "toll"
report_token = "choose-a-secret"

[toll]
price_usd = "0.001"
offer_grace = 3
window = "10m"

[toll.x402]
network = "base-sepolia"          # testnet example
pay_to = "0xYOUR_ADDRESS"

[toll.stripe]                     # optional second rail: prepaid vouchers
enabled = true
payment_link = "https://buy.stripe.com/..."
webhook_secret = "whsec_..."
```

```ts
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { makeStripeAdapter } from "@tollbooth/adapter-stripe";
import { parseConfig, toBase64Url } from "@tollbooth/core";
import { loadOrCreateSiteKey } from "@tollbooth/core/node";
import { tollbooth } from "@tollbooth/hono";
import { corpusFromMap, makeMazeHandler, robotsFragment } from "@tollbooth/maze";
import { loadCorpusDir } from "@tollbooth/maze/node";
import { Hono } from "hono";

const cfg = parseConfig(readFileSync("./tollbooth.toml", "utf8"));

// generated once and printed exactly once, on creation
const key = await loadOrCreateSiteKey(cfg.site_key_path);
if (key.created) console.log(`site public key: ${toBase64Url(key.publicKey)}`);
const siteKeys = { secret: key.secretKey, pub: key.publicKey };

// pre-generate the maze corpus first (from source until published:
//   node packages/cli/dist/cli.js corpus --out ./maze-corpus
// once on npm:  npx @tollbooth/cli corpus --out ./maze-corpus)
const maze = makeMazeHandler({ corpus: await loadCorpusDir(cfg.maze.corpus_path), cfg });

const app = new Hono();
app.use(
  tollbooth({
    config: cfg,
    siteKeys,
    x402: { buildOffer, verifyProof },
    stripe: makeStripeAdapter({ cfg, siteSecret: key.secretKey }),
    maze,
  }),
);
app.get("/", (c) => c.text("your site"));
serve({ fetch: app.fetch, port: 8787 });
```

Append the maze's disallow lines to your robots.txt so no honest crawler
wanders in:

```ts
console.log(robotsFragment(cfg.maze.prefix));
// User-agent: *
// Disallow: /.well-known/tollbooth-maze/
```

Stripe setup: create a Payment Link with a custom text field whose key is
`agent_pubkey`, set its success URL to
`https://your-site/_tollbooth/voucher/{CHECKOUT_SESSION_ID}`, and point the
webhook (event `checkout.session.completed`) at
`https://your-site/_tollbooth/stripe-webhook`. The buyer's crawler collects
its voucher from the success page — shown exactly once — and spends it in the
`Tollbooth-Voucher` header; every response carries the re-signed successor
with one credit less. The same middleware runs on Bun and Cloudflare Workers:
see [examples/](examples/).

## For agent developers

A `402` from a tollbooth site is an offer, not a wall. The body lists every
enabled payment option with enough data to complete each:

```json
{
  "v": 1,
  "price_usd": "0.001",
  "options": [
    { "method": "x402", "network": "base-sepolia", "pay_to": "0x…", "price_usd": "0.001" },
    { "method": "stripe-voucher", "payment_link": "https://buy.stripe.com/…",
      "credits": 5000, "voucher_header": "Tollbooth-Voucher" }
  ]
}
```

[examples/agent-client.ts](examples/agent-client.ts) is a complete paying
client in under 80 lines: request, read the offer, pay by voucher or by
signing an x402 authorization, retry.

## Receipts: check a site's claims offline

With `report = true` and a `report_url`, receipts are POSTed (batched,
fire-and-forget, never blocking a request) to whatever log the operator
chooses — reporting is **off by default, forever**, and the package is fully
functional without it. A receipt records observations, never judgments:

```json
{
  "v": 1,
  "type": "TOLL_IGNORED",
  "site": "b64url-site-public-key",
  "agent_key": "b64url-agent-public-key",
  "claimed_key": null,
  "ua": "SomeCrawler/2.0",
  "path_class": "/articles",
  "count": 17,
  "window_start": "2026-08-26T09:00:00.000Z",
  "window_end": "2026-08-26T09:10:00.000Z",
  "sig": "b64url-ed25519-signature"
}
```

`path_class` is the first path segment only; request and response bodies are
never captured — a test in this repo plants a marker in a request body and
asserts it appears in no receipt. `SPOOF` receipts never name a verified
`agent_key`: they carry the *claimed* key, explicitly unverified, because
anyone can send garbage signatures naming any key.

Verify one on an air-gapped machine — only the receipt and the site's public
key are needed:

```bash
# from source until published:  node packages/cli/dist/cli.js verify …
npx @tollbooth/cli verify receipt.json --pubkey <site-public-key>
# schema: PASS
# canonical form: PASS
# signature: PASS
# PASS
```

## Reporting to the Conduct Log Commons (optional, off by default)

TunnelMind runs a free, public, append-only log of tollbooth conduct data: free to report to,
free to read, verifiable without trusting TunnelMind. Reporting stays opt-in and off by default
(Article I.4). Three lines turn it on:

```toml
report = true
report_url = "https://data.tunnelmind.ai/v1/tollbooth/receipts"
report_domain = "your-domain.example"   # the domain that vouches for your site key (below)
```

`report_domain` is a **claim**. The commons turns it into a fact by fetching
`https://your-domain.example/.well-known/tollbooth-site.json`, which you serve as

```json
{ "v": 1, "keys": ["<your site public key, base64url>"] }
```

Until a domain vouches for a key its receipts are stored but labelled *unattested* and kept out of
the exhibits; there is no token and nothing to register — the signature on each receipt is the
authentication. Reads: `GET https://data.tunnelmind.ai/v1/tollbooth/stats` (live exhibit) and
`GET https://data.tunnelmind.ai/v1/tollbooth/export?day=YYYY-MM-DD` (a UTC day of verbatim signed
documents as JSON Lines, verifiable offline with `tollbooth verify`). How-to and stated limits:
https://tunnelmind.ai/conduct/join

## Honest limits — read before deploying

- **Enforcement is soft.** Vouchers are stateless signed credits: parallel
  replay of one voucher state can over-spend within its lifetime, bounded by
  `replay_window`, expiry, and your instance count. Instances share nothing;
  every cache and ledger is a bounded LRU whose eviction is amnesty. This is
  economically sufficient at micro-prices; it is not a hard ledger, and no
  database will be added to change that.
- **Stealth agents pass free.** An agent driving a full browser with
  human-shaped headers is indistinguishable from a human and passes untolled.
  That is the price of failing open: any mechanism that could catch it would
  sooner or later toll a person.
- **Humans using curl see 402s.** Non-browser tooling matches the agent
  heuristics and receives payment offers in toll mode. It is never mazed, and
  `free_paths` always pass.
- **Key-less freeloaders cannot be mazed.** The offer ledger is keyed by
  verified agent key; anonymous traffic receives offers indefinitely and the
  consequence never escalates. Tolling it would require fingerprinting, which
  this package refuses to do.
- **`ua` is free text.** It is the one unconstrained field in a receipt and
  carries whatever the agent put there. Every other field is enumerated,
  derived, or a key.

## Benchmarks

<!-- bench:start -->
_Generated by `bench/bench.ts` on Node v22.22.0; in-process `app.request`, 2000 samples per row._

| scenario | p50 | p99 |
|---|---|---|
| baseline app, no tollbooth | 0.011 ms | 0.101 ms |
| human pass-through | 0.013 ms | 0.111 ms |
| free path pass-through | 0.007 ms | 0.055 ms |
| agent 402 offer | 0.013 ms | 0.110 ms |
| voucher spend + re-sign (ed25519 x2) | 2.126 ms | 5.056 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.001 ms, added p99 0.011 ms)
<!-- bench:end -->

## Packages

| package | what it is | runtime deps |
|---|---|---|
| `@tollbooth/core` | identify, offer state, vouchers, receipts, config — no HTTP, no chain code | zod, smol-toml, @noble/ed25519 |
| `@tollbooth/hono` | the middleware: one binding for Node, Bun, Workers | core (+ your hono) |
| `@tollbooth/adapter-x402` | x402 offers and local proof verification | @noble/curves, @noble/hashes |
| `@tollbooth/adapter-stripe` | webhook + render-once voucher redemption, no Stripe SDK | core |
| `@tollbooth/maze` | decoy corpus loading and serving | none |
| `@tollbooth/cli` | `corpus`, `verify`, `voucher inspect`/`mint` | core |

## Development

This repo is spec-driven: [constitution.md](constitution.md) holds the
non-negotiables, [spec.md](spec.md) the requirements, [plan.md](plan.md) the
architecture, [tasks.md](tasks.md) the build order. The workflow is described
in [docs/development.md](docs/development.md). License: [MIT](LICENSE).
