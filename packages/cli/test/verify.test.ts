import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
} from "@tunnelmindai/tollbooth-core";
import { loadOrCreateSiteKey } from "@tunnelmindai/tollbooth-core/node";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const KILLNET = pathToFileURL(
  new URL("./fixtures/killnet.mjs", import.meta.url).pathname,
).href;
const FAKESITE = pathToFileURL(
  new URL("./fixtures/fakesite.mjs", import.meta.url).pathname,
).href;
const NOW = 1_800_000_000;

async function cli(
  args: string[],
  opts: { preload?: string; siteJson?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      "node",
      ["--import", opts.preload ?? KILLNET, CLI, ...args],
      { env: { ...process.env, TB_SITE_JSON: opts.siteJson ?? "" } },
    );
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

  // A receipt file can carry "\udc00" in any string: JSON.parse keeps the lone
  // surrogate, canonicalize refuses it, and the report names that step.
  it("FAILs a lone surrogate on the canonical-form check", async () => {
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
    await writeFile(
      file,
      JSON.stringify(receipt).replace('"ua":"u"', '"ua":"\\udc00"'),
    );
    const result = await cli([
      "verify",
      file,
      "--pubkey",
      toBase64Url(site.pub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("schema: PASS");
    expect(result.stdout).toMatch(
      /canonical form: FAIL \(canonical form: JCS: lone surrogate/,
    );
    expect(result.stdout).toContain("signature: SKIPPED");
  });

  // Broken twice, in canonical form and in the signature's spelling: the
  // report must name canonical form, the earlier step, not print it as PASS.
  it("names canonical form first when the signature is also mis-spelled", async () => {
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
    await writeFile(
      file,
      JSON.stringify({ ...receipt, sig: `${receipt.sig}==` }).replace(
        '"ua":"u"',
        '"ua":"\\udc00"',
      ),
    );
    const result = await cli([
      "verify",
      file,
      "--pubkey",
      toBase64Url(site.pub),
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("schema: PASS");
    expect(result.stdout).toMatch(
      /canonical form: FAIL \(canonical form: JCS: lone surrogate/,
    );
    expect(result.stdout).toContain("signature: SKIPPED");
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

// Golden output: pins today's full `verify` stdout and exit code byte for
// byte, so a refactor of cli.ts cannot change the report without failing
// here. A fixed secret key plus fixed facts make every receipt identical on
// every run (Ed25519 signing is deterministic). Expected strings are inline,
// copied from the CLI's output before any refactor; no snapshot files.
describe("AC-6.1 golden output - exact verify stdout and exit code", () => {
  const PAID = {
    type: "PASS_PAID" as const,
    agentKey: "k",
    ua: "u",
    path: "/a",
    count: 1,
    windowStartS: NOW,
    windowEndS: NOW,
  };

  async function fixedSite() {
    const secret = new Uint8Array(32).fill(7);
    return { secret, pub: await publicKeyOf(secret) };
  }

  async function verifyBody(body: string, pub: Uint8Array) {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-verify-"));
    const file = join(dir, "receipt.json");
    await writeFile(file, body);
    return cli(["verify", file, "--pubkey", toBase64Url(pub)]);
  }

  it("genuine receipt", async () => {
    const site = await fixedSite();
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
    const result = await verifyBody(JSON.stringify(receipt, null, 2), site.pub);
    expect(result.stdout).toBe(
      "schema: PASS\n" +
        "canonical form: PASS\n" +
        "signature: PASS\n" +
        "key not bound to a domain\n" +
        "PASS\n",
    );
    expect(result.code).toBe(0);
  });

  it("lone surrogate", async () => {
    const site = await fixedSite();
    const receipt = await buildReceipt(PAID, site);
    const result = await verifyBody(
      JSON.stringify(receipt).replace('"ua":"u"', '"ua":"\\udc00"'),
      site.pub,
    );
    expect(result.stdout).toBe(
      "schema: PASS\n" +
        "canonical form: FAIL (canonical form: JCS: lone surrogate in string)\n" +
        "signature: SKIPPED\n" +
        "key not bound to a domain\n" +
        "FAIL\n",
    );
    expect(result.code).toBe(1);
  });

  it("lone surrogate and mis-spelled signature", async () => {
    const site = await fixedSite();
    const receipt = await buildReceipt(PAID, site);
    const result = await verifyBody(
      JSON.stringify({ ...receipt, sig: `${receipt.sig}==` }).replace(
        '"ua":"u"',
        '"ua":"\\udc00"',
      ),
      site.pub,
    );
    expect(result.stdout).toBe(
      "schema: PASS\n" +
        "canonical form: FAIL (canonical form: JCS: lone surrogate in string)\n" +
        "signature: SKIPPED\n" +
        "key not bound to a domain\n" +
        "FAIL\n",
    );
    expect(result.code).toBe(1);
  });

  it("tampered count", async () => {
    const site = await fixedSite();
    const receipt = await buildReceipt(PAID, site);
    const result = await verifyBody(
      JSON.stringify({ ...receipt, count: 999 }),
      site.pub,
    );
    expect(result.stdout).toBe(
      "schema: PASS\n" +
        "canonical form: PASS\n" +
        "signature: FAIL\n" +
        "key not bound to a domain\n" +
        "FAIL\n",
    );
    expect(result.code).toBe(1);
  });

  it("garbage", async () => {
    const site = await fixedSite();
    const result = await verifyBody(
      JSON.stringify({ hello: "world" }),
      site.pub,
    );
    expect(result.stdout).toBe(
      "schema: FAIL (schema: v must be 1)\n" +
        "canonical form: SKIPPED\n" +
        "signature: SKIPPED\n" +
        "key not bound to a domain\n" +
        "FAIL\n",
    );
    expect(result.code).toBe(1);
  });
});

/** A genuine receipt on disk plus its site key, for the key-source tests. */
async function receiptFile() {
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
  await writeFile(file, JSON.stringify(receipt));
  const pin = join(dir, "key.txt");
  await writeFile(pin, `${toBase64Url(site.pub)}\n`);
  return { file, pin, pub: toBase64Url(site.pub) };
}

describe("verify key sources: --pin offline, --domain as explicit network opt-in", () => {
  it("--pin verifies offline and says the key is not domain-bound", async () => {
    const { file, pin } = await receiptFile();
    // fakesite logs every fetch to stderr: none may happen without --domain
    const result = await cli(["verify", file, "--pin", pin], {
      preload: FAKESITE,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("signature: PASS");
    expect(result.stdout).toContain("key not bound to a domain");
    expect(result.stdout.trim().endsWith("PASS")).toBe(true);
    expect(result.stderr).not.toContain("fetch:");
  });

  it("--pubkey also prints the unbound-key line, exit code unchanged", async () => {
    const { file, pub } = await receiptFile();
    const result = await cli(["verify", file, "--pubkey", pub]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("key not bound to a domain");
  });

  it("--domain PASSes when tollbooth-site.json lists the receipt's key", async () => {
    const { file, pub } = await receiptFile();
    const result = await cli(["verify", file, "--domain", "example.com"], {
      preload: FAKESITE,
      siteJson: JSON.stringify({ v: 1, keys: ["other", pub] }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "fetch: https://example.com/.well-known/tollbooth-site.json redirect=error",
    );
    expect(result.stdout).toContain("signature: PASS");
    expect(result.stdout).toContain("domain: PASS");
    expect(result.stdout).not.toContain("key not bound");
    expect(result.stdout.trim().endsWith("PASS")).toBe(true);
  });

  it("--domain FAILs (exit 1) when the key is not listed", async () => {
    const { file } = await receiptFile();
    const result = await cli(["verify", file, "--domain", "example.com"], {
      preload: FAKESITE,
      siteJson: JSON.stringify({ v: 1, keys: ["someone-else"] }),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("signature: PASS");
    expect(result.stdout).toContain("domain: FAIL");
    expect(result.stdout.trim().endsWith("FAIL")).toBe(true);
  });

  it("--domain FAILs on a malformed site file and refuses a host with a path", async () => {
    const { file, pin } = await receiptFile();
    const bad = await cli(["verify", file, "--pin", pin, "--domain", "a.com"], {
      preload: FAKESITE,
      siteJson: '{"keys": 1}',
    });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("domain: FAIL");
    const steered = await cli(["verify", file, "--domain", "evil.com/x?"], {
      preload: FAKESITE,
    });
    expect(steered.code).toBe(1);
    expect(steered.stdout).toContain("domain: FAIL (bad host)");
    expect(steered.stderr).not.toContain("fetch:");
  });

  it("--domain under killnet fails closed, not open", async () => {
    const { file } = await receiptFile();
    const result = await cli(["verify", file, "--domain", "example.com"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("domain: FAIL");
  });

  it("needs some key source", async () => {
    const { file } = await receiptFile();
    expect((await cli(["verify", file])).code).toBe(64);
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

// FR-002/003/006: one document per file, from the real Conduct Log Commons
// export fixtures (test/fixtures/commons, see SOURCE.md). Each line is
// {_commons, receipt|snapshot}; the inner value alone is the bare document.
describe("verify one document: export lines and snapshots, networking disabled", () => {
  const COMMONS = new URL("./fixtures/commons/", import.meta.url);
  const WRAPPED = ", from an export line; the _commons envelope is not signed";

  async function firstLine(name: string) {
    const text = await readFile(new URL(name, COMMONS), "utf8");
    return JSON.parse(text.split("\n")[0] as string) as Record<
      string,
      Record<string, unknown>
    >;
  }

  async function verifyDoc(doc: unknown, pubkey: string) {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-verify-"));
    const file = join(dir, "doc.json");
    await writeFile(file, JSON.stringify(doc));
    return cli(["verify", file, "--pubkey", pubkey]);
  }

  const pass =
    "schema: PASS\ncanonical form: PASS\nsignature: PASS\n" +
    "key not bound to a domain\nPASS\n";

  it("PASSes a wrapped receipt line and names the document", async () => {
    const line = await firstLine("receipts.ndjson");
    const r = await verifyDoc(line, line.receipt?.site as string);
    expect(r.stdout).toBe(`document: receipt${WRAPPED}\n${pass}`);
    expect(r.code).toBe(0);
  });

  it("PASSes a bare receipt with no document line", async () => {
    const { receipt } = await firstLine("receipts.ndjson");
    const r = await verifyDoc(receipt, receipt?.site as string);
    expect(r.stdout).toBe(pass);
    expect(r.code).toBe(0);
  });

  it("PASSes a wrapped snapshot line", async () => {
    const line = await firstLine("reports.ndjson");
    const r = await verifyDoc(line, line.snapshot?.site as string);
    expect(r.stdout).toBe(`document: snapshot${WRAPPED}\n${pass}`);
    expect(r.code).toBe(0);
  });

  it("PASSes a bare snapshot", async () => {
    const { snapshot } = await firstLine("reports.ndjson");
    const r = await verifyDoc(snapshot, snapshot?.site as string);
    expect(r.stdout).toBe(`document: snapshot\n${pass}`);
    expect(r.code).toBe(0);
  });

  it("FAILs a tampered snapshot on the signature", async () => {
    const { snapshot } = await firstLine("reports.ndjson");
    const tampered = { ...snapshot, free_path_hits: 9999 };
    const r = await verifyDoc(tampered, snapshot?.site as string);
    expect(r.stdout).toContain("schema: PASS");
    expect(r.stdout).toContain("signature: FAIL");
    expect(r.code).toBe(1);
  });

  it("FAILs a snapshot without sig on the schema", async () => {
    const { snapshot } = await firstLine("reports.ndjson");
    const { sig: _sig, ...unsigned } = snapshot as Record<string, unknown>;
    const r = await verifyDoc(unsigned, snapshot?.site as string);
    expect(r.stdout).toContain("document: snapshot\n");
    expect(r.stdout).toContain("schema: FAIL (schema: sig must be a string)");
    expect(r.code).toBe(1);
  });

  it("reports site-mismatch for the wrong --pubkey", async () => {
    const line = await firstLine("reports.ndjson");
    const other = toBase64Url((await makeSite()).pub);
    const r = await verifyDoc(line, other);
    expect(r.stdout).toContain("schema: FAIL (site-mismatch)");
    expect(r.code).toBe(1);
  });

  it("FAILs ambiguous export wrappers on the schema", async () => {
    const rline = await firstLine("receipts.ndjson");
    const sline = await firstLine("reports.ndjson");
    const site = rline.receipt?.site as string;
    for (const doc of [
      { ...rline, snapshot: sline.snapshot },
      { _commons: rline._commons },
      { ...rline, extra: 1 },
    ]) {
      const r = await verifyDoc(doc, site);
      expect(r.stdout).toMatch(/^schema: FAIL \(export line: /);
      expect(r.stdout).not.toContain("document:");
      expect(r.code).toBe(1);
    }
  });
});

describe("verify a file of lines (FR-001, FR-007, FR-008)", () => {
  const COMMONS = new URL("./fixtures/commons/", import.meta.url);
  const SITE = "S0f4n53Oth5iEYVWgeV5VaxKJ-lrmj7GXtVLxASee88";

  async function fixtureLines(): Promise<string[]> {
    const lines: string[] = [];
    for (const name of ["receipts.ndjson", "reports.ndjson"]) {
      const text = await readFile(new URL(name, COMMONS), "utf8");
      lines.push(...text.split("\n").filter((l) => l.trim() !== ""));
    }
    return lines;
  }

  async function writeLines(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tollbooth-verify-"));
    const file = join(dir, "lines.ndjson");
    await writeFile(file, text);
    return file;
  }

  it("PASSes every fixture line under --domain with one fetch", async () => {
    const lines = await fixtureLines();
    const keys = lines.map((l) => {
      const doc = JSON.parse(l) as Record<string, { site: string }>;
      return (doc.receipt ?? doc.snapshot)?.site as string;
    });
    const file = await writeLines(`${lines.join("\n")}\n`);
    const r = await cli(["verify", file, "--domain", "example.com"], {
      preload: FAKESITE,
      siteJson: JSON.stringify({ v: 1, keys }),
    });
    expect(r.code).toBe(0);
    expect(r.stderr.match(/^fetch:/gm)).toHaveLength(1);
    const out = r.stdout.trim().split("\n");
    expect(out.slice(-2)).toEqual(["domain: PASS", "PASS"]);
    for (const l of out.slice(0, -2)) expect(l).toMatch(/^line \d+: /);
    for (let n = 1; n <= lines.length; n++)
      expect(r.stdout).toContain(`line ${n}: signature: PASS`);
  });

  it("FAILs one tampered line by number while the others still report", async () => {
    const lines = await fixtureLines();
    const doc = JSON.parse(lines[2] as string) as {
      snapshot: Record<string, unknown>;
    };
    doc.snapshot.free_path_hits = 9999;
    lines[2] = JSON.stringify(doc);
    const file = await writeLines(lines.join("\n"));
    const r = await cli(["verify", file, "--pubkey", SITE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("line 3: signature: FAIL");
    for (const n of [1, 2, 4])
      expect(r.stdout).toContain(`line ${n}: signature: PASS`);
    expect(r.stdout.trim().endsWith("FAIL")).toBe(true);
  });

  it("gives not JSON for trailing data on a line", async () => {
    // The one real receipt line, repeated (T001 note: the export has one).
    const [line] = await fixtureLines();
    const file = await writeLines(`${line}\n${line}${line}\n${line} x\n`);
    const r = await cli(["verify", file, "--pubkey", SITE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("line 1: signature: PASS");
    expect(r.stdout).toContain("line 2: schema: FAIL (not JSON)\n");
    expect(r.stdout).toContain("line 3: schema: FAIL (not JSON)\n");
    expect(r.stdout.trim().endsWith("FAIL")).toBe(true);
  });

  it("FAILs an empty or blank-only file, with no fetch", async () => {
    for (const text of ["", "\n \r\n\t\n"]) {
      const file = await writeLines(text);
      const r = await cli(["verify", file, "--domain", "example.com"], {
        preload: FAKESITE,
        siteJson: JSON.stringify({ v: 1, keys: [SITE] }),
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("schema: FAIL (no documents)\nFAIL\n");
      expect(r.stderr).not.toContain("fetch:");
    }
  });

  it("PASSes CRLF lines and counts blank lines in N", async () => {
    const lines = await fixtureLines();
    const file = await writeLines(`${lines[0]}\r\n\r\n${lines[1]}\r\n`);
    const r = await cli(["verify", file, "--pubkey", SITE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("line 1: signature: PASS");
    expect(r.stdout).toContain("line 3: signature: PASS");
    expect(r.stdout).not.toContain("line 2:");
  });

  it("does not trust _commons.domain: an unlisted key FAILs and is named", async () => {
    const lines = await fixtureLines();
    const doc = JSON.parse(lines[1] as string) as {
      _commons: { domain: string };
    };
    expect(doc._commons.domain).toBe("tunnelmind.ai");
    const file = await writeLines(`${lines[1]}\n${lines[2]}\n`);
    const r = await cli(["verify", file, "--domain", "tunnelmind.ai"], {
      preload: FAKESITE,
      siteJson: JSON.stringify({ v: 1, keys: ["someone-else"] }),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("line 1: signature: PASS");
    expect(r.stdout).toContain(
      `domain: FAIL (key not listed by tunnelmind.ai: ${SITE})\n`,
    );
    expect(r.stderr.match(/^fetch:/gm)).toHaveLength(1);
    expect(r.stdout.trim().endsWith("FAIL")).toBe(true);
  });

  it("keeps a single-document file unprefixed", async () => {
    const [line] = await fixtureLines();
    const file = await writeLines(`${line}\n`);
    const r = await cli(["verify", file, "--pubkey", SITE]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/^line /m);
  });
});
