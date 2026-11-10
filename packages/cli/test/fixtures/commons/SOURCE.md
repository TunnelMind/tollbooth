# Commons export fixtures

Tollbooth was renamed Fareseal on 2026-11-10.

Real lines from the live Conduct Log Commons export, copied verbatim, never
edit; tampered copies are made in tests.

Fetched 2026-11-07 with read-only GETs (`curl -s`), bytes written by shell
redirect, not retyped.

| File | URL | Day | Lines |
| --- | --- | --- | --- |
| `receipts.ndjson` | `https://data.tunnelmind.ai/v1/tollbooth/export?day=2026-10-24&kind=receipts` | 2026-10-24, kind `receipts` | 1 |
| `reports.ndjson` | `https://data.tunnelmind.ai/v1/tollbooth/export?day=2026-11-04&kind=reports` | 2026-11-04, kind `reports` | 3 |

- `receipts.ndjson` holds the whole response: it is the only real receipt
  line the live export holds. Tests that need several receipt lines repeat
  this line, with a comment saying it is a copy of the 2026-10-24 line.
- `reports.ndjson` is the first 3 lines (`head -n 3`) of a 5000-line
  response. Every line is a snapshot (`snapshot.kind ===
  "tollbooth-observe-snapshot"`); tests key on the doc type, not the file
  name.

Each line is `{"_commons": …, "receipt" | "snapshot": …}`; the inner doc's
`sig` verifies with Ed25519 over `canonicalize(doc minus sig)` under
`fromBase64Url(doc.site)`.
