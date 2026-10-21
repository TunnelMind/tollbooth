import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

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
