import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCorpus } from "@tollbooth/cli";
import { parseConfig } from "@tollbooth/core";
import { describe, expect, it } from "vitest";
import {
  corpusFromMap,
  makeMazeHandler,
  robotsFragment,
} from "../src/index.js";
import { loadCorpusDir } from "../src/node.js";

const CFG = parseConfig(""); // maze defaults: prefix /.well-known/tollbooth-maze, 800ms, 4096B
const PREFIX = CFG.maze.prefix;
const pages = generateCorpus({ seed: "maze-test", pages: 20 });

function handler(delays: number[] = []) {
  return makeMazeHandler({
    corpus: corpusFromMap(pages),
    cfg: CFG,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
}

describe("US-4 AC-4.3 - maze serving hygiene", () => {
  it("serves the entry page at the prefix root with all hygiene headers", async () => {
    const resp = await handler()(PREFIX);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe(pages.get("page-0000.html"));
    expect(resp.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(resp.headers["content-type"]).toContain("text/html");
    expect(resp.headers["cache-control"]).toBe("no-store");
  });

  it("serves specific pages under the prefix", async () => {
    const resp = await handler()(`${PREFIX}/page-0007.html`);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe(pages.get("page-0007.html"));
  });

  it("unknown paths under the prefix serve a deterministic page - the maze has no edges", async () => {
    const h = handler();
    const first = await h(`${PREFIX}/anything/deeper/here.html`);
    const again = await h(`${PREFIX}/anything/deeper/here.html`);
    expect(first.status).toBe(200);
    expect(first.body).toBe(again.body);
    expect([...pages.values()]).toContain(first.body);
  });

  it("404s paths outside the prefix (wiring guard)", async () => {
    expect((await handler()("/real-content")).status).toBe(404);
  });

  it("throttles every response by maze_delay_ms via the injected timer", async () => {
    const delays: number[] = [];
    await handler(delays)(`${PREFIX}/page-0001.html`);
    await handler(delays)(PREFIX);
    expect(delays).toEqual([800, 800]);
  });

  it("bodies never exceed page_bytes_max", async () => {
    const big = corpusFromMap(
      new Map([["page-0000.html", "x".repeat(10_000)]]),
    );
    const resp = await makeMazeHandler({
      corpus: big,
      cfg: CFG,
      sleep: async () => {},
    })(PREFIX);
    expect(resp.body.length).toBeLessThanOrEqual(CFG.maze.page_bytes_max);
  });
});

describe("VI.18 - robots.txt fragment", () => {
  it("disallows the maze prefix for every crawler", () => {
    const fragment = robotsFragment(PREFIX);
    expect(fragment).toContain("User-agent: *");
    expect(fragment).toContain(`Disallow: ${PREFIX}/`);
  });
});

describe("node corpus loader - O(file read) serving", () => {
  it("loads a directory lazily and refuses traversal names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-maze-"));
    for (const [name, html] of generateCorpus({ seed: "disk", pages: 5 })) {
      await writeFile(join(dir, name), html);
    }
    const corpus = await loadCorpusDir(dir);
    expect(corpus.pageCount).toBe(5);
    expect(await corpus.get("page-0003.html")).toContain("<h1>");
    expect(await corpus.get("../../../etc/passwd")).toBeUndefined();
    expect(await corpus.get("page-9999.html")).toBeUndefined();
  });

  it("an empty corpus directory fails loudly with the fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-empty-"));
    await expect(loadCorpusDir(dir)).rejects.toThrow(/tollbooth corpus/);
  });
});
