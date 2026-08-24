// Shared x402 payment fixtures: a fixed secp256k1 key signing real EIP-3009
// authorizations. Used by the adapter suite and the hono toll integration.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  authorizationHash,
  encodePayment,
  type PaymentPayload,
  type TransferAuthorization,
} from "../../src/index.js";

export const NOW = 1_800_000_000;
export const PAY_TO = "0x1111111111111111111111111111111111111111";

/** Fixed test key -> deterministic payer address. */
export const PRIV = hexToBytes(
  "2e0834786285daccd064ca17f1654f67b4aef298acbb82cef9ec422fb4975622",
);
const PUB = secp256k1.getPublicKey(PRIV, false);
export const PAYER = `0x${bytesToHex(keccak_256(PUB.slice(1)).slice(-20))}`;

export function ethAddressOf(point: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(point.slice(1)).slice(-20))}`;
}

/** Sign like an Ethereum wallet: 64-byte compact + recovery byte 27/28. */
export function signAuth(
  auth: TransferAuthorization,
  network = "base-sepolia",
): string {
  const digest = authorizationHash(network, auth);
  const rs = secp256k1.sign(digest, PRIV, { prehash: false });
  for (const rec of [0, 1]) {
    const candidate = secp256k1.Signature.fromBytes(
      rs,
      "compact",
    ).addRecoveryBit(rec);
    const recovered = ethAddressOf(
      candidate.recoverPublicKey(digest).toBytes(false),
    );
    if (recovered === PAYER)
      return `0x${bytesToHex(rs)}${(27 + rec).toString(16)}`;
  }
  throw new Error("no recovery bit matched");
}

export function makeAuth(
  overrides: Partial<TransferAuthorization> = {},
): TransferAuthorization {
  return {
    from: PAYER,
    to: PAY_TO,
    value: "1000",
    validAfter: "0",
    validBefore: String(NOW + 600),
    nonce: `0x${"11".repeat(32)}`,
    ...overrides,
  };
}

export function payment(
  auth: TransferAuthorization,
  signature: string,
  network = "base-sepolia",
): string {
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network,
    payload: { signature, authorization: auth },
  };
  return encodePayment(payload);
}

/** A complete, valid X-PAYMENT header value. */
export function validPayment(): string {
  const auth = makeAuth();
  return payment(auth, signAuth(auth));
}
