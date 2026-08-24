import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateSiteKey } from "../src/node.js";

describe("US-1 AC-1.2 - site key generated on first start", () => {
  it("creates the key file with mode 0600 and loads it back stable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-"));
    const path = join(dir, "tollbooth.key");

    const first = await loadOrCreateSiteKey(path);
    // `created` is true exactly once — the caller prints the public key on
    // that flag, which is what makes "printed once" testable.
    expect(first.created).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const second = await loadOrCreateSiteKey(path);
    expect(second.created).toBe(false);
    expect(second.secretKey).toEqual(first.secretKey);
    expect(second.publicKey).toEqual(first.publicKey);
  });

  it("throws on a malformed key file and leaves it untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-"));
    const path = join(dir, "tollbooth.key");
    await writeFile(path, "not a key\n");
    await expect(loadOrCreateSiteKey(path)).rejects.toThrow(/site key/);
    expect(await readFile(path, "utf8")).toBe("not a key\n");
  });
});
