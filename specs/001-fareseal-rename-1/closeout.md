# Closeout: Tollbooth → Fareseal (T012)

Tollbooth was renamed Fareseal on 2026-11-10.

## Counts (`git grep -i tollbooth`)

| | files (`-il`) | lines |
| --- | --- | --- |
| before (origin/main) | 94 | 601 |
| after | 77 | 399 |

Every remaining file is justified, by literal path, in `docs/RENAME-FARESEAL.md` § Remaining matches.

## Aliases (old → new; removed in 3.0.0 unless noted)

- `@tunnelmindai/tollbooth-*` → `@tunnelmindai/fareseal-*` (old names stay published, deprecated; never unpublished)
- `TOLLBOOTH_<X>` env vars → `FARESEAL_<X>` (via `readEnv()`; not scheduled for removal)
- `TollboothConfig` → `FaresealConfig`
- `tollbooth()` / `TollboothOptions` → `fareseal()` / `FaresealOptions`
- `CloudflareTollboothOptions` / `tollboothEnvMarker` → `CloudflareFaresealOptions` / `faresealEnvMarker`
- `TollboothBindingMissingError` → `FaresealBindingMissingError` (same class)
- `./tollbooth.key` → `./fareseal.key`
- `/_tollbooth/{arrival,report,stripe-webhook,voucher/}` → `/_fareseal/...`
- `tollbooth-voucher` header → `fareseal-voucher`
- `x-tollbooth-env`, `x-tollbooth-mode|reporting|settling|env`, `x-tollbooth-domain` → `x-fareseal-*`
- `/.well-known/tollbooth-maze` → `/.well-known/fareseal-maze`
- `tollbooth` CLI bin → `fareseal`
- `/.well-known/tollbooth-site.json` → `fareseal-site.json` (CLI falls back on 404)

Frozen, not renamed: snapshot `kind` `tollbooth-observe-snapshot`, corpus seed `tollbooth`, Commons fixtures, jcs vectors, `data.tunnelmind.ai/v1/tollbooth/*` endpoints.

## Owner tasks (N007)

1. Rename the GitHub repo `TunnelMind/tollbooth` → `TunnelMind/fareseal`.
2. Configure npm trusted publishing for the `@tunnelmindai/fareseal-*` packages.
3. Tag `v2.2.0` and publish.
4. Follow-up PR: update `repository`/`homepage` URLs, README clone URL, `docs/vendoring.md`, `publish.yml` comment.
5. Optional: set `FARESEAL_*` Cloudflare secrets (old `TOLLBOOTH_*` keep working).
