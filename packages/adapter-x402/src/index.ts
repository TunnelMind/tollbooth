// SPDX-License-Identifier: MIT
// @tollbooth/adapter-x402: x402 offer headers and payment-proof verification.
// ALL chain specifics live inside this boundary (AC-2.3, D-7) - core never
// imports a chain library, and this adapter is off the hot path for
// non-paying traffic (Article I.1).
//
// verifyProof verifies the EIP-3009 TransferWithAuthorization locally:
// EIP-712 digest, secp256k1 recovery, recipient/value/window checks.
// SETTLEMENT - broadcasting the authorization to actually move funds - is the
// operator's configured rail (Article V.15); an authorization that verifies
// here is a payable claim, not a settled payment, and the docs say so.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import type { TollboothConfig } from "@tollbooth/core";

/**
 * Known EIP-712 asset domains. base-sepolia is the DEFAULT and every example
 * uses it; base (mainnet) is present but must be named explicitly by the
 * operator (Constitution V.15, ADR 003). No mainnet is ever a default.
 */
export const NETWORKS: Record<
  string,
  { chainId: bigint; asset: string; assetName: string; assetVersion: string }
> = {
  "base-sepolia": {
    chainId: 84532n,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
    assetName: "USDC",
    assetVersion: "2",
  },
  // Mainnet is available but never the default (V.15, ADR 003): every example
  // and the config default stay base-sepolia. An operator opts into real
  // settlement by naming this network explicitly.
  base: {
    chainId: 8453n,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Circle USDC on Base
    assetName: "USD Coin",
    assetVersion: "2",
  },
};

export interface TransferAuthorization {
  from: string;
  to: string;
  /** Atomic units as a decimal string (JSON-safe). */
  value: string;
  validAfter: string;
  validBefore: string;
  /** 32-byte hex, 0x-prefixed. */
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: { signature: string; authorization: TransferAuthorization };
}

export interface X402Requirement {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface VerifyResult {
  ok: boolean;
  /** Lowercase 0x address of the verified signer; null unless ok. */
  payer: string | null;
  reason?: string;
}

/** Decimal-string dollars to asset atomics, no floats anywhere. */
export function usdToAtomic(price: string, decimals = 6): bigint {
  const [whole = "0", frac = ""] = price.split(".");
  const fracAtomic = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fracAtomic === "" ? "0" : fracAtomic)
  );
}

const pad32 = (bytes: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array(32 - bytes.length), bytes);
const encAddress = (address: string): Uint8Array =>
  pad32(hexToBytes(address.slice(2)));
function encUint(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return pad32(hexToBytes(hex));
}
const keccakText = (text: string): Uint8Array => keccak_256(utf8ToBytes(text));

const DOMAIN_TYPEHASH = keccakText(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
);
const TWA_TYPEHASH = keccakText(
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
);

function networkOf(network: string) {
  const net = NETWORKS[network];
  if (!net)
    throw new Error(
      `unsupported x402 network "${network}" (supported: ${Object.keys(NETWORKS).join(", ")})`,
    );
  return net;
}

/** EIP-712 digest of a TransferWithAuthorization - what wallets sign. */
export function authorizationHash(
  network: string,
  auth: TransferAuthorization,
): Uint8Array {
  const net = networkOf(network);
  const domain = keccak_256(
    concatBytes(
      DOMAIN_TYPEHASH,
      keccakText(net.assetName),
      keccakText(net.assetVersion),
      encUint(net.chainId),
      encAddress(net.asset),
    ),
  );
  const struct = keccak_256(
    concatBytes(
      TWA_TYPEHASH,
      encAddress(auth.from),
      encAddress(auth.to),
      encUint(BigInt(auth.value)),
      encUint(BigInt(auth.validAfter)),
      encUint(BigInt(auth.validBefore)),
      pad32(hexToBytes(auth.nonce.slice(2))),
    ),
  );
  return keccak_256(concatBytes(Uint8Array.from([0x19, 0x01]), domain, struct));
}

function recoverPayer(signature: string, digest: Uint8Array): string {
  const sig = hexToBytes(signature.slice(2));
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  const v = sig[64] ?? 0;
  const parsed = secp256k1.Signature.fromBytes(
    sig.slice(0, 64),
    "compact",
  ).addRecoveryBit(v >= 27 ? v - 27 : v);
  const publicKey = parsed.recoverPublicKey(digest).toBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

/** The X-PAYMENT header value a paying client sends (also used by tests). */
export function encodePayment(payload: PaymentPayload): string {
  return btoa(JSON.stringify(payload));
}

/** AC-2.1: payment-required headers + requirement from config, price in atomics. */
export function buildOffer(
  cfg: TollboothConfig,
  resource: string,
): { headers: Record<string, string>; requirement: X402Requirement } {
  const net = networkOf(cfg.toll.x402.network);
  const requirement: X402Requirement = {
    scheme: "exact",
    network: cfg.toll.x402.network,
    maxAmountRequired: usdToAtomic(cfg.toll.price_usd).toString(),
    resource,
    payTo: cfg.toll.x402.pay_to,
    asset: net.asset,
    maxTimeoutSeconds: 300,
    extra: { name: net.assetName, version: net.assetVersion },
  };
  return {
    headers: { "x-payment-required": JSON.stringify(requirement) },
    requirement,
  };
}

/** AC-2.2: local verification of an X-PAYMENT header. Never throws. */
export function verifyProof(
  xPayment: string,
  cfg: TollboothConfig,
  opts: { nowS?: number } = {},
): VerifyResult {
  const fail = (reason: string): VerifyResult => ({
    ok: false,
    payer: null,
    reason,
  });

  let payload: PaymentPayload;
  try {
    payload = JSON.parse(atob(xPayment)) as PaymentPayload;
  } catch {
    return fail("malformed");
  }
  const auth = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (
    payload?.x402Version !== 1 ||
    payload.scheme !== "exact" ||
    !auth ||
    typeof signature !== "string"
  )
    return fail("malformed");
  if (payload.network !== cfg.toll.x402.network)
    return fail("network-mismatch");
  if (auth.to.toLowerCase() !== cfg.toll.x402.pay_to.toLowerCase())
    return fail("wrong-recipient");

  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(auth.value);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return fail("malformed");
  }
  if (value < usdToAtomic(cfg.toll.price_usd))
    return fail("insufficient-value");
  const nowS = BigInt(opts.nowS ?? Math.floor(Date.now() / 1000));
  if (validAfter > nowS) return fail("not-yet-valid");
  if (validBefore < nowS) return fail("expired");

  let payer: string;
  try {
    payer = recoverPayer(signature, authorizationHash(payload.network, auth));
  } catch {
    return fail("bad-signature");
  }
  if (payer !== auth.from.toLowerCase()) return fail("signer-mismatch");
  return { ok: true, payer };
}
