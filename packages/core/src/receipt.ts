// SPDX-License-Identifier: MIT
// Conduct receipts (AC-6.2): observations, never judgments (Article III).
// Request metadata only - path_class is the FIRST SEGMENT of the path and
// nothing more, and request/response bodies are never captured, logged or
// transmitted (III.9; the sentinel test holds this). RFC 8785 canonicalized,
// Ed25519-signed by the site key, verifiable offline by anyone holding the
// site public key (III.10).
import { canonicalize } from "./canonicalize.js";
import { fromBase64Url, sign, toBase64Url, verify } from "./keys.js";
import type { Decision } from "./pipeline.js";
import type { SiteKeyPair } from "./voucher.js";

export type ReceiptType =
  | "TOLL_IGNORED"
  | "SPOOF"
  | "PASS_PAID"
  | "VOUCHER_MISMATCH";

const RECEIPT_TYPES: readonly ReceiptType[] = [
  "TOLL_IGNORED",
  "SPOOF",
  "PASS_PAID",
  "VOUCHER_MISMATCH",
];

export interface Receipt {
  v: 1;
  type: ReceiptType;
  site: string;
  /** VERIFIED agent public key - always null on SPOOF (III.9). */
  agent_key: string | null;
  /** Unverified claimed key - SPOOF only; anyone can send garbage naming any key. */
  claimed_key: string | null;
  ua: string;
  /** First path segment only. */
  path_class: string;
  count: number;
  window_start: string;
  window_end: string;
  /** ed25519 over the JCS form of every field above. */
  sig: string;
}

export interface ReceiptFacts {
  type: ReceiptType;
  agentKey?: string | null;
  claimedKey?: string | null;
  ua: string;
  /** Full request path; only its first segment survives into the receipt. */
  path: string;
  count: number;
  windowStartS: number;
  windowEndS: number;
}

function pathClass(path: string): string {
  const first = path.split("/")[1] ?? "";
  const segment = first.split("?")[0] ?? "";
  return segment === "" ? "/" : `/${segment}`;
}

export async function buildReceipt(
  facts: ReceiptFacts,
  site: SiteKeyPair,
): Promise<Receipt> {
  if (facts.type === "SPOOF" && facts.agentKey != null)
    throw new Error(
      "SPOOF receipts must not carry agent_key (Constitution III.9)",
    );
  if (facts.type !== "SPOOF" && facts.claimedKey != null)
    throw new Error("claimed_key is SPOOF-only (Constitution III.9)");

  const unsigned = {
    v: 1 as const,
    type: facts.type,
    site: toBase64Url(site.pub),
    agent_key: facts.type === "SPOOF" ? null : (facts.agentKey ?? null),
    claimed_key: facts.type === "SPOOF" ? (facts.claimedKey ?? null) : null,
    ua: facts.ua,
    path_class: pathClass(facts.path),
    count: facts.count,
    window_start: new Date(facts.windowStartS * 1000).toISOString(),
    window_end: new Date(facts.windowEndS * 1000).toISOString(),
  };
  return {
    ...unsigned,
    sig: toBase64Url(await sign(canonicalize(unsigned), site.secret)),
  };
}

/**
 * Offline verification: schema, constitutional invariants, canonical form,
 * signature. Runs with networking disabled by construction (AC-6.1).
 */
export async function verifyReceipt(
  value: unknown,
  sitePub: Uint8Array,
): Promise<{ ok: boolean; reason?: string }> {
  const fail = (reason: string) => ({ ok: false, reason });
  const r = value as Partial<Receipt> | null;
  if (r === null || typeof r !== "object") return fail("schema: not an object");
  if (r.v !== 1) return fail("schema: v must be 1");
  if (!RECEIPT_TYPES.includes(r.type as ReceiptType))
    return fail("schema: unknown type");
  for (const key of [
    "site",
    "ua",
    "path_class",
    "window_start",
    "window_end",
    "sig",
  ] as const) {
    if (typeof r[key] !== "string")
      return fail(`schema: ${key} must be a string`);
  }
  if (typeof r.count !== "number")
    return fail("schema: count must be a number");
  if (r.agent_key !== null && typeof r.agent_key !== "string")
    return fail("schema: agent_key");
  if (r.claimed_key !== null && typeof r.claimed_key !== "string")
    return fail("schema: claimed_key");
  if (
    Number.isNaN(Date.parse(r.window_start as string)) ||
    Number.isNaN(Date.parse(r.window_end as string))
  )
    return fail("schema: windows must be RFC3339");
  if (r.type === "SPOOF" && r.agent_key !== null)
    return fail("SPOOF receipts must not carry agent_key (III.9)");
  if (r.type !== "SPOOF" && r.claimed_key !== null)
    return fail("claimed_key is SPOOF-only (III.9)");
  if (r.site !== toBase64Url(sitePub)) return fail("site-mismatch");

  const { sig, ...unsigned } = r as Receipt;
  const valid = await verify(
    fromBase64Url(sig),
    canonicalize(unsigned),
    sitePub,
  );
  return valid ? { ok: true } : fail("signature");
}

/** Which decisions produce receipts, and with which facts. Null: no receipt. */
export function receiptFactsFor(
  decision: Decision,
  req: { userAgent: string; path: string },
  window: { count: number; windowStartS: number; windowEndS: number },
): ReceiptFacts | null {
  const base = { ua: req.userAgent, path: req.path, ...window };
  switch (decision.action) {
    case "consequence":
      if (decision.identity.kind === "spoofer")
        return {
          type: "SPOOF",
          claimedKey: decision.identity.claimedKey,
          ...base,
        };
      if (decision.identity.kind === "agent")
        return {
          type: "TOLL_IGNORED",
          agentKey: decision.identity.agentKey,
          ...base,
        };
      return null;
    case "reject":
      return {
        type: "VOUCHER_MISMATCH",
        agentKey:
          decision.identity.kind === "agent"
            ? decision.identity.agentKey
            : null,
        ...base,
      };
    case "pass":
      if (decision.reason !== "paid" && decision.reason !== "voucher")
        return null;
      return {
        type: "PASS_PAID",
        agentKey:
          decision.identity?.kind === "agent"
            ? decision.identity.agentKey
            : null,
        ...base,
      };
    default:
      return null;
  }
}
