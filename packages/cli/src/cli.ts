#!/usr/bin/env node
// tollbooth CLI. Subcommands arrive with their tasks: corpus (T-015),
// verify (T-020), voucher inspect/mint (T-020/T-013 fallback).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { corpusHash, generateCorpus } from "./corpus.js";

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

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "corpus":
    process.exitCode = await corpus(rest);
    break;
  default:
    console.error(
      "usage: tollbooth corpus [--seed s] [--pages n] [--max-bytes n] [--out dir]",
    );
    process.exitCode = 64;
}
