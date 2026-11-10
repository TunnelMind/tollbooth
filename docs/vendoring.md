# Vendoring Fareseal

Template for downstream projects that vendor Fareseal packages instead of
installing them from npm. Copy this file next to the vendored tarballs and fill
it in, so anyone can rebuild from the same commit and check they got the same
bytes.

## Produce the values

From a clean checkout of the commit you are vendoring:

```bash
git rev-parse HEAD                      # build commit SHA
pnpm install --frozen-lockfile
pnpm build                              # tsc -b; pack ships dist/, so build first
pnpm -r --filter='!@tunnelmindai/fareseal-cli' --filter='!@tunnelmindai/fareseal-adapter-stripe' pack --pack-destination ./vendor
cd vendor && sha256sum *.tgz            # one line per package tarball
```

`pnpm -r pack` skips examples and bench (they have no version field) but still
packs the private cli and adapter-stripe, so the filters above drop them.
`vendor/` then holds exactly the five published `@tunnelmindai/fareseal-*`
packages: core, hono, maze, adapter-x402 and cloudflare. A different Node or
pnpm version can change the tarball bytes, so record both.

## Vendored build

| field | value |
|---|---|
| source | https://github.com/TunnelMind/tollbooth |
| build commit | `<git rev-parse HEAD>` |
| node / pnpm | `<node --version>` / `<pnpm --version>` |
| vendored on | `<YYYY-MM-DD>` |

| package tarball | sha256 |
|---|---|
| `tunnelmindai-fareseal-adapter-x402-<version>.tgz` | `<sha256>` |
| `tunnelmindai-fareseal-cloudflare-<version>.tgz` | `<sha256>` |
| `tunnelmindai-fareseal-core-<version>.tgz` | `<sha256>` |
| `tunnelmindai-fareseal-hono-<version>.tgz` | `<sha256>` |
| `tunnelmindai-fareseal-maze-<version>.tgz` | `<sha256>` |

To check a vendored copy later: `cd vendor && sha256sum -c` against the lines
above (as `sha256sum` printed them).
