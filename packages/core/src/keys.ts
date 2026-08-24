// Ed25519 via @noble/ed25519's async API, which digests SHA-512 through the
// platform's WebCrypto — no @noble/hashes needed on any target (ADR 001).
import {
  getPublicKeyAsync,
  signAsync,
  utils,
  verifyAsync,
} from "@noble/ed25519";

/** base64url without padding — the wire encoding for keys, vouchers, and receipts. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function generateSecretKey(): Uint8Array {
  return utils.randomSecretKey();
}

export function publicKeyOf(secretKey: Uint8Array): Promise<Uint8Array> {
  return getPublicKeyAsync(secretKey);
}

const encoder = new TextEncoder();
const asBytes = (message: Uint8Array | string): Uint8Array =>
  typeof message === "string" ? encoder.encode(message) : message;

export function sign(
  message: Uint8Array | string,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  return signAsync(asBytes(message), secretKey);
}

/** False for bad signatures AND malformed input — verification never throws. */
export async function verify(
  signature: Uint8Array,
  message: Uint8Array | string,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    return await verifyAsync(signature, asBytes(message), publicKey);
  } catch {
    return false;
  }
}
