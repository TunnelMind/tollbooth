# ADR 006 — `tollbooth verify` checks export lines and snapshots

**Status:** Accepted (2026-11-07, coordinator on Josh's delegation)
**Deviates from / extends:** spec 126 `plan.md`, "Where the change goes" and
"Approach notes"; spec 126 `spec.md` FR-001–FR-004 and FR-008. Required by
the plan's Constitution Check row for tollbooth VII.24 (ADR before a
format/contract decision).

Today `verifyCmd` in `packages/cli/src/cli.ts` does `JSON.parse` on the whole
file and hands the result to core's `verifyReceipt`
(`packages/core/src/receipt.ts`). The Conduct Log Commons publishes three
other shapes: a wrapped export line `{"_commons":{…},"receipt":{…}}`, the
same with `"snapshot"` (a document signed by `flushSnapshot` in
`packages/cloudflare/src/index.ts`, `kind: "tollbooth-observe-snapshot"`),
and a file of such lines. All three FAIL today, though every inner document
is genuinely signed.

**Decision:**

1. **Three new inputs.** `tollbooth verify <file>` accepts a wrapped export
   line, a file of lines (NDJSON: whole-file JSON first, else one document
   per non-blank line), and a snapshot, bare or wrapped. A plain receipt
   file keeps today's output byte for byte.
2. **Core gains `verifySnapshot(value, sitePub)`**, next to `verifyReceipt`
   in `packages/core/src/receipt.ts` and exported from
   `packages/core/src/index.ts`. Same contract as `verifyReceipt`: fails
   closed, never throws, returns `{ ok, reason }`. The tail of
   `verifyReceipt` (from `const { sig, ...unsigned }` on: `canonicalize`
   from `packages/core/src/canonicalize.ts`, the one canonical base64url sig
   spelling, Ed25519 `verify`) moves into one private helper,
   `verifySigned(doc, sitePub)`, which both functions call. A snapshot can
   never be checked more loosely than a receipt.
3. **A key source stays required:** `--pubkey`, `--pin` or `--domain`. The
   document's own `site` is used as the key only under `--domain`, and then
   only passes if `https://<host>/.well-known/tollbooth-site.json` lists it
   (`domainKeys`, unchanged, fetched once per run for all documents).
4. **The `_commons` envelope is unsigned and never used.** It is stripped
   when unwrapping; its `tier`, `domain` and `received_at` never pick a key
   and are never reported as verified. The report says so in its
   `document:` line.

**Consequences:**

- `verifySnapshot` is new public SDK surface in tollbooth-core.
- `verifyReceipt`'s behaviour and reasons do not change; the refactor is
  pinned by a golden-output test written before it.
- Anything core rejects FAILs in the CLI too, so the CLI is at least as
  strict as the `/conduct/log` browser check.

**Rejected alternatives:**

- **Self-keyed verify with no flag** (use the document's `site` when no key
  is given). The document would name its own key, so any self-signed forgery
  passes; that is not verification.
- **A CLI-local snapshot check** in `cli.ts`. It duplicates the crypto
  outside core and drifts from `verifyReceipt` (the sig-spelling check is
  the first thing that gets lost); SDK users would get nothing.
- **Changing `@tunnelmindai/receipt-verify`.** It rejects both shapes, which
  is correct for its scope; changing it breaks its existing behaviour and
  callers, and spec 126 FR-012 forbids it.
- **Reading `_commons.domain`** to choose the domain to check. The envelope
  is unsigned, so whoever hands over the file controls it and could point
  the check at a domain they own.

Revisit if the export ever signs its envelope, or a third document kind
appears.
