# @tollbooth/hono

The tollbooth middleware for Hono - one binding covers Node, Bun and Cloudflare Workers.

Signature-Agent key directories are fetched by `makeDirectoryFetcher()` (the
default `fetchDirectory`). On Node it resolves the host before connecting and
refuses private, loopback, link-local and CGNAT addresses; pass
`makeDirectoryFetcher({ resolveHost })` to use your own resolver. On Workers
there is no resolver by default - the platform's egress already cannot reach
private ranges.

Part of [tollbooth](https://github.com/TunnelMind/tollbooth) - pay the toll or meet
the maze: self-hosted middleware that offers crawlers paid access, passes
humans untouched, and leaves offline-verifiable conduct receipts. The
[main README](https://github.com/TunnelMind/tollbooth#readme) has the full
story, quickstart and honest limits. MIT.
