import { describe, expect, it } from "vitest";
import {
  fromBase64Url,
  generateSecretKey,
  publicKeyOf,
  sign,
  toBase64Url,
  verify,
} from "../src/keys.js";

describe("ed25519 helpers", () => {
  it("signs and verifies; rejects tampered input", async () => {
    const secret = generateSecretKey();
    const pub = await publicKeyOf(secret);
    expect(secret).toHaveLength(32);
    expect(pub).toHaveLength(32);

    const sig = await sign("hello", secret);
    expect(sig).toHaveLength(64);
    expect(await verify(sig, "hello", pub)).toBe(true);
    expect(await verify(sig, "hellp", pub)).toBe(false);

    const tampered = Uint8Array.from(sig);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(await verify(tampered, "hello", pub)).toBe(false);
  });

  it("derives a stable public key from the same seed", async () => {
    const secret = generateSecretKey();
    expect(await publicKeyOf(secret)).toEqual(await publicKeyOf(secret));
  });

  it("verify returns false on malformed signatures instead of throwing", async () => {
    const pub = await publicKeyOf(generateSecretKey());
    expect(await verify(new Uint8Array(3), "x", pub)).toBe(false);
  });
});

describe("base64url", () => {
  it("round-trips bytes and emits no padding or +/ characters", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });
});
