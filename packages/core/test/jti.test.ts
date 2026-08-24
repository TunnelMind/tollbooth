import { describe, expect, it } from "vitest";
import { JtiCache } from "../src/jti.js";
import { generateSecretKey, publicKeyOf } from "../src/keys.js";
import { decodeVoucher, mintVoucher, spendVoucher } from "../src/voucher.js";

describe("US-3 AC-3.3 - jti replay damping", () => {
  it("allows up to replay_window spends of one jti, refuses beyond", () => {
    const cache = new JtiCache(100);
    expect(cache.allow("j1", 2)).toBe(true);
    expect(cache.allow("j1", 2)).toBe(true);
    expect(cache.allow("j1", 2)).toBe(false);
    expect(cache.allow("j1", 2)).toBe(false);
  });

  it("tracks jtis independently", () => {
    const cache = new JtiCache(100);
    expect(cache.allow("a", 1)).toBe(true);
    expect(cache.allow("b", 1)).toBe(true);
    expect(cache.allow("a", 1)).toBe(false);
    expect(cache.allow("b", 1)).toBe(false);
  });

  it("evicts least-recently-seen at capacity - amnesty resets the count", () => {
    const cache = new JtiCache(2);
    cache.allow("a", 1);
    cache.allow("b", 1); // {a, b}
    cache.allow("c", 1); // evicts a -> {b, c}
    expect(cache.allow("a", 1)).toBe(true); // a's history is gone (amnesty); evicts b -> {c, a}
    expect(cache.allow("c", 1)).toBe(false); // c survived with its count intact
    expect(cache.size).toBe(2);
  });
});

describe("AC-3.3 against real vouchers (Article V.14 soft damping)", () => {
  const NOW = 1_800_000_000;

  it("parallel replay of ONE signed state is damped; a sequential chain never is", async () => {
    const secret = generateSecretKey();
    const site = { secret, pub: await publicKeyOf(secret) };
    const cache = new JtiCache(100);
    const REPLAY_WINDOW = 2;
    const spendOnce = async (encoded: string) => {
      const payload = decodeVoucher(encoded);
      if (!cache.allow(payload.jti, REPLAY_WINDOW))
        return { state: "replay-damped" as const };
      return spendVoucher(encoded, site, "agent-key", {
        nowS: NOW,
        allowBearer: false,
      });
    };

    const voucher = await mintVoucher(
      { agentKey: "agent-key", credits: 100, expiresS: NOW + 3600, nowS: NOW },
      secret,
    );

    // Parallel replay: the SAME encoded voucher, over and over.
    expect((await spendOnce(voucher)).state).toBe("spent");
    expect((await spendOnce(voucher)).state).toBe("spent");
    expect((await spendOnce(voucher)).state).toBe("replay-damped");

    // Sequential spending: always the successor, fresh jti each time -
    // ten steps deep with a window of 2, never damped (the PR #1 fix).
    let current = await mintVoucher(
      { agentKey: "agent-key", credits: 100, expiresS: NOW + 3600, nowS: NOW },
      secret,
    );
    for (let i = 0; i < 10; i++) {
      const result = await spendOnce(current);
      if (result.state !== "spent")
        throw new Error(`step ${i}: ${result.state}`);
      current = result.next;
    }
  });
});
