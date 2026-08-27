import { readFileSync } from "node:fs";
import { parseConfig } from "@tollbooth/core";
import { describe, expect, it } from "vitest";
import { buildOffer, NETWORKS } from "../src/index.js";

describe("ADR 003 - base mainnet available, never default (V.15)", () => {
  it("knows Circle USDC on Base mainnet with the real EIP-712 domain", () => {
    expect(NETWORKS.base).toEqual({
      chainId: 8453n,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetName: "USD Coin",
      assetVersion: "2",
    });
  });

  it("the config default network is still testnet", () => {
    expect(parseConfig("").toll.x402.network).toBe("base-sepolia");
  });

  it("an operator can opt into mainnet by naming it", () => {
    const cfg = parseConfig(`
mode = "toll"
[toll.x402]
network = "base"
pay_to = "0x38CCAf48a4631ee706E41cdB8A4762Cfb5c8b719"
`);
    const { requirement } = buildOffer(cfg, "/article");
    expect(requirement.network).toBe("base");
    expect(requirement.asset).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(requirement.extra).toEqual({ name: "USD Coin", version: "2" });
  });

  it("every committed example still uses testnet (V.15 doc rule)", () => {
    for (const rel of [
      "examples/node/index.ts",
      "examples/bun-hono/index.ts",
      "examples/cloudflare-worker/worker.ts",
    ]) {
      const src = readFileSync(
        new URL(`../../../${rel}`, import.meta.url),
        "utf8",
      );
      expect(src).toContain("base-sepolia");
      expect(src).not.toMatch(/network\s*=\s*"base"/);
    }
  });
});
