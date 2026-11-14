# @tunnelmindai/fareseal-hono

The Fareseal middleware for Hono - one binding covers Node, Bun and Cloudflare Workers.

Signature-Agent key directories are fetched by `makeDirectoryFetcher()` (the
default `fetchDirectory`). On Node it resolves the host before connecting and
refuses private, loopback, link-local and CGNAT addresses; pass
`makeDirectoryFetcher({ resolveHost })` to use your own resolver. On Workers
there is no resolver by default - the platform's egress already cannot reach
private ranges.

`exists?: (path) => Promise<boolean>` keeps the toll off pages that are not
there. In toll mode, a `false` answer gets a plain 404 before any offer: no
settle, no maze, no receipt (counted as `not_found` in the report stats). It
is never asked for `free_paths`, and observe mode skips it. A throw or
rejection counts as "exists" and gets today's 402 offer, so a broken check
never serves content free and never 500s. Leave it unset and nothing changes.

`X402VerifyResult.retryAfterS?: number` lets a `verifyProof` that is holding
an early payment (one whose `validAfter` has not come yet) say when to send
it again. Set it to whole seconds, on a refusal (`ok: false`) only; the 402
for that request then carries `retry-after: <retryAfterS>`. The header is
sent only when the request had an `X-PAYMENT` header and the value is a
positive safe integer; the 302 to the maze never carries it. The body and
the other headers are unchanged. `@tunnelmindai/fareseal-cloudflare`'s
settling verifier sets it on a held repeat (`not-yet-valid-held`) only, so
there the header is on the held 402 and on no other response: not the first
`authorization not yet valid` 402, not `settle-throttled`, not any other 402.

Part of [Fareseal](https://github.com/TunnelMind/tollbooth) - pay the toll or meet
the maze: self-hosted middleware that offers crawlers paid access, passes
humans untouched, and leaves offline-verifiable conduct receipts. The
[main README](https://github.com/TunnelMind/tollbooth#readme) has the full
story, quickstart and honest limits. MIT.
