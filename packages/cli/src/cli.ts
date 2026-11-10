#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tollbooth CLI: corpus (T-015), verify (T-020), voucher inspect/mint (FR-9;
// mint is the re-mint fallback for expired-unredeemed purchases, spec 5.3).
//
// `verify` trust: the file is hostile and only core judges it: verifySnapshot
// for an observe snapshot, verifyReceipt for anything else. A Conduct Log
// Commons export line ({_commons, receipt|snapshot}) is unwrapped first; its
// _commons envelope is unsigned and never verified. A file that is not one
// JSON document is read as JSON lines (blank lines skipped, one trailing \r
// stripped); each line's report is prefixed `line N: ` and the run PASSes only
// if there is at least one document and all pass. The key is the operator's
// --pubkey or --pin file; with --domain alone it is each document's own `site`
// key, which passes only if https://<host>/.well-known/tollbooth-site.json
// lists it (fetched once per run, unlisted keys named for a file of lines; a
// bare host[:port], no redirects, 5 s timeout, 64 KB cap).
// Exit 0 PASS, 1 FAIL, 64 usage.
// `voucher mint` reads (or, if missing, creates) the site secret key file via
// core/node and prints only the public key and the voucher, never the secret.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeVoucher,
  fromBase64Url,
  mintVoucher,
  toBase64Url,
  verifyReceipt,
  verifySnapshot,
} from "@tunnelmindai/fareseal-core";
import {
  DEFAULT_SITE_KEY_PATH,
  loadOrCreateSiteKey,
} from "@tunnelmindai/fareseal-core/node";
import { corpusHash, generateCorpus } from "@tunnelmindai/fareseal-maze";

const USAGE = `usage:
  tollbooth corpus [--seed s] [--pages n] [--max-bytes n] [--out dir]
  tollbooth verify <file> --pubkey <site-pub-b64url> | --pin <file> | --domain <host>
    <file> is a receipt, a snapshot, an export line, or a file of lines (one per line)
  tollbooth voucher inspect <voucher>
  tollbooth voucher mint --agent <pubkey>|--bearer [--key path] [--credits n] [--ttl-days n]`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function corpus(args: string[]): Promise<number> {
  const seed = flag(args, "seed") ?? "tollbooth";
  const pages = Number(flag(args, "pages") ?? 2000);
  const pageBytesMax = Number(flag(args, "max-bytes") ?? 4096);
  const out = flag(args, "out") ?? "./maze-corpus";
  if (
    !Number.isInteger(pages) ||
    pages < 1 ||
    !Number.isInteger(pageBytesMax)
  ) {
    console.error("corpus: --pages and --max-bytes must be positive integers");
    return 64;
  }
  const generated = generateCorpus({ seed, pages, pageBytesMax });
  await mkdir(out, { recursive: true });
  let total = 0;
  for (const [name, html] of generated) {
    await writeFile(join(out, name), html);
    total += html.length;
  }
  console.log(
    `${generated.size} pages, ${total} bytes, seed "${seed}", sha256 ${await corpusHash(generated)}`,
  );
  return 0;
}

const SITE_JSON_MAX_BYTES = 65536;

/**
 * Keys a domain vouches for via https://<host>/.well-known/tollbooth-site.json
 * ({ "v": 1, "keys": [b64url...] }). The only network call in this CLI, and
 * only behind an explicit --domain. https only, no redirects (one could land
 * on http or an internal host), 5 s timeout, 64 KB cap enforced while reading.
 */
