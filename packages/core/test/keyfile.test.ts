import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SITE_KEY_PATH, loadOrCreateSiteKey } from "../src/node.js";

describe("US-1 AC-1.2 - site key generated on first start", () => {
  it("creates the key file with mode 0600 and loads it back stable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fareseal-"));
    const path = join(dir, "fareseal.key");

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
    const dir = await mkdtemp(join(tmpdir(), "fareseal-"));
    const path = join(dir, "fareseal.key");
    await writeFile(path, "not a key\n");
    await expect(loadOrCreateSiteKey(path)).rejects.toThrow(/site key/);
    expect(await readFile(path, "utf8")).toBe("not a key\n");
  });
});

describe("default key path falls back to the legacy ./tollbooth.key", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });
  const inTmp = async () => {
    process.chdir(await mkdtemp(join(tmpdir(), "fareseal-")));
  };
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );

  it("old file only: loads it, warns once, writes no new file", async () => {
    await inTmp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile("tollbooth.key", "A".repeat(43) + "\n");
    const k = await loadOrCreateSiteKey(DEFAULT_SITE_KEY_PATH);
    expect(k.created).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await exists("fareseal.key")).toBe(false);
  });

  it("both files: the new one wins, no warning", async () => {
    await inTmp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile("tollbooth.key", "A".repeat(43) + "\n");
    await writeFile("fareseal.key", "B".repeat(43) + "\n");
    const k = await loadOrCreateSiteKey(DEFAULT_SITE_KEY_PATH);
    const fresh = await loadOrCreateSiteKey("./fareseal.key");
    const old = await loadOrCreateSiteKey("./tollbooth.key");
    expect(k.secretKey).toEqual(fresh.secretKey);
    expect(k.secretKey).not.toEqual(old.secretKey);
    expect(warn).not.toHaveBeenCalled();
  });

  it("neither: creates ./fareseal.key, no warning", async () => {
    await inTmp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const k = await loadOrCreateSiteKey(DEFAULT_SITE_KEY_PATH);
    expect(k.created).toBe(true);
    expect(await exists("fareseal.key")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("malformed legacy file still throws and is left alone", async () => {
    await inTmp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile("tollbooth.key", "junk\n");
    await expect(loadOrCreateSiteKey(DEFAULT_SITE_KEY_PATH)).rejects.toThrow(
      /site key/,
    );
    expect(await readFile("tollbooth.key", "utf8")).toBe("junk\n");
    expect(await exists("fareseal.key")).toBe(false);
  });

  it("explicit custom path gets no fallback", async () => {
    await inTmp();
    await writeFile("tollbooth.key", "A".repeat(43) + "\n");
    const k = await loadOrCreateSiteKey("./other.key");
    expect(k.created).toBe(true);
  });
});
