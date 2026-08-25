import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildReceipt,
  decodeVoucher,
  generateSecretKey,
  publicKeyOf,
  spendVoucher,
  toBase64Url,
} from "@tollbooth/core";
import { loadOrCreateSiteKey } from "@tollbooth/core/node";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const KILLNET = pathToFileURL(
  new URL("./fixtures/killnet.mjs", import.meta.url).pathname,
).href;
const NOW = 1_800_000_000;

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node", [
      "--import",
      KILLNET,
      CLI,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

async function makeSite() {
  const secret = generateSecretKey();
  return { secret, pub: await publicKeyOf(secret) };
}

describe("US-6 AC-6.1 - tollbooth verify, with networking disabled", () => {
  it("PASSes a genuine receipt and prints the three checks", async () => {
    const site = await makeSite();
    const receipt = await buildReceipt(
      {
        type: "TOLL_IGNORED",
        agentKey: "k",
        ua: "TestBot/1.0",
        path: "/articles/x",
        count: 4,
        windowStartS: NOW - 600,
        windowEndS: NOW,
      },
      site,
    );
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-verify-"));
    const file = join(dir, "receipt.json");
    await writeFile(file, JSON.stringify(receipt, null, 2));

    const result = await cli([
      "verify",
      file,
      "--pubkey",
      toBase64Url(site.pub),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("schema: PASS");
    expect(result.stdout).toContain("canonical form: PASS");
    expect(result.stdout).toContain("signature: PASS");
    expect(result.stdout.trim().endsWith("PASS")).toBe(true);
  });

  it("FAILs a tampered receipt on the signature check", async () => {
    const site = await makeSite();
    const receipt = await buildReceipt(
      {
        type: "PASS_PAID",
        agentKey: "k",
        ua: "u",
        path: "/a",
        count: 1,
        windowStartS: NOW,
        windowEndS: NOW,
      },
      site,
    );
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-verify-"));
    const file = join(dir, "receipt.json");
    await writeFile(file, JSON.stringify({ ...receipt, count: 999 }));

    const result = await cli([
      "verify",
      file,
      "--pubkey",
      toBase64Url(site.pub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("schema: PASS");
    expect(result.stdout).toContain("signature: FAIL");
    expect(result.stdout.trim().endsWith("FAIL")).toBe(true);
  });

  it("FAILs garbage on the schema check", async () => {
    const site = await makeSite();
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-verify-"));
    const file = join(dir, "receipt.json");
    await writeFile(file, JSON.stringify({ hello: "world" }));
    const result = await cli([
      "verify",
      file,
      "--pubkey",
      toBase64Url(site.pub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("schema: FAIL");
  });
});

describe("FR-9 - voucher inspect and mint", () => {
  it("mints against a key file and inspect round-trips the payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-mint-"));
    const keyPath = join(dir, "site.key");

    const minted = await cli([
      "voucher",
      "mint",
      "--key",
      keyPath,
      "--agent",
      "agent-pub-b64url",
      "--credits",
      "42",
      "--ttl-days",
      "7",
    ]);
    expect(minted.code).toBe(0);
    const voucher = minted.stdout.trim();
    expect(voucher).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const inspected = await cli(["voucher", "inspect", voucher]);
    expect(inspected.code).toBe(0);
    const payload = JSON.parse(inspected.stdout) as {
      agent_key: string;
      credits: number;
    };
    expect(payload).toMatchObject({
      agent_key: "agent-pub-b64url",
      credits: 42,
    });

    // the minted voucher actually spends against the key file's site key
    const site = await loadOrCreateSiteKey(keyPath);
    const spent = await spendVoucher(
      voucher,
      { secret: site.secretKey, pub: site.publicKey },
      "agent-pub-b64url",
      { nowS: Math.floor(Date.now() / 1000), allowBearer: false },
    );
    expect(spent.state).toBe("spent");
    if (spent.state === "spent")
      expect(decodeVoucher(spent.next).credits).toBe(41);
  });

  it("refuses to mint without --agent or --bearer", async () => {
    const result = await cli(["voucher", "mint", "--key", "/tmp/nope.key"]);
    expect(result.code).toBe(64);
  });
});
