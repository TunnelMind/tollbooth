// Node-only entry (@tollbooth/maze/node): lazy directory-backed corpus.
// Each request costs one readFile - nothing is preloaded, nothing is
// generated (AC-4.3 O(file read)).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type MazeCorpus, PAGE_NAME_RE } from "./index.js";

export async function loadCorpusDir(dir: string): Promise<MazeCorpus> {
  const names = new Set(
    (await readdir(dir)).filter((name) => PAGE_NAME_RE.test(name)),
  );
  if (names.size === 0)
    throw new Error(
      `no maze pages in ${dir} - generate them: tollbooth corpus --out ${dir}`,
    );
  return {
    pageCount: names.size,
    // The name-set membership check doubles as the traversal guard: only
    // page-NNNN.html names that actually exist ever reach the filesystem.
    get: async (name) =>
      names.has(name) ? readFile(join(dir, name), "utf8") : undefined,
  };
}
