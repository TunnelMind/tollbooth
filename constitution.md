# CONSTITUTION — tollbooth
*(working name — rename freely; nothing below depends on it)*

Non-negotiable principles. Every task, every generated file, every PR is checked against these.
Enforcement levels: **MUST** (violation = reject the code), **SHOULD** (deviation requires a written note in the PR).

## Article I — Zero Infrastructure
1. The package MUST run entirely on the operator's own infrastructure. No component may require a hosted TunnelMind service, database server, message queue, or third-party API to perform its core function (detect → offer → verify → pass/consequence).
2. All state MUST live in signed tokens (vouchers) or in-process memory. A persistent datastore MUST NOT be a requirement. In-memory LRU caches are permitted.
3. The Stripe webhook handler MUST ship *inside* the package, mounted on the operator's own app, using the operator's own Stripe keys. We host nothing.
4. Optional network calls (conduct-receipt reporting to a transparency log) MUST default to **off** and the package MUST be fully functional with them off, forever.

## Article II — Offer Before Consequence
5. The pipeline order is MANDATORY: identify → offer payment (402) → only then consequence (maze). An agent MUST NOT be sent to the maze unless it was first given a machine-readable offer and declined/ignored it, OR it presented forged/spoofed identity.
6. Humans MUST never be tolled or mazed. Ambiguous traffic MUST fail open (pass). False-positive on a human is the worst failure class in this system.
7. `free_paths` (at minimum `/robots.txt`, and anything the operator lists) MUST always pass for everyone, unconditionally.

## Article III — Facts, Not Verdicts
8. Receipts record **observations** ("key X ignored a 402 at time T on N paths"), never judgments ("key X is malicious"). The package MUST NOT ship, fetch, or consume a blocklist.
9. Conduct receipts MUST contain request metadata only (key, path, timestamp, response class, user-agent string). Request/response **bodies MUST never be captured, logged, or transmitted**.
10. All receipts MUST be RFC 8785 (JCS) canonicalized and Ed25519-signed by the site key, and MUST be verifiable offline by anyone holding the site's public key.

## Article IV — Cryptography
11. Ed25519 only, via `@noble/ed25519`. No homemade crypto, no algorithm agility in v1.
12. Vouchers are **key-bound by default** (voucher names the agent's Web Bot Auth key; only proof-of-possession of that key spends it). Bearer vouchers are permitted only behind an explicit `bearer: true` config flag.
13. Agent identification uses **Web Bot Auth** (HTTP Message Signatures / RFC 9421 profile). Signature verification failure with a *claimed* identity is treated as spoofing (consequence-eligible). Absence of any signature is treated as anonymous (offer-eligible, never consequence-eligible on first contact).

## Article V — Honest Enforcement Claims
14. The stateless credit model is **soft enforcement**: parallel replay of a voucher can over-spend within its short lifetime. The README and code comments MUST state this plainly. It is economically sufficient at micro-prices; it is not a hard ledger. No task may add a database to "fix" this (see Article I).
15. x402 settlement configuration belongs to the operator. Documentation MUST NOT claim mainnet settlement status on behalf of anyone; example configs use testnet values.
16. Advertised numbers in docs (throughput, latency) MUST come from a committed benchmark script, or not appear.

## Article VI — Maze Hygiene
17. Maze content MUST be pre-generated static corpus (build-time), never inference at request time.
18. Every maze response MUST carry `X-Robots-Tag: noindex, nofollow`, maze paths MUST be under one configurable prefix, and the package MUST offer a robots.txt fragment disallowing that prefix. Poisoning the operator's SEO is a release-blocking bug.
19. Maze pages MUST be plausible but valueless, MUST NOT contain real site content, and MUST NOT impersonate real brands or people.

## Article VII — Code & Project Discipline
20. TypeScript strict mode; zero `any` in exported surfaces. Config validated with zod; invalid config MUST fail at startup with a message naming the bad key.
21. Every functional requirement in `spec.md` maps to at least one automated test. Acceptance scenarios are implemented as integration tests verbatim.
22. MIT license. No telemetry, no phone-home, no update checks.
23. Dependency budget: core package ≤ 5 runtime dependencies. Each new dependency requires a one-line justification in the PR.
24. ADR-before-implementation for any decision that contradicts `plan.md`; ADRs live in `docs/adr/`.

## Amendment
Changes to this constitution are a PR against this file, merged by the maintainer (Josh), before any code that depends on the change.
