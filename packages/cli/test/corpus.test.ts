import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { corpusHash, generateCorpus } from "../src/corpus.js";

const run = promisify(execFile);

describe("D-5 - seeded deterministic maze corpus", () => {
  it("same seed => same corpus hash; different seed => different", async () => {
    const a = generateCorpus({ seed: "s1", pages: 50 });
    const b = generateCorpus({ seed: "s1", pages: 50 });
    const c = generateCorpus({ seed: "s2", pages: 50 });
    expect(await corpusHash(a)).toBe(await corpusHash(b));
    expect(await corpusHash(a)).not.toBe(await corpusHash(c));
  });

  it("2000 pages fit the budget: total <= 7 MB, each <= page_bytes_max", () => {
    const corpus = generateCorpus({ seed: "budget" });
    expect(corpus.size).toBe(2000);
    let total = 0;
    for (const [name, html] of corpus) {
      expect(name).toMatch(/^page-\d{4}\.html$/);
      expect(html.length).toBeLessThanOrEqual(4096); // ASCII: length == bytes
      total += html.length;
    }
    expect(total).toBeLessThanOrEqual(7 * 1024 * 1024);
  });

  it("links stay internal, resolve, and sustain a 20-hop walk (AC-4.3 depth)", () => {
    const corpus = generateCorpus({ seed: "walk", pages: 200 });
    for (const [, html] of corpus) {
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(
        (m) => m[1] as string,
      );
      expect(hrefs.length).toBeGreaterThanOrEqual(3);
      for (const href of hrefs) {
        expect(href).not.toMatch(/^https?:|^\/\//); // never external
        expect(corpus.has(href)).toBe(true);
      }
    }
    let at = "page-0000.html";
    for (let hop = 0; hop < 20; hop++) {
      const html = corpus.get(at);
      if (!html) throw new Error(`walk broke at hop ${hop}: ${at}`);
      const next = /href="([^"]+)"/.exec(html)?.[1];
      if (!next) throw new Error(`no link at hop ${hop}`);
      at = next;
    }
  });

  it("pages are plausible-but-valueless html with no scripts", () => {
    const corpus = generateCorpus({ seed: "shape", pages: 3 });
    for (const [, html] of corpus) {
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain("<h1>");
      expect(html).toContain("<p>");
      expect(html).not.toContain("<script");
    }
  });
});

describe("cli corpus command", () => {
  it("writes the corpus to disk and prints the hash", async () => {
    const out = await mkdtemp(join(tmpdir(), "tollbooth-corpus-"));
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const { stdout } = await run("node", [
      cli,
      "corpus",
      "--seed",
      "cli-test",
      "--pages",
      "5",
      "--out",
      out,
    ]);
    expect(stdout).toMatch(/5 pages/);
    expect(stdout).toMatch(/sha256 [0-9a-f]{64}/);
    expect((await readdir(out)).sort()).toEqual([
      "page-0000.html",
      "page-0001.html",
      "page-0002.html",
      "page-0003.html",
      "page-0004.html",
    ]);
  });
});
