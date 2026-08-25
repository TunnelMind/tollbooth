// SPDX-License-Identifier: MIT
// D-1 vouchers: `<b64url(JCS payload)>.<b64url sig)>`, Ed25519-signed by the
// site key, verified and re-signed with credits-1 AND a freshly generated jti
// on every spend - each signed state has a unique jti, so the jti LRU (T-012)
// damps replay of one state while sequential spending is unlimited.
//
// Key-bound by default: spending requires the request's VERIFIED agent key to
// equal the voucher's agent_key (proof-of-possession happens upstream via Web
// Bot Auth). Bearer vouchers (agent_key null) are accepted only behind the
// toll.stripe.bearer config flag. This is soft enforcement (Article V.14):
// parallel replay can over-spend within a voucher's lifetime, and no database
// will be added to change that.
import { canonicalize } from "./canonicalize.js";
import { fromBase64Url, sign, toBase64Url, verify } from "./keys.js";

export interface VoucherPayload {
  v: 1;
  /** base64url Ed25519 agent public key, or null for a bearer voucher. */
  agent_key: string | null;
  credits: number;
  /** Epoch seconds. */
  expires: number;
  /** Unique per signed state - rotates on every re-sign. */
  jti: string;
  iat: number;
}

export interface SiteKeyPair {
  secret: Uint8Array;
  pub: Uint8Array;
}

export type SpendResult =
  | { state: "spent"; payload: VoucherPayload; next: string }
  | {
      state:
        | "mismatch"
        | "bearer-disabled"
        | "expired"
        | "exhausted"
        | "bad-signature"
        | "malformed";
    };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function randomJti(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function encode(payload: VoucherPayload, signature: Uint8Array): string {
  return `${toBase64Url(encoder.encode(canonicalize(payload)))}.${toBase64Url(signature)}`;
}

export async function mintVoucher(
  opts: {
    agentKey: string | null;
    credits: number;
    expiresS: number;
    nowS: number;
  },
  siteSecret: Uint8Array,
): Promise<string> {
  const payload: VoucherPayload = {
    v: 1,
    agent_key: opts.agentKey,
    credits: opts.credits,
    expires: opts.expiresS,
    jti: randomJti(),
    iat: opts.nowS,
  };
  return encode(payload, await sign(canonicalize(payload), siteSecret));
}

function parse(encoded: string): {
  payload: VoucherPayload;
  payloadText: string;
  sig: Uint8Array;
} {
  const dot = encoded.indexOf(".");
  if (dot < 1) throw new Error("voucher: expected payload.signature");
  const payloadText = decoder.decode(fromBase64Url(encoded.slice(0, dot)));
  const sig = fromBase64Url(encoded.slice(dot + 1));
  const payload = JSON.parse(payloadText) as VoucherPayload;
  if (
    payload.v !== 1 ||
    (payload.agent_key !== null && typeof payload.agent_key !== "string") ||
    typeof payload.credits !== "number" ||
    typeof payload.expires !== "number" ||
    typeof payload.jti !== "string" ||
    typeof payload.iat !== "number"
  )
    throw new Error("voucher: bad payload shape");
  return { payload, payloadText, sig };
}

/** Decode without verifying - for inspection (`cli voucher inspect`) and tests. */
export function decodeVoucher(encoded: string): VoucherPayload {
  return parse(encoded).payload;
}

/**
 * Verify and spend one credit: on success returns the re-signed successor
 * voucher (credits-1, fresh jti, expiry unchanged - a re-sign never extends
 * life). The signature is checked over the transmitted bytes, not a
 * re-canonicalization.
 */
export async function spendVoucher(
  encoded: string,
  site: SiteKeyPair,
  requestAgentKey: string | null,
  opts: { nowS: number; allowBearer: boolean },
): Promise<SpendResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(encoded);
  } catch {
    return { state: "malformed" };
  }
  const { payload, payloadText, sig } = parsed;

  if (!(await verify(sig, payloadText, site.pub)))
    return { state: "bad-signature" };
  if (payload.expires < opts.nowS) return { state: "expired" };
  if (payload.credits <= 0) return { state: "exhausted" };

  if (payload.agent_key === null) {
    if (!opts.allowBearer) return { state: "bearer-disabled" };
  } else if (payload.agent_key !== requestAgentKey) {
    return { state: "mismatch" };
  }

  const next = await mintVoucher(
    {
      agentKey: payload.agent_key,
      credits: payload.credits - 1,
      expiresS: payload.expires,
      nowS: opts.nowS,
    },
    site.secret,
  );
  return { state: "spent", payload, next };
}
