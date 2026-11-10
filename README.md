# Fareseal

Fareseal was called Tollbooth until 2026-11-10; the name changed because an open-source x402 crawler gate already uses it.

Pay the toll or meet the maze. Fareseal is self-hosted middleware that
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
| 1a | `exists` (opt-in, toll mode only) says the path is missing | plain `404` — no offer, settle, maze or receipt |
| 1b | `pass_verified` (opt-in, default off) | verified search / preview bots pass |
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

> **The packages are not yet on npm** (v2.1.0 in the tree). Five will publish,
> by the owner:
> `@tunnelmindai/fareseal-core`,
> `@tunnelmindai/fareseal-hono`,
> `@tunnelmindai/fareseal-maze`,
> `@tunnelmindai/fareseal-adapter-x402` and
> `@tunnelmindai/fareseal-cloudflare`. Until then, install from source —
> everything below works from a clone, and the `@tunnelmindai/fareseal-*`
> imports resolve through the workspace.

```bash
git clone https://github.com/TunnelMind/tollbooth
cd tollbooth
pnpm install && pnpm build
```

`pnpm build` is `tsc -b` — it emits every package's `dist/`. Run it once after
cloning (and `pnpm test` runs it for you). The runnable [examples/](examples/)
are the fastest way to see the snippets below working end to end.

Run the tests from the repo root with `pnpm test` (`pretest` is `tsc -b`, then
`vitest run`). Don't use `pnpm -r test`: the workspace packages define no
`test` script, so it runs nothing.

## Quickstart: observe first

Watch who is knocking before charging anyone. Observe mode, every request
passes unmodified:

```ts
import { serve } from "@hono/node-server";
import { fareseal } from "@tunnelmindai/fareseal-hono";
import { Hono } from "hono";

const app = new Hono();
app.use(fareseal({ config: `report_token = "choose-a-secret"` }));
app.get("/", (c) => c.text("your site"));
serve({ fetch: app.fetch, port: 8787 });
```

Then look at the report:

```bash
curl -H "Authorization: Bearer choose-a-secret" http://localhost:8787/_fareseal/report
```

```json
{
  "mode": "observe",
  "humans_passed": 1042,
  "verified_search_passed": 0,
  "verified_preview_passed": 0,
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
# fareseal.toml
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

### Don't charge for pages that aren't there

Without help, the toll offers a price for any path, including ones your site
would 404. Pass `exists` and Fareseal asks first:

```ts
app.use(fareseal({
  config,
  exists: async (path) => routes.has(path), // your own lookup
}));
```

- **404 before offer.** In toll mode, when `exists` answers false the request
  gets a plain `404`: no offer, no settle, no maze, no receipt (counted as
  `not_found` in the report stats). It is never asked for `free_paths`, and
  observe mode skips it.
- **Fail toward the offer.** If `exists` throws or rejects, the path counts as
  present and gets today's `402` offer. A broken check never serves content
  free and never turns into a 500.

On Cloudflare Pages, `createPagesMiddleware({ exists: "assets" })` does this
against the static asset binding — see [`@tunnelmindai/fareseal-cloudflare`](packages/cloudflare).

`pass_verified` is an opt-in pass for crawlers you want to let through,
**off by default** (`[]`). `"search"` passes Googlebot and bingbot only when
the client IP is inside the ranges Google and Bing publish (a dated snapshot
vendored in `@tunnelmindai/fareseal-core`, never fetched at runtime); a spoofed UA from
any other IP, or a request with no trusted IP, gets the normal 402.
`"preview"` passes Slackbot, Twitterbot, facebookexternalhit, LinkedInBot and
Discordbot by UA, for HTML page GET/HEAD requests only.
**Warning: "preview" is UA-only.** Unlike `"search"` there is no IP check,
and the User-Agent header is trivially spoofable: any client can send
`User-Agent: Slackbot` and read your HTML pages (GET/HEAD) for free. Enable it
only if you accept that; don't use it on content you want paid. A request carrying
Web Bot Auth headers is never shortcut. Each pass is counted in the report as
its own class (`verified_search_passed`, `verified_preview_passed`). 
`@tunnelmindai/fareseal-hono` has no default client IP, so the search pass fails closed
until you pass `fareseal({ clientIp: (c) => ... })` with a source you trust;
`@tunnelmindai/fareseal-cloudflare` wires `cf-connecting-ip` itself, since Cloudflare's
edge sets it.

```toml
pass_verified = ["search", "preview"]  # "preview" is UA-only, spoofable
```

```ts
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { buildOffer, verifyProof } from "@tunnelmindai/fareseal-adapter-x402";
import { makeStripeAdapter } from "@tunnelmindai/fareseal-adapter-stripe";
import { parseConfig, toBase64Url } from "@tunnelmindai/fareseal-core";
import { loadOrCreateSiteKey } from "@tunnelmindai/fareseal-core/node";
import { fareseal } from "@tunnelmindai/fareseal-hono";
import { corpusFromMap, makeMazeHandler, robotsFragment } from "@tunnelmindai/fareseal-maze";
import { loadCorpusDir } from "@tunnelmindai/fareseal-maze/node";
import { Hono } from "hono";

