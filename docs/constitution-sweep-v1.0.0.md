# Constitution compliance sweep — v1.0.0

Reviewed 2026-08-25 against the code as of this commit. Method: article-by-
article check, plus mechanical sweeps (dependency lists, `any` in every
emitted `.d.ts`, network calls in core, TODO/FIXME residue).

## Article I — Zero Infrastructure: PASS
No hosted service anywhere. All state is bounded in-memory LRU (offer
ledger, jti cache, session-voucher map, directory cache, report stats);
eviction is amnesty by design. The Stripe webhook ships inside the package
on the operator's keys. Reporting defaults off and the package is fully
functional with it off. The only outbound calls in the codebase: the WBA
key-directory fetch (functional, cached, injectable) and the opt-in
reporter. Operator-configured rails (Stripe, chain RPC/facilitator) are
adapter-isolated per amended I.1.

## Article II — Offer Before Consequence: PASS
Pipeline order is code: payment (steps 5–6) precedes the exhaustion check
(step 7), so a paying key cannot be mazed; humans short-circuit at step 3;
no challenge surface exists anywhere; free_paths pass before identity is
computed (tested by asserting the directory fetcher is never called);
ambiguity fails open to human.

## Article III — Facts, Not Verdicts: PASS
Receipts carry path_class (first segment only) and never bodies — held by a
sentinel test. SPOOF receipts cannot carry a verified agent_key even when
correctly signed: builder throws AND verifier rejects the forged variant.
No blocklist is shipped, fetched, or consumed.

## Article IV — Cryptography: PASS
Ed25519 only, via @noble/ed25519. Vouchers key-bound by default; bearer
behind toll.stripe.bearer. Amended IV.13 staleness rule implemented and
tested, including expired-AND-tampered precedence (crypto outranks time).

## Article V — Honest Enforcement Claims: PASS
Soft enforcement stated in module headers and README, and demonstrated by a
test that deliberately over-spends within replay_window. The x402 network
table ships base-sepolia only; a verified authorization is documented as a
payable claim, not a settled payment. Every advertised number comes from
bench/bench.ts, which also gates CI (--check).

## Article VI — Maze Hygiene: PASS
Corpus is build/CLI-time generated, deterministic from a seed. Every maze
response: X-Robots-Tag noindex,nofollow + no-store; one configurable
prefix; robotsFragment() emits the disallow lines; decoys are never served
at real content URLs (302 into the prefix); pages are generated pseudo-
technical text with no real content, brands, or people.

## Article VII — Code & Project Discipline: PASS
TS strict + noUncheckedIndexedAccess; zero `any` in any emitted .d.ts
(mechanically verified). Config zod-validated, fails startup naming the
key, including toll-mode cross-field rules. Every FR maps to tests
(FR-1 wba/heuristics, FR-2 offer, FR-3 adapter-x402, FR-4 voucher/stripe,
FR-5 ledger, FR-6 maze, FR-7 receipts/reporter, FR-8 report endpoint,
FR-9 cli, FR-10 config); ACs live as named integration tests. MIT; no
telemetry, no update checks. Dep budget: core 3 of 5. ADRs 001–002 cover
the two plan deviations. License headers and publish metadata added in
this commit.

## Known limits accepted at v1.0.0
- EIP-712 encoding is round-trip tested; byte-compatibility with mainnet
  USDC domain parameters is unexercised until the agent client runs against
  Base Sepolia for real.
- hono's siteKeys option wants {secret, pub} while loadOrCreateSiteKey
  returns {secretKey, publicKey} — mapping shown in the README; candidate
  v1.1 alias.
- examples/agent-client.ts returns a body-consumed Response when it cannot
  pay (example simplicity).
- Spoof receipts emit in observe mode too when reporting is enabled —
  receipts are observations and observe mode observes.
- Process restart clears the jti cache and offer ledger (documented:
  per-instance state, amnesty).
