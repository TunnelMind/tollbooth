// SPDX-License-Identifier: MIT
/**
 * Read an env var by suffix. FARESEAL_<suffix> wins; TOLLBOOTH_<suffix> is the
 * pre-2026-11-10 alias. Values are trimmed; an empty/blank new value counts as
 * unset and falls back to the old name, so a deploy that blanks the new var
 * does not silently drop a still-set old one.
 */
export function readEnv(env: Record<string, unknown>, suffix: string): string {
  for (const k of [`FARESEAL_${suffix}`, `TOLLBOOTH_${suffix}`]) {
    const v = env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
