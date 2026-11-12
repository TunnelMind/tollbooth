# @tunnelmindai/fareseal-cloudflare

Batteries-included [Fareseal](https://github.com/TunnelMind/tollbooth) for
Cloudflare Pages: one import, config in, tolling out. Wires the maze,
receipt reporting, signed traffic snapshots, and settle-then-serve x402 so
your `functions/_middleware.js` is nothing but policy.

```js
// functions/_middleware.js
import { createPagesMiddleware } from "@tunnelmindai/fareseal-cloudflare";

const toml = (env) => `
mode = "toll"
report = true
report_url = "https://collector.example/v1/receipts"
report_token = "${env.FARESEAL_REPORT_TOKEN ?? env.TOLLBOOTH_REPORT_TOKEN ?? ""}"
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
your `settle.url` (bearer `FARESEAL_SETTLE_TOKEN`, or the older `TOLLBOOTH_SETTLE_TOKEN`; no settlement configured
means payments fail closed). The settle POST body is
`{ payment, price_usd, resource }`, where `resource` is the requested URL
(origin, path and query); the data-api settle route ignores it and pins the
resource until the adr-x402v2 follow-up. Agents that ignore the offer past the grace
window meet the decoy maze. Receipts and snapshots are signed with
`FARESEAL_SITE_KEY` (or the older `TOLLBOOTH_SITE_KEY`; base64url ed25519 seed) and reported through the
service binding when one is named. The middleware itself fails **open**:
any thrown error serves your site untolled.

`exists: "assets"` (optional) keeps the toll off pages that are not there.
In toll mode, before an offer, it sends a `HEAD` for the path to the Pages
asset binding (`env.ASSETS`); a `404` there answers a plain `404` with no
offer, settle, maze or receipt. `free_paths` are never checked, and observe
mode skips it. If the `HEAD` throws, the request gets the normal `402` offer
(it never serves free) and nothing is cached. Answers are cached per isolate,
bounded at 1024 paths (oldest out) and cleared when the middleware rebuilds
its state (a config or Fareseal env change).
With the option set and no `ASSETS.fetch`, construction throws
`FaresealBindingMissingError`, which is rethrown like a missing `binding`
rather than failing open.

Facilitator damping is built in (ADR-004): an exact payment already seen —
settled or failed on-chain — is rejected from a capped per-isolate cache,
and a payer with three fresh failures inside ten minutes is cooled down
locally instead of burning your facilitator quota. Eviction is amnesty.

Each settle answer is classified by this table; the first row that matches
wins. Operator rows never burn the payer's nonce or cooldown, so the same
`X-PAYMENT` can be retried once settlement is healthy.

| # | Settle answer | Class | Result reason | Cached for nonce | Counted to cooldown |
|---|---|---|---|---|---|
| 0a | no settle token configured | operator | `settlement-unconfigured` | no | no |
| 0b | the per-isolate settle bucket is empty | operator | `settle-throttled` | no | no |
| 0c | the settle call throws, or a 2xx body is not JSON | operator | `settle-unreachable` | no | no |
| 1 | HTTP 2xx and `data.settled === true` and a valid tx id (FR-005) | paid | — (served) | yes, `already-settled` | cleared |
| 2 | HTTP 2xx and `data.settled === true` and no valid tx id | settle-endpoint fault | `no-transaction-id` | yes | no |
| 3 | `data.retryable === true`; or `data.reason` is `settlement-not-configured` or `network-mismatch`, or starts with `verify-error:` / `settle-error:`, or matches `^(verify\|settle)-failed\((5\d\d\|401\|403\|429)\)$` | operator | `settle-retryable` | no | no |
| 4 | HTTP status 5xx, 401, 403 or 429 (whatever the body, including `settled:true`) | operator | `settle-retryable` | no | no |
| 5 | `data.reason` contains `valid_after` (F3) | payer clock, transient | `not-yet-valid` | no | no |
| 6 | HTTP 2xx `settled:false` with any other reason | payer | `data.reason`, else `settle-failed` | yes | yes |
| 7 | any other HTTP status (a 4xx the client caused, e.g. 400, 404, 413, 422), whatever the body, including `settled:true` | payer | `data.reason` if a string, else `settle-failed` | yes | yes |

Prefer wiring the pieces yourself (or Stripe-only without chain code)?
Use [`@tunnelmindai/fareseal-hono`](../hono) — it stays injection-only by design.
