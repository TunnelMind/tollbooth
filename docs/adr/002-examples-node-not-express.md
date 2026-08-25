# ADR 002 — examples/node replaces examples/express-node

**Deviates from:** plan §2 repo layout, which lists `examples/express-node`.

The middleware is Hono-native by design — plan §3 chose Hono precisely so one
codebase covers Node, Bun and Workers. There is no first-party Express
binding, and writing one for an example would invert the dependency. The Node
example therefore uses `@hono/node-server`; an Express wrapper belongs with
the WordPress/Caddy wrappers in the post-v1 backlog. Naming-only deviation:
the example still demonstrates the Node runtime end to end.
