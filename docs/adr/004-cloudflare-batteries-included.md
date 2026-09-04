# ADR 004 — @tollbooth/cloudflare is batteries-included

**Relates to:** plan D-7, AC-2.3, Constitution I (zero-infra), V.15.

D-7 keeps @tollbooth/hono injection-only so operators who use only Stripe
never pull chain code. That is the right default for a composable
middleware — and the wrong trade for a drop-in distribution artifact: on
Cloudflare Pages the operator writes exactly one file, and every import
they must wire by hand is a place to get it wrong. The tunnelmind.ai
deployment carried ~200 lines of this plumbing (state caching, corpus
generation, binding-routed reporting, settle-then-serve, damping) around
~40 lines of actual site policy.

**Decision:** @tollbooth/cloudflare imports core, hono, maze, cli, and
adapter-x402, and wires them behind `createPagesMiddleware(options)`.
One import, config in, tolling out.

Bounds that keep the rest of the system honest:

- @tollbooth/hono stays injection-only; AC-2.3's test is untouched. The
  widening of `X402Adapter.verifyProof` to allow a Promise return changes
  a type, not a dependency — core's `VerifyPayment` always allowed it and
  the pipeline awaits.
- Zero-infra holds: all state is per-isolate and capped (offer ledger,
  jti cache, seen-payment cache, payer cooldown); eviction is amnesty.
- Settle-then-serve fails CLOSED — a valid-looking payment that does not
  settle on-chain never yields content — while the middleware as a whole
  fails OPEN: any thrown error serves the site untolled. Enforcement soft,
  money strict.
- Facilitator damping exists because signing a well-formed payment costs
  an attacker nothing, while relaying it to a facilitator costs the
  operator quota: an exact payment already seen (settled or failed) is
  rejected from cache, and a payer with repeated fresh failures gets a
  cooldown. Transport/config failures are the operator's own and are never
  counted against a payer.
- V.15: the package's docs and tests use base-sepolia; mainnet remains
  something the operator writes into their own config (ADR-003).
