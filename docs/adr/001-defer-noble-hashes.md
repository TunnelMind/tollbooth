# ADR 001 — defer @noble/hashes; noble async API over WebCrypto SHA-512

**Deviates from:** plan §3 stack table, which lists `@noble/ed25519 + @noble/hashes`.

Noble's *sync* API needs an externally supplied SHA-512 — that is the only
thing `@noble/hashes` would provide. Its *async* API digests through the
platform's WebCrypto, present on every target (Node ≥19, Bun, Workers).
T-004 uses the async API exclusively, so `@noble/hashes` is deferred until
something actually needs sync signing. Runtime deps stay at 3 of 5 (VII.23).

D-6's "synchronous sign" is about pipeline placement — sign the receipt
inline at build time rather than queueing the signing — not about the JS
calling convention; an awaited async sign satisfies it.

Revisit if the T-022 bench shows a hot-path cost, or if a sync-only call
site appears.
