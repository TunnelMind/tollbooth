# Tollbooth → Fareseal rename

Tollbooth was renamed Fareseal on 2026-11-10. One row per renamed surface.

| Surface | Old | New | Old still works? | Removed in |
| --- | --- | --- | --- | --- |
| npm package names | `@tunnelmindai/tollbooth-*` | `@tunnelmindai/fareseal-*` | Old names stay published, deprecated; no code alias | never unpublished |
| Repo slug | `TunnelMind/tollbooth` | `TunnelMind/fareseal` (after N007; until then the slug and the `repository` URLs stay) | GitHub redirects after the rename | n/a |
| Env vars (`SITE_KEY`, `SETTLE_TOKEN`, `ENV`, `FLUSH_INTERVAL_MS`, `EXAMPLE_SERVE`, `REPORT_TOKEN`) | `TOLLBOOTH_<X>` | `FARESEAL_<X>` | Yes: `readEnv()` in core reads `FARESEAL_` first, falls back to `TOLLBOOTH_`; a blank new value falls back. `REPORT_TOKEN` is read by the site's own config builder (`env.FARESEAL_REPORT_TOKEN ?? env.TOLLBOOTH_REPORT_TOKEN`) | not scheduled |
| Config type | `TollboothConfig` | `FaresealConfig` | Yes: `TollboothConfig` stays as a type alias marked `@deprecated` | 3.0.0 |
| Hono middleware | `tollbooth()`, `TollboothOptions` | `fareseal()`, `FaresealOptions` | Yes: `const`/type aliases marked `@deprecated` (same function) | 3.0.0 |
| Cloudflare options and env marker | `CloudflareTollboothOptions`, `tollboothEnvMarker` | `CloudflareFaresealOptions`, `faresealEnvMarker` | Yes: aliases marked `@deprecated` | 3.0.0 |
| Binding error | `TollboothBindingMissingError` (`name`, message prefix `tollbooth:`) | `FaresealBindingMissingError` (`name`, message prefix `fareseal:`) | Yes: same class object, so `instanceof` works under both names; the `name` and message text changed | 3.0.0 |
| Site key file default | `./tollbooth.key` | `./fareseal.key` (config `site_key_path`, `fareseal voucher mint --key`) | Yes: when the default is absent and `./tollbooth.key` exists, it is loaded with one `console.warn` and no new key is written; if both exist the new file wins; explicit paths have no fallback | 3.0.0 |
| Route `/_tollbooth/arrival` | `/_tollbooth/arrival` | `/_fareseal/arrival` | Yes: served as an alias with identical handling (arrival stays free and unrecorded) | 3.0.0 |
| Route `/_tollbooth/report` | `/_tollbooth/report` | `/_fareseal/report` | Yes: served as an alias with identical handling | 3.0.0 |
| Route `/_tollbooth/stripe-webhook` | `/_tollbooth/stripe-webhook` | `/_fareseal/stripe-webhook` | Yes: served as an alias with identical handling | 3.0.0 |
| Route `/_tollbooth/voucher/` | `/_tollbooth/voucher/` | `/_fareseal/voucher/` | Yes: served as an alias with identical handling | 3.0.0 |
| Request/response header `tollbooth-voucher` | `tollbooth-voucher` | `fareseal-voucher` | Yes: the old header is read as a fallback (new wins when both are sent) and emitted alongside the new one | 3.0.0 |

`PRICE_USD` and `LEAK_REPLAY` do not exist on origin/main: `git grep -n 'PRICE_USD\|LEAK_REPLAY'` finds nothing (only the lower-case `price_usd` settle-body field, which is not an env var), so there is nothing to alias.
