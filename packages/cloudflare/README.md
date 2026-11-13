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
locally instead of burning your facilitator quota. Settles still in flight
count toward that per-payer limit: a fresh payment from a payer whose live
failures plus in-flight settles already total three is refused as
`payer-cooldown` (the same 402, no settle call, not cached, not counted,
offer recorded), so 100 concurrent fresh payments from one payer make 3
settle calls, not 20. Eviction is amnesty.

The cache, the bucket and the per-payer counts live in one state per
isolate, built by the first request. Requests that arrive while it is being
built wait for that one build and share its state, so the limits above hold
from the first request of a cold isolate (before 2.3.0 each of those
requests built its own state: 5 concurrent copies of one payment made 5
settle calls, 100 fresh payments from one payer made 100). A build that
fails is not kept: the requests waiting on it get the error (rethrown for a
config or binding error, failed open otherwise, as before) and the next
request builds again. Each isolate still has its own state; across isolates
only the chain refuses a reused nonce.

Each settle answer is classified by this table; the first row that matches
wins. Operator rows never burn the payer's nonce or cooldown, so the same
`X-PAYMENT` can be retried once settlement is healthy.

| # | Settle answer | Class | Result reason | Cached for nonce | Counted to cooldown | Offer recorded |
|---|---|---|---|---|---|---|
| 0a | no settle token configured | operator | `settlement-unconfigured` | no | no | no |
| 0b | the per-isolate settle bucket is empty (any client can empty it, so an offer is still recorded) | operator | `settle-throttled` | no | no | yes |
| 0c | the settle call throws (connection failure), or a 2xx body is not JSON | operator | `settle-unreachable` | no | no | no |
| 1 | HTTP 2xx and `data.settled === true` and a valid tx id (FR-005) | paid | — (served) | yes, `already-settled` | cleared | n/a (served) |
| 2 | HTTP 2xx and `data.settled === true` and no valid tx id | settle-endpoint fault (the payer may have paid; no offer recorded) | `no-transaction-id` | yes | no | no |
| 3a | any non-2xx with `data.settled === true`, or the settle call times out (10 s) (money may have moved) | unconfirmed (no offer recorded) | `settle-unconfirmed` (402 `settlement status unconfirmed; do not pay again, contact the operator`) | no | no | no |
| 3 | `data.retryable === true`; or `data.reason` is `network-mismatch`, or is an operator fault by core's `isOperatorFault` (`settle-retryable`, `settle-throttled`, `settlement-unconfigured`, `settlement-not-configured`, `settle-unreachable`, starts with `verify-error:` / `settle-error:`, or matches `^(verify\|settle)-failed\((5\d\d\|401\|403\|429)\)$`) | operator | `settle-retryable` | no | no | no |
| 4 | HTTP status 5xx, 401, 403, 404, 405 or 429, whatever the body (404/405: a wrong settle URL or method is ours) | operator | `settle-retryable` | no | no | no |
| 5 | `data.reason` contains `valid_after` (F3) | payer clock, transient | `not-yet-valid`; repeats of the same payment before its `validAfter` are `not-yet-valid-held` (same 402 text `authorization not yet valid`, plus a `Retry-After` header: whole seconds until `validAfter`, at least 1). Once `validAfter` has passed the payment is due: it gets one attempt that goes to settle even if the payer is cooled down. A due attempt that meets an empty settle bucket (row 0b) or an operator fault stays due. A due attempt answered row 5 again is not held again: the next retry is an ordinary attempt (`payer-cooldown` if the payer is cooled down, else a settle call) | no, held locally until its `validAfter` (repeats: no settle call) | yes, once per nonce | yes, first attempt only (held repeats: no) |
| 6 | HTTP 2xx `settled:false` with any other reason | payer | `data.reason`, else `settle-failed` | yes | yes | yes |
| 6b | HTTP 2xx JSON with no `data.settled` (`{}`, `null`, `[]`) | payer | `settle-failed` | yes | yes | yes |
| 7 | any other HTTP status (a 3xx, or a 4xx the client caused, e.g. 400, 413, 422), whatever the body | payer | `data.reason` if a string, else `settle-failed` | yes | yes | yes |

