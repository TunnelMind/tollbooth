# @tunnelmindai/tollbooth-cli

> **Notice:** This package is not published. Run it from source with `node packages/cli/dist/cli.js` (build first with `pnpm build`).

tollbooth CLI: maze corpus generation, offline receipt verification, voucher inspect/mint.

<!-- DRAFT: facts verified 2026-11-07; prose is Josh's -->
## verify

```bash
node packages/cli/dist/cli.js verify <file> --pubkey <site> | --pin <file> | --domain <host>
```

`<file>` is a bare receipt, a snapshot (`kind: "tollbooth-observe-snapshot"`), a Conduct Log
Commons export line (`{_commons, receipt|snapshot}`, unwrapped first), or a file of JSON lines
(one document per line, output prefixed `line N: `; PASS only if every line passes; a file
that parses as one JSON document, such as a one-row page, is that document, no prefix). The
`_commons` envelope is not signed and not checked.

- `--pubkey <key>` / `--pin <file>`: offline, one key for every document; prints
  `key not bound to a domain`.
- `--domain <host>`: each document's own `site` key, which
  `https://<host>/.well-known/tollbooth-site.json` must list (one fetch per run).

Exit 0 PASS, 1 FAIL, 64 usage.

Part of [tollbooth](https://github.com/TunnelMind/tollbooth) - pay the toll or meet
the maze: self-hosted middleware that offers crawlers paid access, passes
humans untouched, and leaves offline-verifiable conduct receipts. The
[main README](https://github.com/TunnelMind/tollbooth#readme) has the full
story, quickstart and honest limits. MIT.
