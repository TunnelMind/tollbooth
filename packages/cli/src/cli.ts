#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tollbooth CLI: corpus (T-015), verify (T-020), voucher inspect/mint (FR-9;
// mint is the re-mint fallback for expired-unredeemed purchases, spec 5.3).
//
// `verify` trust: the receipt file is hostile and only core's verifyReceipt
// judges it. The key is the operator's --pubkey or --pin file; with --domain
// alone it is the receipt's own `site` key, which passes only if
// https://<host>/.well-known/tollbooth-site.json lists it (a bare host[:port],
// no redirects, 5 s timeout, 64 KB cap). Exit 0 PASS, 1 FAIL, 64 usage.
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
} from "@tollbooth/core";
import { loadOrCreateSiteKey } from "@tollbooth/core/node";
import { corpusHash, generateCorpus } from "@tollbooth/maze";

const USAGE = `usage:
  tollbooth corpus [--seed s] [--pages n] [--max-bytes n] [--out dir]
  tollbooth verify <receipt.json> --pubkey <site-pub-b64url> | --pin <file> | --domain <host>
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
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    console.log("schema: FAIL (unreadable or not JSON)");
    console.log("FAIL");
    return 1;
  }
  // --domain alone: verify against the receipt's own site key, then require
  // the domain to vouch for it below. A non-string falls to the schema check.
  const site = (value as { site?: unknown } | null)?.site;
  const key = pubkey ?? (typeof site === "string" ? site : "");
  let keyBytes: Uint8Array = new Uint8Array();
  try {
    keyBytes = fromBase64Url(key);
  } catch {
    // not base64url: left empty, so verifyReceipt reports site-mismatch
  }
  const result = await verifyReceipt(value, keyBytes);
  // verifyReceipt checks schema, then canonical form, then signature, and
  // reports the first failure: each line reads PASS up to it, FAIL at it,
  // SKIPPED after it.
  const canonFail = result.reason?.startsWith("canonical form") ?? false;
  const schemaOk = result.ok || result.reason === "signature" || canonFail;
  console.log(`schema: ${schemaOk ? "PASS" : `FAIL (${result.reason})`}`);
  console.log(
    `canonical form: ${!schemaOk ? "SKIPPED" : canonFail ? `FAIL (${result.reason})` : "PASS"}`,
  );
  console.log(
    `signature: ${result.ok ? "PASS" : schemaOk && !canonFail ? "FAIL" : "SKIPPED"}`,
  );
  let ok = result.ok;
  if (domain === undefined) {
    console.log("key not bound to a domain");
  } else {
    try {
      const listed = (await domainKeys(domain)).includes(key);
      console.log(
        `domain: ${listed ? "PASS" : `FAIL (key not listed by ${domain})`}`,
      );
      ok &&= listed;
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
    const keyPath = flag(rest, "key") ?? "./tollbooth.key";
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
