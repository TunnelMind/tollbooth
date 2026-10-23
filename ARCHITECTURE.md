# tollbooth architecture

A reader's map of the tree. What the software promises is in README.md and
constitution.md; why it is built this way is in plan.md and docs/adr/.

## Module map

| Path | Role |
|---|---|
| `packages/core/src/pipeline.ts` | `decide()`: pure policy, request facts in, a Decision out. Touches only injected state (offer ledger, jti cache). |
| `packages/core/src/wba.ts` | Web Bot Auth (RFC 9421 profile) verification against a key directory; `nonce.ts` refuses replayed nonces. |
| `packages/core/src/heuristics.ts`, `botranges.ts` | Unsigned-agent heuristics; CIDR membership for vendored crawler ranges. |
| `packages/core/src/voucher.ts`, `jti.ts`, `ledger.ts` | Site-signed vouchers spent and re-signed per request; soft replay damping; the bounded offer-state LRU. |
| `packages/core/src/receipt.ts`, `reporter.ts` | Signed conduct receipts and the offline verifier; the batched, fire-and-forget reporter. |
| `packages/core/src/canonicalize.ts`, `keys.ts` | RFC 8785 JCS and Ed25519 (@noble/ed25519); the bytes every signature covers. |
| `packages/core/src/config.ts` | TOML/object config, zod-validated; startup either gets a full config or throws. |
| `packages/hono/` | The HTTP binding: runs `decide()` and acts (or, in observe mode, records). |
| `packages/adapter-x402/` | x402 offers and local EIP-3009 proof verification; all chain code lives here. |
| `packages/adapter-stripe/` | Stripe webhook (HMAC) and render-once voucher delivery. |
| `packages/maze/` | Deterministic decoy corpus: generation (build time) and serving. |
| `packages/cloudflare/` | Pages middleware: core + hono + maze + x402 with settle-then-serve. |
| `packages/cli/` | `corpus`, `verify` (receipts), `voucher inspect` / `mint`. |

## Data flow

1. A request reaches the binding (hono or cloudflare). Free paths pass.
2. Identity: a Web Bot Auth signature verified against the agent's key
   directory, else heuristics, else human. Humans and ambiguous traffic pass.
3. A forged signature goes to the maze; a valid voucher is spent (re-signed
   with one credit less); a valid x402 proof passes (cloudflare settles it
   first); repeated ignored offers go to the maze; otherwise a 402 offer.
4. Decisions that are facts about conduct become signed receipts, which the
   reporter may POST (off by default) and anyone can verify offline with the
   site's public key (`tollbooth verify`).

## Trust boundaries

- **Everything in the request is hostile:** headers, signatures, vouchers,
  X-PAYMENT, the user agent (control characters stripped before it lands in a
  receipt). Each verifier answers with a state, never a throw.
- **Client IP:** no default source; the operator names the one their proxy
  sets, else the verified-bot pass (`pass_verified`) fails closed.
- **Signed bytes:** JCS refuses a lone surrogate; `packages/core/test/
  vectors/jcs.json` is the estate's frozen vector file, vendored byte-for-byte
  from receipt-verify. A receipt's `sig` has one accepted spelling.
- **Keys:** the site key signs vouchers and receipts; an agent key counts only
  after WBA verification; a voucher is bound to it unless bearer is enabled.
- **Money:** a verified x402 authorization is a payable claim, not a payment;
  settlement fails closed. Stripe webhooks are HMAC-checked with a time window.
- **Failure:** the middleware fails open on runtime errors (the site serves
  untolled) and closed on configuration errors (a missing binding throws).

## Tests

```
pnpm install --frozen-lockfile
pnpm test        # tsc -b, then vitest across all packages
pnpm lint        # biome
pnpm typecheck   # packages and tests
```