const cfg = parseConfig(readFileSync("./fareseal.toml", "utf8"));

// generated once and printed exactly once, on creation
const key = await loadOrCreateSiteKey(cfg.site_key_path);
if (key.created) console.log(`site public key: ${toBase64Url(key.publicKey)}`);
const siteKeys = { secret: key.secretKey, pub: key.publicKey };

// pre-generate the maze corpus first, from a checkout after pnpm install && pnpm build:
//   node packages/cli/dist/cli.js corpus --out ./maze-corpus
const maze = makeMazeHandler({ corpus: await loadCorpusDir(cfg.maze.corpus_path), cfg });

const app = new Hono();
app.use(
  fareseal({
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
// Disallow: /.well-known/fareseal-maze/
```

Stripe setup: create a Payment Link with a custom text field whose key is
`agent_pubkey`, set its success URL to
`https://your-site/_fareseal/voucher/{CHECKOUT_SESSION_ID}`, and point the
webhook (event `checkout.session.completed`) at
`https://your-site/_fareseal/stripe-webhook`. The buyer's crawler collects
its voucher from the success page — shown exactly once — and spends it in the
`Fareseal-Voucher` header; every response carries the re-signed successor
with one credit less. The same middleware runs on Bun and Cloudflare Workers:
see [examples/](examples/).

## For agent developers

A `402` from a Fareseal site is an offer, not a wall. The body lists every
enabled payment option with enough data to complete each:

```json
{
  "v": 1,
  "price_usd": "0.001",
  "options": [
    { "method": "x402", "network": "base-sepolia", "pay_to": "0x…", "price_usd": "0.001" },
    { "method": "stripe-voucher", "payment_link": "https://buy.stripe.com/…",
      "credits": 5000, "voucher_header": "Fareseal-Voucher" }
  ]
}
```

With x402 enabled the same body also speaks [x402 v1](https://www.x402.org/):
`x402Version: 1`, `error`, and `accepts[]` holding one `PaymentRequirements`
(`scheme`, `network`, `maxAmountRequired`, `resource` — the absolute request
URL — `description`, `mimeType`, `payTo`, `maxTimeoutSeconds`, `asset`,
`outputSchema`, `extra`). No key is shared, so an x402 client and an older
Fareseal client each read their own fields. Every `402` is
`cache-control: no-store`. A paid response carries `X-PAYMENT-RESPONSE`:
base64 JSON `{success, transaction, network, payer}` (`transaction` is `""`
when only local verification ran, with no settle step).

**Deprecated:** the `x-payment-required` response header (the same
requirement as `accepts[0]`, as JSON) is kept for one release cycle and will
be removed in the next minor. Read `accepts[0]` from the body instead.

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
SPOOF is unauthenticated: anyone can claim any key. The commons must never
attribute a SPOOF receipt to the claimed key; it is evidence of an attack
naming that key, not of that key's conduct. Spoofs are therefore aggregated:
one `SPOOF` receipt per claimed key per 60 s window, with `count` holding the
number of spoofs and `ua` cut to 128 characters with control characters
stripped.

Verify one on an air-gapped machine — only the receipt and the site's public
key are needed. The CLI is not published; run it from a checkout after
`pnpm install && pnpm build`:

```bash
node packages/cli/dist/cli.js verify receipt.json --pubkey <site-public-key>
# schema: PASS
# canonical form: PASS
# signature: PASS
# key not bound to a domain
# PASS
```

`--pin <file>` reads the key from a file instead. `--domain <host>` is the one
networked option: it fetches `https://<host>/.well-known/fareseal-site.json`
(below) and FAILs unless that file lists the receipt's key.

## Reporting to the Conduct Log Commons (optional, off by default)

TunnelMind runs a free, public, append-only log of Fareseal conduct data: free to report to,
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
authentication.

Reads:

- `GET https://data.tunnelmind.ai/v1/tollbooth/stats` is the live exhibit.
- `GET https://data.tunnelmind.ai/v1/tollbooth/export?day=YYYY-MM-DD[&kind=receipts|reports]`
  returns one UTC day as JSON Lines, one signed document per line. `kind` defaults to `receipts`.
- A page holds up to 5,000 rows. When the response header `x-commons-capped: true` is set, more
  rows follow: send the value of `x-commons-next-after` as the `after` query parameter to get the
  next page.
- Each line wraps the signed document in a `_commons` envelope, and the envelope is not signed.
  Receipt lines are `{_commons, receipt}`; report lines carry a `snapshot`. The response header
  `x-commons-verify` carries the verification recipe.
<!-- DRAFT: facts verified 2026-11-07; prose is Josh's -->
- To verify, save what you fetched to a file and run, from a checkout after
  `pnpm install && pnpm build`:
  `node packages/cli/dist/cli.js verify <file> --pubkey <site>` (or `--pin <file>`, or
  `--domain <host>` in place of `--pubkey`). One of the three is required. `<file>` can be:
  - **a wrapped line** `{_commons, receipt}` or `{_commons, snapshot}`, as exported: the inner
    document is unwrapped and verified. The `_commons` envelope is not signed and not checked,
    and the output says so. A line with any other keys FAILs.
  - **a bare receipt**: verified exactly as before, with the output shown in the example above.
  - **a snapshot** (`kind=reports`, `"kind": "tollbooth-observe-snapshot"`), bare or wrapped:
    checked by `verifySnapshot` in `packages/core`.
  - **a file of lines**, such as a whole export page: one document per line, each report line
    prefixed `line N: `, blank lines skipped. It PASSes only if every line passes. A file that
    parses as one JSON document (such as a page of one row) is read as that one document, with
    no prefix.

  `--pubkey` and `--pin` check offline against that one key and print `key not bound to a
  domain`. `--domain <host>` alone checks each document against its own `site` key and makes
  one fetch per run of `https://<host>/.well-known/fareseal-site.json` (falls back to `tollbooth-site.json` if the first 404s), which must list every
  key. Exit codes: 0 PASS, 1 FAIL, 64 usage. The manual way to check a snapshot: `sig` is an
  Ed25519 signature over `canonicalize(snapshot without sig)` by the key in its `site` field
  (decode both with `fromBase64Url`, then call `verify(sig, message, site)`). Or open
  https://tunnelmind.ai/conduct/log in a browser.

How-to and stated limits: https://tunnelmind.ai/conduct/join

## What the door reads

`GET /_fareseal/arrival` shows a requester what Fareseal read from their own request. It is free on
every mode, never tolled or mazed, needs no voucher, moves no counter and emits no receipt. The route
is the same on `@tunnelmindai/fareseal-hono` and on the Cloudflare Pages middleware (`createPagesMiddleware`). The
response is JSON with `cache-control: no-store` and `vary: *`. The reading is returned only to the
requester and never stored.

The body is `{ rows, identity: { kind, via, matched }, decision: { type, reason }, never_read, kept_scope }`.
Each row has six fields:

- `name` — the field (`method`, `path`, `host`, `scheme`, `user-agent`, `accept`, `cookie`,
  `sec-fetch-site`, `signature`, `signature-input`, `signature-agent`, `x-payment`,
  `fareseal-voucher`, `client_ip`, `body`).
- `value` — what was read, or `null`.
- `read` — `"value"`, `"presence only"` or `"not read"`.
- `used_for` — what Fareseal uses it for.
- `kept` — whether anything of it would be kept (below).
- `present` — whether the field was sent in this request (`true`/`false`).

Secrets are read for presence only, value `null`: the cookie, `signature`, `signature-input`,
`x-payment` and `fareseal-voucher`. These rows show `present`, but their value stays `null`. The body
reads `"not read"` and `present: false`. `never_read` lists the cookie value,
the request body, country, ASN and `request.cf`.

`kept_scope` is always `"an ordinary request like this one; this arrival request itself is never
recorded"`: every `kept` says what Fareseal would keep for an ordinary request like this one, not for
the arrival request itself. `kept` comes from the same rule the agent ledger uses (`keptFor` in
`@tunnelmindai/fareseal-core`) and has three values:

- `"no"` — nothing of the field is kept. Humans and free paths read `"no"`: humans only bump a
  counter, which keeps nothing of the request. Every row except `path` and `user-agent` always reads
  `"no"`.
- `"counter only"` — a verified search or preview bot (`pass_verified`) passes and bumps its own
  counter; nothing of the request is stored. Its `path` and `user-agent` rows read this.
- `"agent ledger (ua, count, paths)"` — only agent traffic (agent, anonymous-agent and spoofer
  identities) is recorded to the in-memory agent ledger, which keeps the user-agent and the path plus
  a count. Only the `path` and `user-agent` rows of such traffic read this.

## Honest limits — read before deploying

- **Enforcement is soft.** Vouchers are stateless signed credits: parallel
  replay of one voucher state can over-spend within its lifetime, bounded by
  `replay_window`, expiry, and your instance count. Instances share nothing;
  every cache and ledger is a bounded LRU whose eviction is amnesty. This is
  economically sufficient at micro-prices; it is not a hard ledger, and no
  database will be added to change that.
- **Web Bot Auth replay is bounded, not closed.** A signature counts as
  valid until `expires` plus `wba_skew_tolerance` (default `"60s"`; signed
  spans are capped at 300 s). In toll mode a signature carrying the optional
  RFC 9421 `nonce` parameter is refused on replay within that window (treated
  as anonymous, never as a spoofer). Same stance as vouchers: per instance, a
  bounded LRU sized by `limits.jti_lru_max`, eviction is amnesty. Signatures
  without a `nonce` can replay until they expire.
- **`exists: "assets"` caches per isolate.** Answers are kept for the
  isolate's lifetime (bounded at 1024 paths, oldest out; reset when the middleware
  rebuilds its state). A path checked while missing keeps its 404 until that entry
  is evicted or the isolate recycles.
- **Signature-Agent directory fetches are vetted, not sandboxed.** The key
  directory URL comes from the agent, so the fetcher takes https on port 443
  only, refuses IP literals and localhost / `.local` / `.internal` names, and
  on Node resolves the host first (`dns.promises.lookup`, loaded lazily) and
  refuses it if any address is private, loopback, link-local or CGNAT. Pass
  `makeDirectoryFetcher({ resolveHost })` as `fetchDirectory` to supply your
  own resolver; Workers get none, since their egress cannot reach private
  ranges. `fetch` resolves again, so a DNS-rebinding window remains.
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
| baseline app, no Fareseal | 0.011 ms | 0.101 ms |
| human pass-through | 0.013 ms | 0.111 ms |
| free path pass-through | 0.007 ms | 0.055 ms |
| agent 402 offer | 0.013 ms | 0.110 ms |
| voucher spend + re-sign (ed25519 x2) | 2.126 ms | 5.056 ms |

NFR-1 (pass-path added latency <= 1 ms p50, <= 5 ms p99): **PASS** (added p50 0.001 ms, added p99 0.011 ms)
<!-- bench:end -->

## Packages

| package | what it is | runtime deps |
|---|---|---|
| `@tunnelmindai/fareseal-core` | identify, offer state, vouchers, receipts, config — no HTTP, no chain code | zod, smol-toml, @noble/ed25519 |
| `@tunnelmindai/fareseal-hono` | the middleware: one binding for Node, Bun, Workers | core (+ your hono) |
| `@tunnelmindai/fareseal-adapter-x402` | x402 offers and local proof verification | @noble/curves, @noble/hashes |
| `@tunnelmindai/fareseal-adapter-stripe` | private, not published: webhook + render-once voucher redemption, no Stripe SDK | core |
| `@tunnelmindai/fareseal-maze` | decoy corpus generation, loading and serving | none |
| `@tunnelmindai/fareseal-cli` | private, not published (run from source): `corpus`, `verify`, `voucher inspect`/`mint` | core, maze |
| `@tunnelmindai/fareseal-cloudflare` | Cloudflare Pages middleware: settle-then-serve x402, snapshots | core, hono, maze, adapter-x402 |

## Publish plan

> Draft: for Josh's voice. Facts only.

Nothing is published to npm yet. The owner publishes. These five packages
are the ones to publish, because tunnelmind-site needs them:

| package | required by |
|---|---|
| `@tunnelmindai/fareseal-cloudflare` | tunnelmind-site `functions/_middleware.js:15` imports `createPagesMiddleware` from it (under the old `@tunnelmindai/tollbooth-*` names) |
| `@tunnelmindai/fareseal-adapter-x402` | tunnelmind-site `scripts/data/x402.data.mjs:10` imports `usdToAtomic` from it (under the old `@tunnelmindai/tollbooth-*` names); also a runtime dependency of cloudflare |
| `@tunnelmindai/fareseal-hono` | runtime dependency of cloudflare |
| `@tunnelmindai/fareseal-maze` | runtime dependency of cloudflare |
| `@tunnelmindai/fareseal-core` | runtime dependency of cloudflare |

`@tunnelmindai/fareseal-cli` and `@tunnelmindai/fareseal-adapter-stripe`
are `private: true` and not published until someone asks.

## Development

This repo is spec-driven: [constitution.md](constitution.md) holds the
non-negotiables, [spec.md](spec.md) the requirements, [plan.md](plan.md) the
architecture, [tasks.md](tasks.md) the build order. The workflow is described
in [docs/development.md](docs/development.md). License: [MIT](LICENSE).