"Offer recorded" is what core's `decide` does with the reason (it records
an offer unless `isNoOfferFault`, and skips only the ledger write for
`not-yet-valid-held`): it counts toward the maze for a verified agent.
Row 5's "held repeats: no" holds for the first 60 held repeats per verified
agent key in a held window of `toll.window`, opened by the first held repeat
and cleared when the offer window rolls or the key pays; from the 61st the
held repeat
gets the same 402 with `Retry-After` and an offer is recorded, and once
`offer_grace` is spent the agent gets the usual 302 to the maze.
`test/pages-settle.test.ts` ("README table") checks every row of
this table against the code. A timeout is row 3a: the settle fetch is
aborted after 10 s and answered `settle-unconfirmed`, because the transfer
may already have been broadcast. A settle in
flight stops counting toward its payer's limit after 30 s (the timeout plus
a margin), so a settle whose request the runtime cancelled cannot keep the
payer locked out.

Known costs. Row 7: the settle route answers a `price_usd` outside its
bounds (our misconfiguration) with HTTP 400, so that 400 is still charged to
the payer (cached, counted). Row 2: a payer whose payment settled but came
back with an unusable tx id may have paid and is not served; it is not
mazed either (no offer recorded). Row 5: an early payment counts once
toward the payer's cooldown (a later successful settle clears it), so a
payer whose clock runs ahead can be cooled down by three early payments.
That payer is now served: each held payment gets its one due attempt
through the cooldown, so 3 early payments sent at once by a funded payer
55 s fast, each repeated after its `validAfter`, are all served (6 settle
calls, 2 per nonce); before, all three were refused as `payer-cooldown`.
The price is the early-nonce ceiling: an unfunded payer streaming early
nonces whose holds come due can cause at most 6 settle calls per payer in
any 600 s window (3 first attempts + 3 due attempts), where fresh unfunded
nonces cost 3. Per nonce: a payer who is cooled down or reserved out gets at
most 2 payer-attributable settle calls per nonce (the first attempt and the
due attempt). A lone early nonce against a lagging facilitator (its clock
behind ours, so the due attempt is answered row 5 again) may cost 3 settle
calls: the first attempt, the due attempt, and one ordinary retry, which is
the payer's third failure; after that it is `payer-cooldown`. That is no
more than before for that case. Operator faults on a due attempt: the hold
is put back so the retry is the due attempt again, but only twice. The third
operator-fault answer for one hold drops it, so a cooled-down payer with one
due hold makes at most 3 settle calls through a facilitator outage; its 4th
and later requests are `payer-cooldown` with no settle call, and the payment
(not cached) can be sent again once the cooldown ends. Without the bound that
payer got a settle call on every request while the outage lasted. The cap of
3 is a choice for the owner: a different cap, or none, is a one-line change
(`DUE_FAULT_LIMIT`). A row 5 answer whose `validAfter` is already
past by our clock is never held, on the first attempt too, so each retry of
it is an ordinary attempt that counts toward the cooldown.
Held repeats are bounded by the cap of 60 per held window: a verified agent
sending one held payment at 10 requests/s gets its first 302 by request 64
(1 first attempt + 60 free held repeats + 3 offers of grace) with 1 settle
call, and an honest agent polling once a second for 60 s on one held payment
is never mazed and is then served (2 settle calls). Before the cap, a
verified unfunded agent sending one held early payment per 60 s from
throwaway payer keys got 402 for 121 requests at 1 request/s before the
first 302, as measured by the second review on dd35fc2. No
content is served to an unfunded agent either way, and a held repeat makes
no settle call.
In-flight settles count toward the per-payer limit, so a fourth concurrent
payment from an honest payer is refused with the `payer-cooldown` text
("payer cooling down after repeated failures; retry later") although nothing
has failed, and an offer is recorded for it: an agent sending 7 or more
payments at once from one wallet could reach the maze before its paid ones
land.
A cooldown now ends 600 s after the failure was written (when its settle
answer came back), not 600 s after that settle call started, so a slow
settle answer no longer shortens it.
The current numbers above (3, 2 and 6 settle calls, the 3 operator faults
per hold, request 64, the cap of 60) are asserted in `test/settle-budget.test.ts` and
`test/pages-settle.test.ts` (rows A4–A7 and "lagging facilitator"). The
121-request figure is a historical measurement from before the cap, and
"7 or more payments at once" is the design estimate from spec 006 (OQ3);
neither has a test.

Prefer wiring the pieces yourself (or Stripe-only without chain code)?
Use [`@tunnelmindai/fareseal-hono`](../hono) — it stays injection-only by design.
