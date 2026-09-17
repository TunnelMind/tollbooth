#!/usr/bin/env node
/**
 * scripts/preset-version.mjs — print the TunnelMind preset version a repo resolves.
 *
 * Why: ADOPTION.md Option C authors governance once and resolves it everywhere;
 * spec 086 requires that "every feature repo reports the preset version" so
 * drift between repos is a number, not a feeling. This is that report.
 *
 * Resolution order (first hit wins):
 *   1. <repo>/.specify/preset.json           — the copy a Tier-1 repo carries
 *   2. $TM_SPEC_ROOT/.specify/preset.json    — the control repo, if pointed at
 *   3. /home/o2k/tunnelmind-spec/.specify/preset.json — the control repo on BEAST
 * A repo with no copy and no control repo prints `tunnelmind@0.0.0 (not initialised)`
 * — never "unknown", so the lag is visible as a number.
 *
 * Run:  node scripts/preset-version.mjs            → tunnelmind@1.2.0 (constitution 1.1.0)
 *       node scripts/preset-version.mjs --json     → {"name":"tunnelmind","version":"1.2.0",...,"source":"<path>"}
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(process.cwd(), ".specify/preset.json"),
  resolve(here, "../.specify/preset.json"),
  process.env.TM_SPEC_ROOT
    ? resolve(process.env.TM_SPEC_ROOT, ".specify/preset.json")
    : null,
  "/home/o2k/tunnelmind-spec/.specify/preset.json",
].filter(Boolean);

const found = candidates.find((p) => existsSync(p));
const json = process.argv.includes("--json");

if (!found) {
  const out = {
    name: "tunnelmind",
    version: "0.0.0",
    constitution: null,
    source: null,
    note: "not initialised",
  };
  console.log(
    json ? JSON.stringify(out) : `${out.name}@${out.version} (not initialised)`,
  );
  process.exit(0);
}
const p = JSON.parse(readFileSync(found, "utf8"));
const out = {
  name: p.name,
  version: p.version,
  constitution: p.constitution,
  source: found,
};
console.log(
  json
    ? JSON.stringify(out)
    : `${p.name}@${p.version} (constitution ${p.constitution})`,
);
