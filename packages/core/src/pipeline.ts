// Decision pipeline, plan §1. This module is pure policy: it decides, the
// HTTP binding acts (and in observe mode records instead of acting). Steps
// 4-7 (maze wiring, vouchers, x402 proofs, offer exhaustion) land with their
// tasks; the ladder below already classifies for them.
import type { TollboothConfig } from "./config.js";
import { agentHeuristics } from "./heuristics.js";
import { type FetchDirectory, verifyWebBotAuth } from "./wba.js";

export interface PipelineRequest {
  /** Pathname only, no query. */
  path: string;
  authority: string;
  method?: string;
  scheme?: string;
  userAgent: string;
  accept?: string;
  hasCookies: boolean;
  secFetchSite?: string;
  signature?: string;
  signatureInput?: string;
  signatureAgent?: string;
}

export type Identity =
  | { kind: "human" }
  /** Web Bot Auth verified — agentKey is the base64url Ed25519 public key. */
  | { kind: "agent"; agentKey: string }
  /** Agent-shaped but unverified; `via` names the evidence (facts for the report). */
  | { kind: "anonymous-agent"; via: string[] }
  /** Cryptographically wrong signature for the claimed key — the only spoof case. */
  | { kind: "spoofer"; claimedKey: string | null; claimedKeyId: string | null };

export interface OfferBody {
  v: 1;
  price_usd: string;
  options: OfferOption[];
}

export type OfferOption =
  | { method: "x402"; network: string; pay_to: string; price_usd: string }
  | {
      method: "stripe-voucher";
      payment_link: string;
      credits: number;
      voucher_header: "Tollbooth-Voucher";
    };

export type Decision =
  | { action: "pass"; reason: "free-path" | "human"; identity: Identity | null }
  | { action: "offer"; identity: Identity; body: OfferBody }
  /** Spoof consequence — served by the maze once T-017 wires it. */
  | { action: "consequence"; reason: "spoof"; identity: Identity };

export interface PipelineDeps {
  fetchDirectory: FetchDirectory;
  /** Epoch seconds — injectable for deterministic tests. */
  nowS?: number;
}

/** Entries ending in "/" match as prefixes; everything else matches exactly. */
const isFreePath = (path: string, free: string[]): boolean =>
  free.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );

/** Every enabled payment option, with enough data to complete each (AC-7.2). */
export function buildOfferBody(cfg: TollboothConfig): OfferBody {
  const options: OfferOption[] = [];
  if (cfg.toll.x402.enabled) {
    options.push({
      method: "x402",
      network: cfg.toll.x402.network,
      pay_to: cfg.toll.x402.pay_to,
      price_usd: cfg.toll.price_usd,
    });
  }
  if (cfg.toll.stripe.enabled) {
    options.push({
      method: "stripe-voucher",
      payment_link: cfg.toll.stripe.payment_link,
      credits: cfg.toll.stripe.credits_per_purchase,
      voucher_header: "Tollbooth-Voucher",
    });
  }
  return { v: 1, price_usd: cfg.toll.price_usd, options };
}

async function identify(
  req: PipelineRequest,
  cfg: TollboothConfig,
  deps: PipelineDeps,
): Promise<Identity> {
  const wbaPresent =
    req.signature !== undefined ||
    req.signatureInput !== undefined ||
    req.signatureAgent !== undefined;

  if (wbaPresent) {
    const result = await verifyWebBotAuth(
      {
        signature: req.signature ?? "",
        signatureInput: req.signatureInput ?? "",
        signatureAgent: req.signatureAgent ?? "",
        authority: req.authority,
        ...(req.method !== undefined ? { method: req.method } : {}),
        path: req.path,
        ...(req.scheme !== undefined ? { scheme: req.scheme } : {}),
      },
      { fetchDirectory: deps.fetchDirectory },
      {
        skewToleranceS: Math.floor(cfg.wba_skew_tolerance / 1000),
        ...(deps.nowS !== undefined ? { nowS: deps.nowS } : {}),
      },
    );
    if (result.state === "verified" && result.agentKey !== null) {
      return { kind: "agent", agentKey: result.agentKey };
    }
    if (result.state === "invalid_signature") {
      return {
        kind: "spoofer",
        claimedKey: result.agentKey,
        claimedKeyId: result.keyId,
      };
    }
    // Everything else is a claim we could not evaluate, not proof of forgery:
    // stale (IV.13), unknown_key (key rotation happens), unreachable
    // directory, malformed headers (broken client). Offer-eligible, never
    // maze — a false consequence on an honest agent is the II.6-adjacent
    // failure class.
    return { kind: "anonymous-agent", via: [`wba-${result.state}`] };
  }

  const heuristics = agentHeuristics({
    userAgent: req.userAgent,
    ...(req.accept !== undefined ? { accept: req.accept } : {}),
    hasCookies: req.hasCookies,
    ...(req.secFetchSite !== undefined
      ? { secFetchSite: req.secFetchSite }
      : {}),
  });
  return heuristics.agent
    ? { kind: "anonymous-agent", via: heuristics.matched }
    : { kind: "human" };
}

export async function decide(
  req: PipelineRequest,
  cfg: TollboothConfig,
  deps: PipelineDeps,
): Promise<Decision> {
  // Step 1: free paths pass unconditionally, before any other logic (AC-5.3) —
  // identity is not even computed.
  if (isFreePath(req.path, cfg.free_paths))
    return { action: "pass", reason: "free-path", identity: null };

  // Step 2: identify.
  const identity = await identify(req, cfg, deps);

  // Step 3: humans pass, always (II.6).
  if (identity.kind === "human")
    return { action: "pass", reason: "human", identity };

  // Step 4: spoofers meet the consequence (maze serving wired at T-017).
  if (identity.kind === "spoofer")
    return { action: "consequence", reason: "spoof", identity };

  // Steps 5-7 (vouchers, x402 proofs, offer exhaustion) land with their tasks.

  // Step 8: the offer.
  return { action: "offer", identity, body: buildOfferBody(cfg) };
}
