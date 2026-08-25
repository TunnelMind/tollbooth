#!/usr/bin/env node
// tollbooth CLI: corpus (T-015), verify (T-020), voucher inspect/mint (FR-9;
// mint is the re-mint fallback for expired-unredeemed purchases, spec 5.3).
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
import { corpusHash, generateCorpus } from "./corpus.js";

const USAGE = `usage:
  tollbooth corpus [--seed s] [--pages n] [--max-bytes n] [--out dir]
  tollbooth verify <receipt.json> --pubkey <site-pub-b64url>
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

/** AC-6.1: offline verification, printing each check. No network anywhere. */
async function verifyCmd(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith("--"));
  const pubkey = flag(args, "pubkey");
  if (file === undefined || pubkey === undefined) {
    console.error(USAGE);
    return 64;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    console.log("schema: FAIL (unreadable or not JSON)");
    console.log("FAIL");
    return 1;
  }
  const result = await verifyReceipt(value, fromBase64Url(pubkey));
  const schemaOk = result.ok || result.reason === "signature";
  console.log(`schema: ${schemaOk ? "PASS" : `FAIL (${result.reason})`}`);
  console.log(`canonical form: ${schemaOk ? "PASS" : "SKIPPED"}`);
  console.log(
    `signature: ${result.ok ? "PASS" : schemaOk ? "FAIL" : "SKIPPED"}`,
  );
  console.log(result.ok ? "PASS" : "FAIL");
  return result.ok ? 0 : 1;
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
