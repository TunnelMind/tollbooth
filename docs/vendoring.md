# Vendoring tollbooth

Template for downstream projects that vendor tollbooth packages instead of
installing them from npm. Copy this file next to the vendored tarballs and fill
it in, so anyone can rebuild from the same commit and check they got the same
bytes.

## Produce the values

From a clean checkout of the commit you are vendoring:

```bash
git rev-parse HEAD                      # build commit SHA
pnpm install --frozen-lockfile
pnpm build                              # tsc -b; pack ships dist/, so build first
pnpm -r --filter='!@tunnelmindai/tollbooth-cli' --filter='!@tunnelmindai/tollbooth-adapter-stripe' pack --pack-destination ./vendor
cd vendor && sha256sum *.tgz            # one line per package tarball
```

`pnpm -r pack` skips examples and bench (they have no version field) but still
packs the private cli and adapter-stripe, so the filters above drop them.
`vendor/` then holds exactly the five published `@tunnelmindai/tollbooth-*`
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
| `tunnelmindai-tollbooth-adapter-x402-<version>.tgz` | `<sha256>` |
| `tunnelmindai-tollbooth-cloudflare-<version>.tgz` | `<sha256>` |
| `tunnelmindai-tollbooth-core-<version>.tgz` | `<sha256>` |
| `tunnelmindai-tollbooth-hono-<version>.tgz` | `<sha256>` |
| `tunnelmindai-tollbooth-maze-<version>.tgz` | `<sha256>` |

To check a vendored copy later: `cd vendor && sha256sum -c` against the lines
above (as `sha256sum` printed them).