async function domainKeys(host: string): Promise<string[]> {
  // A bare host[:port] only, so the argument cannot steer the path or scheme.
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new Error("bad host");
  const resp = await fetch(`https://${host}/.well-known/tollbooth-site.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > SITE_JSON_MAX_BYTES) {
      await reader?.cancel();
      throw new Error("tollbooth-site.json exceeds 64KB");
    }
    chunks.push(chunk.value);
  }
  const doc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    v?: unknown;
    keys?: unknown;
  };
  if (
    doc?.v !== 1 ||
    !Array.isArray(doc.keys) ||
    !doc.keys.every((k) => typeof k === "string")
  )
    throw new Error("tollbooth-site.json is not { v: 1, keys: [...] }");
  return doc.keys;
}

/**
 * Checks one parsed document (FR-002, FR-003, FR-006) and returns its report
 * lines, the key it was checked against (for the --domain step) and the
 * verdict. An export line `{_commons, receipt|snapshot}` is unwrapped first;
 * `_commons` itself is never verified, so the report says so. A snapshot goes
 * to verifySnapshot, anything else to verifyReceipt, so a bare receipt (and
 * garbage) prints exactly what it did before export lines existed.
 */
async function checkDocument(
  parsed: unknown,
  pubkey: string | undefined,
): Promise<{ lines: string[]; key: string; ok: boolean }> {
  let value = parsed;
  let unwrapped = false;
  if (value !== null && typeof value === "object" && "_commons" in value) {
    const keys = Object.keys(value);
    const inner = keys.filter((k) => k === "receipt" || k === "snapshot");
    if (keys.length !== 2 || inner.length !== 1) {
      const why =
        inner.length === 2
          ? "both receipt and snapshot"
          : inner.length === 0
            ? "no receipt or snapshot"
            : "unexpected keys";
      return {
        lines: [
          `schema: FAIL (export line: ${why})`,
          "canonical form: SKIPPED",
          "signature: SKIPPED",
        ],
        key: "",
        ok: false,
      };
    }
    value = (value as Record<string, unknown>)[inner[0] as string];
    unwrapped = true;
  }
  const isSnapshot =
    (value as { kind?: unknown } | null)?.kind === "tollbooth-observe-snapshot";
  const lines: string[] = [];
  if (unwrapped || isSnapshot)
    lines.push(
      `document: ${isSnapshot ? "snapshot" : "receipt"}${unwrapped ? ", from an export line; the _commons envelope is not signed" : ""}`,
    );
  // --domain alone: verify against the document's own site key, then require
  // the domain to vouch for it. A non-string falls to the schema check.
  const site = (value as { site?: unknown } | null)?.site;
  const key = pubkey ?? (typeof site === "string" ? site : "");
  let keyBytes: Uint8Array = new Uint8Array();
  try {
    keyBytes = fromBase64Url(key);
  } catch {
    // not base64url: left empty, so the verifier reports site-mismatch
  }
  const result = isSnapshot
    ? await verifySnapshot(value, keyBytes)
    : await verifyReceipt(value, keyBytes);
  // Both verifiers check schema, then canonical form, then signature, and
  // report the first failure: each line reads PASS up to it, FAIL at it,
  // SKIPPED after it.
  const canonFail = result.reason?.startsWith("canonical form") ?? false;
  const schemaOk = result.ok || result.reason === "signature" || canonFail;
  lines.push(
    `schema: ${schemaOk ? "PASS" : `FAIL (${result.reason})`}`,
    `canonical form: ${!schemaOk ? "SKIPPED" : canonFail ? `FAIL (${result.reason})` : "PASS"}`,
    `signature: ${result.ok ? "PASS" : schemaOk && !canonFail ? "FAIL" : "SKIPPED"}`,
  );
  return { lines, key, ok: result.ok };
}

/**
 * AC-6.1: verification, printing each check. No network unless --domain is
 * given; --pubkey/--pin verify offline but say the key is not domain-bound.
 */
async function verifyCmd(args: string[]): Promise<number> {
  const file = args.find(
    (a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"),
  );
  const pin = flag(args, "pin");
  const domain = flag(args, "domain");
  let pubkey = flag(args, "pubkey");
  if (
    file === undefined ||
    (pubkey === undefined && pin === undefined && domain === undefined)
  ) {
    console.error(USAGE);
    return 64;
  }
  if (pubkey === undefined && pin !== undefined) {
    try {
      pubkey = (await readFile(pin, "utf8")).trim();
    } catch {
      console.error(`verify: cannot read pin file ${pin}`);
      return 64;
    }
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    console.log("schema: FAIL (unreadable or not JSON)");
    console.log("FAIL");
    return 1;
  }
  // FR-001: the whole file as one document first; only if that fails is it a
  // file of lines. `docs` holds each document with its 1-based physical line
  // number (null for a single document, which prints with no prefix).
  let docs: { n: number | null; value: unknown; json: boolean }[];
  try {
    docs = [{ n: null, value: JSON.parse(text), json: true }];
  } catch {
    // A broken pretty-printed document (first line a lone `{` or `{ "a":`)
    // is one bad document, not a file of lines: report it once, as before
    // files of lines existed. A first line that closes with `}` (any first
    // line that parses as an object does) reads as a line-shaped file and
    // gets per-line reports.
    const first = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    if (first.startsWith("{") && !first.endsWith("}")) {
      console.log("schema: FAIL (unreadable or not JSON)");
      console.log("FAIL");
      return 1;
    }
    docs = [];
    text.split("\n").forEach((raw, i) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.trim() === "") return;
      try {
        docs.push({ n: i + 1, value: JSON.parse(line), json: true });
      } catch {
        docs.push({ n: i + 1, value: undefined, json: false });
      }
    });
  }
  if (docs.length === 0) {
    console.log("schema: FAIL (no documents)");
    console.log("FAIL");
    return 1;
  }
  let ok = true;
  const keys = new Set<string>();
  for (const doc of docs) {
    const prefix = doc.n === null ? "" : `line ${doc.n}: `;
    if (!doc.json) {
      console.log(`${prefix}schema: FAIL (not JSON)`);
      ok = false;
      continue;
    }
    const result = await checkDocument(doc.value, pubkey);
    for (const line of result.lines) console.log(prefix + line);
    // A document that fails before yielding a key (a malformed export line,
    // or no --pubkey and a non-string site) has key "": never ask the domain
    // about an empty name.
    if (result.key !== "") keys.add(result.key);
    ok &&= result.ok;
  }
  if (domain === undefined) {
    console.log("key not bound to a domain");
  } else if (keys.size === 0) {
    // No document yielded a key (each already a FAIL), so no fetch.
    console.log("domain: FAIL (no keys)");
    ok = false;
  } else {
    // FR-008: one fetch for the whole file; every document's key must be
    // listed. `_commons.domain` is never consulted (it is unsigned).
    try {
      const listed = await domainKeys(domain);
      const unlisted = [...keys].filter((k) => !listed.includes(k));
      const single = docs[0]?.n === null;
      console.log(
        `domain: ${
          unlisted.length === 0
            ? "PASS"
            : single
              ? `FAIL (key not listed by ${domain})`
              : `FAIL (key not listed by ${domain}: ${unlisted.join(", ")})`
        }`,
      );
      ok &&= unlisted.length === 0;
    } catch (error) {
      console.log(`domain: FAIL (${(error as Error).message})`);
      ok = false;
    }
  }
  console.log(ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}

async function voucherCmd(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "inspect") {
    const encoded = rest.find((a) => !a.startsWith("--"));
    if (encoded === undefined) {
      console.error(USAGE);
      return 64;
    }
    try {
      console.log(JSON.stringify(decodeVoucher(encoded), null, 2));
      return 0;
    } catch (error) {
      console.error(`invalid voucher: ${(error as Error).message}`);
      return 1;
    }
  }
  if (sub === "mint") {
    const agent = flag(rest, "agent") ?? null;
    const bearer = rest.includes("--bearer");
    if (agent === null && !bearer) {
      console.error("voucher mint: --agent <pubkey> or --bearer required");
      return 64;
    }
    const keyPath = flag(rest, "key") ?? DEFAULT_SITE_KEY_PATH;
    const credits = Number(flag(rest, "credits") ?? 5000);
    const ttlDays = Number(flag(rest, "ttl-days") ?? 30);
    if (!Number.isInteger(credits) || credits < 1 || !(ttlDays > 0)) {
      console.error("voucher mint: --credits and --ttl-days must be positive");
      return 64;
    }
    const site = await loadOrCreateSiteKey(keyPath);
    if (site.created)
      console.error(
        `note: created site key at ${keyPath}; public key ${toBase64Url(site.publicKey)}`,
      );
    const nowS = Math.floor(Date.now() / 1000);
    console.log(
      await mintVoucher(
        {
          agentKey: bearer ? null : agent,
          credits,
          expiresS: nowS + ttlDays * 86_400,
          nowS,
        },
        site.secretKey,
      ),
    );
    return 0;
  }
  console.error(USAGE);
  return 64;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "corpus":
    process.exitCode = await corpus(rest);
    break;
  case "verify":
    process.exitCode = await verifyCmd(rest);
    break;
  case "voucher":
    process.exitCode = await voucherCmd(rest);
    break;
  default:
    console.error(USAGE);
    process.exitCode = 64;
}
