import { describe, expect, it } from "vitest";
import { generateSecretKey, publicKeyOf, toBase64Url } from "../src/keys.js";
import { decodeVoucher, mintVoucher, spendVoucher } from "../src/voucher.js";

const NOW = 1_800_000_000;

async function site() {
  const secret = generateSecretKey();
  return { secret, pub: await publicKeyOf(secret) };
}

const AGENT_KEY = "agent-pubkey-b64url";
const OTHER_KEY = "other-pubkey-b64url";

const spendOpts = (
  over: Partial<{ nowS: number; allowBearer: boolean }> = {},
) => ({
  nowS: NOW,
  allowBearer: false,
  ...over,
});

describe("voucher mint and decode", () => {
  it("mints a key-bound voucher with the D-1 payload shape", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 5000, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = decodeVoucher(encoded);
    expect(payload).toMatchObject({
      v: 1,
      agent_key: AGENT_KEY,
      credits: 5000,
      expires: NOW + 3600,
      iat: NOW,
    });
    expect(payload.jti).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 random bytes
  });

  it("rejects garbage on decode", () => {
    expect(() => decodeVoucher("not-a-voucher")).toThrow();
    expect(() =>
      decodeVoucher(`${toBase64Url(new TextEncoder().encode("{}"))}.AAAA`),
    ).toThrow();
  });
});

describe("US-3 AC-3.2 - spending a valid voucher", () => {
  it("spends, decrements, and re-signs with a FRESH jti and unchanged expiry", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    const before = decodeVoucher(encoded);

    const result = await spendVoucher(encoded, s, AGENT_KEY, spendOpts());
    if (result.state !== "spent")
      throw new Error(`expected spent, got ${result.state}`);
    const after = decodeVoucher(result.next);
    expect(after.credits).toBe(2);
    expect(after.agent_key).toBe(AGENT_KEY);
    expect(after.expires).toBe(before.expires); // a re-sign never extends life
    expect(after.jti).not.toBe(before.jti); // fresh jti per re-sign (D-1)
  });
});

describe("US-3 AC-3.4 - key binding", () => {
  it("a different verified agent key is a mismatch", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    expect((await spendVoucher(encoded, s, OTHER_KEY, spendOpts())).state).toBe(
      "mismatch",
    );
  });

  it("an anonymous spender of a key-bound voucher is a mismatch", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    expect((await spendVoucher(encoded, s, null, spendOpts())).state).toBe(
      "mismatch",
    );
  });
});

describe("bearer mode (D-1, flag-gated)", () => {
  it("a bearer voucher spends for anyone when the flag allows", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: null, credits: 2, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    const result = await spendVoucher(
      encoded,
      s,
      null,
      spendOpts({ allowBearer: true }),
    );
    expect(result.state).toBe("spent");
  });

  it("a bearer voucher is refused when the flag is off", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: null, credits: 2, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    expect((await spendVoucher(encoded, s, null, spendOpts())).state).toBe(
      "bearer-disabled",
    );
  });
});

describe("refusals", () => {
  it("expired vouchers", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 3, expiresS: NOW - 10, nowS: NOW - 3600 },
      s.secret,
    );
    expect((await spendVoucher(encoded, s, AGENT_KEY, spendOpts())).state).toBe(
      "expired",
    );
  });

  it("exhausted vouchers (credits 0)", async () => {
    const s = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 0, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    expect((await spendVoucher(encoded, s, AGENT_KEY, spendOpts())).state).toBe(
      "exhausted",
    );
  });

  it("tampered payloads and foreign site keys fail the signature", async () => {
    const s = await site();
    const other = await site();
    const encoded = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    // credits bumped without the site key: re-encode the payload half
    const payload = decodeVoucher(encoded);
    const forged = `${toBase64Url(
      new TextEncoder().encode(JSON.stringify({ ...payload, credits: 999999 })),
    )}.${encoded.split(".")[1]}`;
    expect((await spendVoucher(forged, s, AGENT_KEY, spendOpts())).state).toBe(
      "bad-signature",
    );
    // signed by a different site
    expect(
      (await spendVoucher(encoded, other, AGENT_KEY, spendOpts())).state,
    ).toBe("bad-signature");
    // structural garbage
    expect(
      (await spendVoucher("garbage", s, AGENT_KEY, spendOpts())).state,
    ).toBe("malformed");
  });
});

describe("property: a resign chain", () => {
  it("credits strictly decrease to exhaustion and every jti is unique", async () => {
    const s = await site();
    let current = await mintVoucher(
      { agentKey: AGENT_KEY, credits: 5, expiresS: NOW + 3600, nowS: NOW },
      s.secret,
    );
    const jtis = new Set([decodeVoucher(current).jti]);
    let credits = 5;

    for (let i = 0; i < 5; i++) {
      const result = await spendVoucher(current, s, AGENT_KEY, spendOpts());
      if (result.state !== "spent")
        throw new Error(`spend ${i}: ${result.state}`);
      const payload = decodeVoucher(result.next);
      expect(payload.credits).toBe(credits - 1); // never increases, never skips
      credits = payload.credits;
      jtis.add(payload.jti);
      current = result.next;
    }
    expect(credits).toBe(0);
    expect(jtis.size).toBe(6); // mint + 5 re-signs, all distinct
    expect((await spendVoucher(current, s, AGENT_KEY, spendOpts())).state).toBe(
      "exhausted",
    );
  });
});
