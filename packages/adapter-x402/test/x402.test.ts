import { readFileSync } from "node:fs";
import { parseConfig } from "@tollbooth/core";
import { describe, expect, it } from "vitest";
import { buildOffer, usdToAtomic, verifyProof } from "../src/index.js";
import {
  makeAuth,
  NOW,
  PAY_TO,
  PAYER,
  payment,
  signAuth,
} from "./fixtures/payment.js";

const CFG = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "${PAY_TO}"
`);

describe("AC-2.1 - buildOffer emits payment-required headers from config", () => {
  it("names price (atomic), pay-to, network and asset", () => {
    const { headers, requirement } = buildOffer(CFG, "/article");
    const parsed = JSON.parse(headers["x-payment-required"] ?? "");
    expect(parsed).toEqual(requirement);
    expect(requirement.network).toBe("base-sepolia");
    expect(requirement.payTo).toBe(PAY_TO);
    expect(requirement.maxAmountRequired).toBe("1000"); // 0.001 USD in 6-decimal USDC
    expect(requirement.resource).toBe("/article");
    expect(requirement.asset).toMatch(/^0x/);
  });

  it("throws on an unknown network, naming the supported set", () => {
    const cfg = parseConfig(
      `mode = "toll"\n[toll.x402]\npay_to = "${PAY_TO}"\nnetwork = "mars"`,
    );
    expect(() => buildOffer(cfg, "/x")).toThrow(
      /unsupported x402 network "mars".*base-sepolia/,
    );
  });
});

describe("usdToAtomic", () => {
  it("converts decimal-string dollars to 6-decimal USDC atomics without floats", () => {
    expect(usdToAtomic("0.001")).toBe(1000n);
    expect(usdToAtomic("1")).toBe(1_000_000n);
    expect(usdToAtomic("12.5")).toBe(12_500_000n);
    expect(usdToAtomic("0.0000001")).toBe(0n); // truncates below asset precision
  });
});

describe("AC-2.2 - verifyProof verifies locally", () => {
  it("accepts a validly signed authorization and names the payer", () => {
    const auth = makeAuth();
    const result = verifyProof(payment(auth, signAuth(auth)), CFG, {
      nowS: NOW,
    });
    expect(result).toEqual({ ok: true, payer: PAYER });
  });

  it("rejects a tampered value: signature no longer matches", () => {
    const auth = makeAuth();
    const sig = signAuth(auth);
    const tampered = { ...auth, value: "1000000" };
    const result = verifyProof(payment(tampered, sig), CFG, { nowS: NOW });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signer-mismatch");
  });

  it("rejects payment to the wrong recipient", () => {
    const auth = makeAuth({ to: "0x2222222222222222222222222222222222222222" });
    const result = verifyProof(payment(auth, signAuth(auth)), CFG, {
      nowS: NOW,
    });
    expect(result.reason).toBe("wrong-recipient");
  });

  it("rejects insufficient value", () => {
    const auth = makeAuth({ value: "500" });
    const result = verifyProof(payment(auth, signAuth(auth)), CFG, {
      nowS: NOW,
    });
    expect(result.reason).toBe("insufficient-value");
  });

  it("rejects expired and not-yet-valid windows", () => {
    const expired = makeAuth({ validBefore: String(NOW - 10) });
    expect(
      verifyProof(payment(expired, signAuth(expired)), CFG, { nowS: NOW })
        .reason,
    ).toBe("expired");
    const early = makeAuth({ validAfter: String(NOW + 100) });
    expect(
      verifyProof(payment(early, signAuth(early)), CFG, { nowS: NOW }).reason,
    ).toBe("not-yet-valid");
  });

  it("rejects a network mismatch against config", () => {
    const auth = makeAuth();
    const result = verifyProof(payment(auth, signAuth(auth), "base"), CFG, {
      nowS: NOW,
    });
    expect(result.reason).toBe("network-mismatch");
  });

  it("rejects garbage headers as malformed, never throws", () => {
    expect(verifyProof("!!!not-base64!!!", CFG, { nowS: NOW }).reason).toBe(
      "malformed",
    );
    expect(verifyProof(btoa("{}"), CFG, { nowS: NOW }).reason).toBe(
      "malformed",
    );
  });
});

describe("AC-2.3 - chain code stays inside the adapter", () => {
  it("core's runtime dependencies contain no chain libraries", () => {
    const corePkg = JSON.parse(
      readFileSync(new URL("../../core/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(corePkg.dependencies).sort()).toEqual([
      "@noble/ed25519",
      "smol-toml",
      "zod",
    ]);
  });
});
