# ADR 005 — npm scope @tunnelmindai; publish five packages, not seven

Tollbooth was renamed Fareseal on 2026-11-10.

**Narrows:** spec 094's "all seven" packages (`.github/workflows/publish.yml:1`).
**Decision:** D3, decided 2026-11-04 (record: vault
`TunnelMind/session-notes/2026-11-04-decisions-debate.md`).

The tollbooth scope on npm belongs to another user (tollbooth/core 0.1.1,
published 2026-09-18 by jagadeeshftw). We cannot publish under it, so the
names in this repo's package.json files cannot ship as they are.

**Decision:** every package renames from tollbooth/`<x>` to
`@tunnelmindai/tollbooth-<x>`. TunnelMind owns the @tunnelmindai scope.
Directory names under `packages/` stay as they are.

**Publish set (5):** the packages the live site actually runs, and nothing
else:

- `@tunnelmindai/tollbooth-cloudflare`: the site's
  `functions/_middleware.js:15` imports `createPagesMiddleware` from it.
- `@tunnelmindai/tollbooth-adapter-x402`: the site's
  `scripts/data/x402.data.mjs:10` imports `usdToAtomic` from it.
- `@tunnelmindai/tollbooth-core`, `@tunnelmindai/tollbooth-hono`,
  `@tunnelmindai/tollbooth-maze`: runtime deps of cloudflare. The
  `dependencies` of `packages/cloudflare/package.json` are adapter-x402,
  core, hono and maze (all `workspace:*`) plus the third-party `hono`
  package.

**Private:** cli and adapter-stripe become private (`"private": true`) and
are not published until someone asks for them. Stripe was retired as a TunnelMind processor
in October 2026.

**Consequences:**

- Spec 094 said all seven packages publish; this ADR narrows that to five.
- No agent publishes. The owner publishes, through npm trusted publishing
  (a later task in spec 125).

Revisit if someone asks for cli or adapter-stripe on npm, or if the
tollbooth scope becomes ours.
