import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonicalize.js";
import {
  generateSecretKey,
  publicKeyOf,
  sign,
  toBase64Url,
} from "../src/keys.js";
import type { Decision } from "../src/pipeline.js";
import {
  buildReceipt,
  type Receipt,
  receiptFactsFor,
  verifyReceipt,
} from "../src/receipt.js";
import type { SiteKeyPair } from "../src/voucher.js";

const NOW = 1_800_000_000;

async function makeSite(): Promise<SiteKeyPair> {
  const secret = generateSecretKey();
  return { secret, pub: await publicKeyOf(secret) };
}

const WINDOW = { count: 17, windowStartS: NOW - 600, windowEndS: NOW };

describe("US-6 AC-6.2 - receipt schema and signature", () => {
  it("builds a TOLL_IGNORED receipt with exactly the schema fields", async () => {
    const site = await makeSite();
    const receipt = await buildReceipt(
      {
        type: "TOLL_IGNORED",
        agentKey: "agent-pub",
        ua: "TestBot/1.0",
        path: "/articles/how-to/42",
        ...WINDOW,
      },
      site,
    );
    expect(Object.keys(receipt).sort()).toEqual([
      "agent_key",
      "claimed_key",
      "count",
      "path_class",
      "sig",
      "site",
      "type",
      "ua",
      "v",
      "window_end",
      "window_start",
    ]);
    expect(receipt).toMatchObject({
      v: 1,
      type: "TOLL_IGNORED",
      site: toBase64Url(site.pub),
      agent_key: "agent-pub",
      claimed_key: null,
      path_class: "/articles", // first segment ONLY (III.9)
      count: 17,
    });
    expect(receipt.window_start).toBe(
      new Date((NOW - 600) * 1000).toISOString(),
    );
    expect(receipt.sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("path_class keeps only the first segment", async () => {
    const site = await makeSite();
    const at = async (path: string) =>
      (
        await buildReceipt(
          { type: "PASS_PAID", agentKey: "k", ua: "u", path, ...WINDOW },
          site,
        )
      ).path_class;
    expect(await at("/")).toBe("/");
    expect(await at("/pricing")).toBe("/pricing");
    expect(await at("/a/b/c?q=1")).toBe("/a");
  });

  it("verifies offline against the site public key; tampering fails", async () => {
    const site = await makeSite();
    const other = await makeSite();
    const receipt = await buildReceipt(
      { type: "PASS_PAID", agentKey: "k", ua: "u", path: "/a", ...WINDOW },
      site,
    );
    expect(await verifyReceipt(receipt, site.pub)).toEqual({ ok: true });
    expect(
      (await verifyReceipt({ ...receipt, count: 999 }, site.pub)).reason,
    ).toBe("signature");
    expect((await verifyReceipt(receipt, other.pub)).reason).toBe(
      "site-mismatch",
    );
    expect((await verifyReceipt({ nope: true }, site.pub)).ok).toBe(false);
  });
});

describe("Constitution III.9 - SPOOF key semantics", () => {
  it("SPOOF receipts carry claimed_key, never agent_key", async () => {
    const site = await makeSite();
    const receipt = await buildReceipt(
      {
        type: "SPOOF",
        claimedKey: "claimed-pub",
        ua: "u",
        path: "/a",
        ...WINDOW,
      },
      site,
    );
    expect(receipt.agent_key).toBeNull();
    expect(receipt.claimed_key).toBe("claimed-pub");
  });

  it("the builder refuses a SPOOF with agent_key, and claimed_key outside SPOOF", async () => {
    const site = await makeSite();
    await expect(
      buildReceipt(
        { type: "SPOOF", agentKey: "x", ua: "u", path: "/a", ...WINDOW },
        site,
      ),
    ).rejects.toThrow(/III\.9/);
    await expect(
      buildReceipt(
        { type: "PASS_PAID", claimedKey: "x", ua: "u", path: "/a", ...WINDOW },
        site,
      ),
    ).rejects.toThrow(/SPOOF/);
  });

  it("the verifier rejects a signed-but-unconstitutional SPOOF receipt", async () => {
    const site = await makeSite();
    const good = await buildReceipt(
      { type: "SPOOF", claimedKey: "c", ua: "u", path: "/a", ...WINDOW },
      site,
    );
    // forge a constitution-violating variant and re-sign it correctly
    const { sig: _drop, ...unsigned } = { ...good, agent_key: "smuggled" };
    const forged: Receipt = {
      ...unsigned,
      sig: toBase64Url(await sign(canonicalize(unsigned), site.secret)),
    } as Receipt;
    const result = await verifyReceipt(forged, site.pub);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("SPOOF");
  });
});

describe("sentinel - nothing beyond metadata ever enters a receipt", () => {
  it("a marker in the body, deep path, or query appears in NO receipt type", async () => {
    const site = await makeSite();
    const SENTINEL = "SENTINEL_bf1e2d3c4a5b";
    // A request whose every non-metadata surface carries the marker. The
    // pipeline request type has no body field at all - this simulates one
    // arriving anyway.
    const req = {
      userAgent: "TestBot/1.0",
      path: `/articles/${SENTINEL}?q=${SENTINEL}`,
      body: SENTINEL,
    } as { userAgent: string; path: string };

    const factsList = [
      { type: "TOLL_IGNORED" as const, agentKey: "k" },
      { type: "SPOOF" as const, claimedKey: "c" },
      { type: "PASS_PAID" as const, agentKey: "k" },
      { type: "VOUCHER_MISMATCH" as const, agentKey: "k" },
    ];
    for (const base of factsList) {
      const receipt = await buildReceipt(
        { ...base, ua: req.userAgent, path: req.path, ...WINDOW },
        site,
      );
      expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
    }
  });
});

describe("receiptFactsFor - decisions map to receipt facts", () => {
  const agentIdentity = { kind: "agent" as const, agentKey: "k" };
  const req = { userAgent: "u", path: "/a/b" };
  const window = { count: 3, windowStartS: NOW - 60, windowEndS: NOW };

  it("maps consequence, reject and paid passes; everything else is null", () => {
    const cases: Array<[Decision, string | null]> = [
      [
        {
          action: "consequence",
          reason: "toll-ignored",
          identity: agentIdentity,
        },
        "TOLL_IGNORED",
      ],
      [
        {
          action: "consequence",
          reason: "spoof",
          identity: { kind: "spoofer", claimedKey: "c", claimedKeyId: "id" },
        },
        "SPOOF",
      ],
      [
        {
          action: "reject",
          status: 403,
          reason: "mismatch",
          identity: agentIdentity,
        },
        "VOUCHER_MISMATCH",
      ],
      [
        { action: "pass", reason: "paid", identity: agentIdentity },
        "PASS_PAID",
      ],
      [
        { action: "pass", reason: "voucher", identity: agentIdentity },
        "PASS_PAID",
      ],
      [{ action: "pass", reason: "human", identity: { kind: "human" } }, null],
      [{ action: "pass", reason: "free-path", identity: null }, null],
      [
        {
          action: "offer",
          identity: agentIdentity,
          body: { v: 1, price_usd: "0.001", options: [] },
        },
        null,
      ],
    ];
    for (const [decision, expected] of cases) {
      const facts = receiptFactsFor(decision, req, window);
      expect(facts?.type ?? null).toBe(expected);
    }
  });

  it("SPOOF facts carry the claimed key from the identity", () => {
    const facts = receiptFactsFor(
      {
        action: "consequence",
        reason: "spoof",
        identity: { kind: "spoofer", claimedKey: "c", claimedKeyId: "id" },
      },
      req,
      window,
    );
    expect(facts).toMatchObject({ type: "SPOOF", claimedKey: "c" });
    expect(facts?.agentKey ?? null).toBeNull();
  });
});
