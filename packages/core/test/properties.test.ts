// Property tests on seeded random input (PROPERTY_SEED=<n> reproduces a
// failure): what must hold for every receipt and voucher, not just the
// examples in receipt.test.ts and voucher.test.ts.
//   - verify(sign(x)) is true for any receipt the builder accepts;
//   - flipping any single bit of the signature makes it false;
//   - canonicalize -> JSON.parse -> canonicalize is the identity;
//   - a voucher with any one bit of its signature flipped never spends.
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonicalize.js";
import {
  fromBase64Url,
  generateSecretKey,
  publicKeyOf,
  toBase64Url,
} from "../src/keys.js";
import {
  buildReceipt,
  type ReceiptType,
  verifyReceipt,
} from "../src/receipt.js";
import { mintVoucher, spendVoucher } from "../src/voucher.js";

const SEED = Number(process.env.PROPERTY_SEED ?? 20261022);

// mulberry32: small, deterministic, the same on every platform.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces that hit every JCS escape and ordering rule: quotes, backslash, C0
// controls, DEL, combining marks, astral code points, prototype names.
const PIECES = [
  '"',
  "\\",
  "/",
  "\n",
  "\t",
  "\u0000",
  "\u001f",
  "\u007f",
  "é",
  "é",
  "€",
  "😀",
  "𝄞",
  "__proto__",
  "constructor",
  "a",
  "Z",
  "0",
  " ",
];
const TYPES: ReceiptType[] = [
  "TOLL_IGNORED",
  "PASS_PAID",
  "VOUCHER_MISMATCH",
  "SPOOF",
];

function str(r: () => number): string {
  let s = "";
  for (let n = Math.floor(r() * 6); n > 0; n--)
    s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}

function value(r: () => number, depth = 0): unknown {
  const k = r();
  if (depth > 2 || k < 0.3) return str(r);
  if (k < 0.45) return Math.floor(r() * 2 ** 53) * (r() < 0.5 ? -1 : 1);
  if (k < 0.55) return (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20);
  if (k < 0.65) return [null, true, false][Math.floor(r() * 3)];
  if (k < 0.8)
    return Array.from({ length: Math.floor(r() * 4) }, () =>
      value(r, depth + 1),
    );
  const o: Record<string, unknown> = {};
  for (let n = Math.floor(r() * 4); n > 0; n--) o[str(r)] = value(r, depth + 1);
  return o;
}

const flipBit = (b64: string, bit: number): string => {
  const bytes = fromBase64Url(b64);
  bytes[bit >> 3] = (bytes[bit >> 3] as number) ^ (1 << (bit & 7));
  return toBase64Url(bytes);
};

describe(`properties (seed ${SEED})`, () => {
  it("canonicalize -> JSON.parse -> canonicalize is the identity", () => {
    const r = rng(SEED);
    for (let i = 0; i < 500; i++) {
      const c = canonicalize(value(r));
      expect(canonicalize(JSON.parse(c)), `case ${i}`).toBe(c);
    }
  });

  it("verify(sign(x)) holds and any single sig bit flip fails", async () => {
    const r = rng(SEED + 1);
    const secret = generateSecretKey();
    const site = { secret, pub: await publicKeyOf(secret) };
    for (let i = 0; i < 12; i++) {
      const type = TYPES[Math.floor(r() * TYPES.length)] as ReceiptType;
      const key = str(r) || "k";
      const receipt = await buildReceipt(
        {
          type,
          ...(type === "SPOOF" ? { claimedKey: key } : { agentKey: key }),
          ua: str(r),
          path: `/${str(r).replaceAll("/", "")}/x`,
          count: Math.floor(r() * 1e6),
          windowStartS: 1_800_000_000,
          windowEndS: 1_800_000_600,
        },
        site,
      );
      expect(await verifyReceipt(receipt, site.pub), `case ${i}`).toEqual({
        ok: true,
      });
      // 512 signature bits; a stride of 7 with a per-case offset keeps the run
      // short while every byte, and across cases every bit position, is hit.
      for (let bit = i % 7; bit < 512; bit += 7) {
        const forged = { ...receipt, sig: flipBit(receipt.sig, bit) };
        expect(
          (await verifyReceipt(forged, site.pub)).ok,
          `case ${i} bit ${bit}`,
        ).toBe(false);
      }
    }
  }, 30_000); // ~900 Ed25519 verifies: slow under the full parallel suite

  it("a voucher with one signature bit flipped never spends", async () => {
    const secret = generateSecretKey();
    const site = { secret, pub: await publicKeyOf(secret) };
    const v = await mintVoucher(
      { agentKey: null, credits: 3, expiresS: 2e9, nowS: 1.8e9 },
      secret,
    );
    const [payload, sig] = v.split(".") as [string, string];
    const opts = { nowS: 1.8e9, allowBearer: true };
    expect((await spendVoucher(v, site, null, opts)).state).toBe("spent");
    for (let bit = 0; bit < 512; bit += 3) {
      const r = await spendVoucher(
        `${payload}.${flipBit(sig, bit)}`,
        site,
        null,
        opts,
      );
      expect(r.state, `bit ${bit}`).toBe("bad-signature");
    }
  }, 30_000);
});
