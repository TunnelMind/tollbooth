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
  binding: "COLLECTOR", // service binding; same-zone self-fetches 522
});
```

Behavior, in one paragraph: humans and `free_paths` always pass. Agents get
a genuine `402` offer; a payment passes **only after it settles** through
your `settle.url` (bearer `TOLLBOOTH_SETTLE_TOKEN`; no settlement configured
means payments fail closed). Agents that ignore the offer past the grace
window meet the decoy maze. Receipts and snapshots are signed with
`TOLLBOOTH_SITE_KEY` (base64url ed25519 seed) and reported through the
service binding when one is named. The middleware itself fails **open**:
any thrown error serves your site untolled.

Facilitator damping is built in (ADR-004): an exact payment already seen —
settled or failed on-chain — is rejected from a capped per-isolate cache,
and a payer with three fresh failures inside ten minutes is cooled down
locally instead of burning your facilitator quota. Eviction is amnesty.

Prefer wiring the pieces yourself (or Stripe-only without chain code)?
Use [`@tollbooth/hono`](../hono) — it stays injection-only by design.
