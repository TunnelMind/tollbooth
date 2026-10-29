# @tollbooth/cloudflare

Batteries-included [tollbooth](https://github.com/TunnelMind/tollbooth) for
Cloudflare Pages: one import, config in, tolling out. Wires the maze,
receipt reporting, signed traffic snapshots, and settle-then-serve x402 so
your `functions/_middleware.js` is nothing but policy.

```js
// functions/_middleware.js
import { createPagesMiddleware } from "@tollbooth/cloudflare";

const toml = (env) => `
mode = "toll"
report = true
report_url = "https://collector.example/v1/receipts"
report_token = "${env.TOLLBOOTH_REPORT_TOKEN ?? ""}"
free_paths = ["/robots.txt", "/api/"]

[toll]
price_usd = "0.001"

[toll.x402]
network = "base-sepolia"
pay_to = "0x1111111111111111111111111111111111111111"

[maze]
enabled = true
`;

export const onRequest = createPagesMiddleware({
  config: toml,
  corpus: { seed: "my-maze", pages: 256 },
  settle: { url: "https://collector.example/v1/settle" },
  snapshots: { url: "https://collector.example/v1/report" },
  exists: "assets", // optional: 404 missing static paths instead of offering
  binding: "COLLECTOR", // service binding; same-zone self-fetches 522 — REQUIRED when named (no global-fetch fallback since 2.0.0)
});
```

Behavior, in one paragraph: humans and `free_paths` always pass. Agents get
a genuine `402` offer; a payment passes **only after it settles** through
your `settle.url` (bearer `TOLLBOOTH_SETTLE_TOKEN`; no settlement configured
means payments fail closed). The settle POST body is
`{ payment, price_usd, resource }`, where `resource` is the requested URL
(origin, path and query); the data-api settle route ignores it and pins the
resource until the adr-x402v2 follow-up. Agents that ignore the offer past the grace
window meet the decoy maze. Receipts and snapshots are signed with
`TOLLBOOTH_SITE_KEY` (base64url ed25519 seed) and reported through the
service binding when one is named. The middleware itself fails **open**:
any thrown error serves your site untolled.

`exists: "assets"` (optional) keeps the toll off pages that are not there.
In toll mode, before an offer, it sends a `HEAD` for the path to the Pages
asset binding (`env.ASSETS`); a `404` there answers a plain `404` with no
offer, settle, maze or receipt. `free_paths` are never checked, and observe
mode skips it. If the `HEAD` throws, the request gets the normal `402` offer
(it never serves free) and nothing is cached. Answers are cached per isolate,
bounded at 1024 paths (oldest out) and cleared when the middleware rebuilds
its state (a config or tollbooth env change).
With the option set and no `ASSETS.fetch`, construction throws
`TollboothBindingMissingError`, which is rethrown like a missing `binding`
rather than failing open.

Facilitator damping is built in (ADR-004): an exact payment already seen —
settled or failed on-chain — is rejected from a capped per-isolate cache,
and a payer with three fresh failures inside ten minutes is cooled down
locally instead of burning your facilitator quota. Eviction is amnesty.

Prefer wiring the pieces yourself (or Stripe-only without chain code)?
Use [`@tollbooth/hono`](../hono) — it stays injection-only by design.
