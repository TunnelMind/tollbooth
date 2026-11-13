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

| # | Settle answer | Class | Result reason | Cached for nonce | Counted to cooldown | Offer recorded |
|---|---|---|---|---|---|---|
| 0a | no settle token configured | operator | `settlement-unconfigured` | no | no | no |
| 0b | the per-isolate settle bucket is empty (any client can empty it, so an offer is still recorded) | operator | `settle-throttled` | no | no | yes |
| 0c | the settle call throws, or a 2xx body is not JSON | operator | `settle-unreachable` | no | no | no |
| 1 | HTTP 2xx and `data.settled === true` and a valid tx id (FR-005) | paid | — (served) | yes, `already-settled` | cleared | n/a (served) |
| 2 | HTTP 2xx and `data.settled === true` and no valid tx id | settle-endpoint fault (the payer may have paid; no offer recorded) | `no-transaction-id` | yes | no | no |
| 3a | any non-2xx with `data.settled === true` (money may have moved) | unconfirmed (no offer recorded) | `settle-unconfirmed` (402 `settlement status unconfirmed; do not pay again, contact the operator`) | no | no | no |
| 3 | `data.retryable === true`; or `data.reason` is `network-mismatch`, or is an operator fault by core's `isOperatorFault` (`settle-retryable`, `settle-throttled`, `settlement-unconfigured`, `settlement-not-configured`, `settle-unreachable`, starts with `verify-error:` / `settle-error:`, or matches `^(verify\|settle)-failed\((5\d\d\|401\|403\|429)\)$`) | operator | `settle-retryable` | no | no | no |
| 4 | HTTP status 5xx, 401, 403, 404, 405 or 429, whatever the body (404/405: a wrong settle URL or method is ours) | operator | `settle-retryable` | no | no | no |
| 5 | `data.reason` contains `valid_after` (F3) | payer clock, transient | `not-yet-valid`; repeats of the same payment before its `validAfter` are `not-yet-valid-held` (same 402 text `authorization not yet valid`) | no, held locally until its `validAfter` (repeats: no settle call) | yes, once per nonce | yes, first attempt only (held repeats: no) |
| 6 | HTTP 2xx `settled:false` with any other reason | payer | `data.reason`, else `settle-failed` | yes | yes | yes |
| 6b | HTTP 2xx JSON with no `data.settled` (`{}`, `null`, `[]`) | payer | `settle-failed` | yes | yes | yes |
| 7 | any other HTTP status (a 3xx, or a 4xx the client caused, e.g. 400, 413, 422), whatever the body | payer | `data.reason` if a string, else `settle-failed` | yes | yes | yes |

"Offer recorded" is what core's `decide` does with the reason (it records
an offer unless `isNoOfferFault`, and skips only the ledger write for
`not-yet-valid-held`): it counts toward the maze for a verified agent. `test/pages-settle.test.ts` ("README table") checks every row of
this table against the code. There is no timeout row: the settle fetch has
no timeout of its own, so a hung settle route holds the request until the
runtime ends it.

Known costs. Row 7: the settle route answers a `price_usd` outside its
bounds (our misconfiguration) with HTTP 400, so that 400 is still charged to
the payer (cached, counted). Row 2: a payer whose payment settled but came
back with an unusable tx id may have paid and is not served; it is not
mazed either (no offer recorded). Row 5: an early payment counts once
toward the payer's cooldown (a later successful settle clears it), so a
payer whose clock runs ahead can be cooled down by three early payments.
A row 5 reject whose `validAfter` is already past by our clock (the
facilitator's clock behind ours) is not held, so each retry of it counts
toward the cooldown.
Held repeats stretch the offer grace: a verified unfunded agent sending one
held early payment per 60 s from throwaway payer keys got 402 for 121
requests at 1 request/s before the first 302 (main: 3), with 5 settle calls
in 280 s, as measured by the second review on dd35fc2; no content is served,
a held repeat makes no settle call, and the agent is mazed once three first
attempts are recorded.
Concurrent failures from one payer each count toward the cooldown, but the
cooldown is checked before the settle call, so a concurrent burst from one
payer still reaches the settle bucket (20 calls) before the cooldown applies.

Prefer wiring the pieces yourself (or Stripe-only without chain code)?
Use [`@tunnelmindai/fareseal-hono`](../hono) — it stays injection-only by design.
