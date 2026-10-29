# @tollbooth/hono

The tollbooth middleware for Hono - one binding covers Node, Bun and Cloudflare Workers.

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

Part of [tollbooth](https://github.com/TunnelMind/tollbooth) - pay the toll or meet
the maze: self-hosted middleware that offers crawlers paid access, passes
humans untouched, and leaves offline-verifiable conduct receipts. The
[main README](https://github.com/TunnelMind/tollbooth#readme) has the full
story, quickstart and honest limits. MIT.
