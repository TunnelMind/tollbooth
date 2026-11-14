// SPDX-License-Identifier: MIT
// Decision pipeline, plan §1. This module is pure policy: it decides, the
// HTTP binding acts (and in observe mode records instead of acting). The
// only state it touches is injected: the offer ledger (D-3) and the jti
// replay cache (AC-3.3).
import { botRanges, ipInRanges } from "./botranges.js";
import type { FaresealConfig } from "./config.js";
import { agentHeuristics } from "./heuristics.js";
import type { JtiCache } from "./jti.js";
import type { OfferLedger } from "./ledger.js";
import type { NonceCache } from "./nonce.js";
import { decodeVoucher, type SiteKeyPair, spendVoucher } from "./voucher.js";
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
  /** X-PAYMENT header, verbatim, when the client is retrying with proof. */
  payment?: string;
  /** Fareseal-Voucher header, verbatim. */
  voucher?: string;
  /** Client IP from a source the binding trusts; absent when it has none. */
  clientIp?: string;
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
      voucher_header: "Fareseal-Voucher";
    };

export type Decision =
  | {
      action: "pass";
      reason:
        | "free-path"
        | "human"
        | "paid"
        | "voucher"
        | "verified-search"
        | "verified-preview";
      identity: Identity | null;
      /** The re-signed successor voucher to set on the response (AC-3.2). */
      voucher?: string;
    }
  | { action: "offer"; identity: Identity; body: OfferBody }
  /** Voucher proof-of-possession failed (AC-3.4) — a rejection, not a consequence. */
  | {
      action: "reject";
      status: 403;
      reason: "mismatch" | "bearer-disabled";
      identity: Identity;
    }
  /** Spoof consequence — the binding serves it from the maze. */
  | {
      action: "consequence";
      reason: "spoof" | "toll-ignored";
      identity: Identity;
    };

/** Payment verification is injected: core never imports chain libraries (AC-2.3). */
export type VerifyPayment = (
  payment: string,
) =>
  | { ok: boolean; payer: string | null; reason?: string }
  | Promise<{ ok: boolean; payer: string | null; reason?: string }>;

/**
 * R-O3: held repeats per verified agent key per offer window that record no
 * offer. validAfter is at most skew_tolerance (default 60 s) ahead of our
 * clock, so an honest agent polling once a second on its one early payment
 * makes at most 60 and is never mazed for waiting. Not a config key.
 */
const HELD_REPEATS_FREE = 60;

const OPERATOR_FAULTS = new Set([
  "settle-retryable",
  "settle-throttled",
  "settlement-unconfigured",
  "settlement-not-configured",
  "settle-unreachable",
]);

/**
 * FR-006: a rejected payment the operator failed, not the payer: our
 * facilitator down, rate-limited, refusing our credentials, or unconfigured.
 * Such a payment never counts toward, or triggers, the maze; the payer did
 * what was asked. Hono's paymentError uses the same predicate for its 402 text.
 */
export function isOperatorFault(reason?: string): boolean {
  if (reason === undefined) return false;
  if (OPERATOR_FAULTS.has(reason)) return true;
  if (/^(?:verify|settle)-error:/.test(reason)) return true;
  return /^(?:verify|settle)-failed\((?:5\d\d|401|403|429)\)$/.test(reason);
}

/**
 * Step 6 (R002 L3/L7): a rejected payment that records no offer. Operator
 * faults, plus two answers where the payer may already have paid: a settle
 * with an unusable transaction id, and a non-2xx claiming settled:true.
 * Kept out of isOperatorFault because hono's text for those says "retry the
 * same payment", wrong for a cached no-transaction-id or a maybe-moved one.
 *
 * R004 (second review 2 L-a): settle-throttled is NOT one. Our settle bucket
 * is shared, so any client can empty it; were it no-offer, a verified agent
 * could drain it and never be mazed. Its 402 text stays the operator-fault
 * one. (not-yet-valid-held is not one either: it keeps the consequence and
 * only skips the ledger write, see decide step 6/8.)
 */
export function isNoOfferFault(reason?: string): boolean {
  if (reason === "settle-throttled") return false;
  return (
    isOperatorFault(reason) ||
    reason === "no-transaction-id" ||
    reason === "settle-unconfirmed"
  );
}

export interface PipelineDeps {
  fetchDirectory: FetchDirectory;
  /** Epoch seconds — injectable for deterministic tests. */
  nowS?: number;
  /** D-3 offer-state ledger; verified agent keys only. */
  ledger?: OfferLedger;
  verifyPayment?: VerifyPayment;
  /** Site keypair for voucher verify/re-sign (step 5 is skipped without it). */
  siteKeys?: SiteKeyPair;
  /** AC-3.3 replay damper. */
  jtiCache?: JtiCache;
  /** Refuses replayed WBA signatures that carry a `nonce`. */
  nonceCache?: NonceCache;
}

/** Entries ending in "/" match as prefixes; everything else matches exactly. */
export const isFreePath = (path: string, free: string[]): boolean =>
  free.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );

const SEARCH_UA = /Googlebot|bingbot/i;
const PREVIEW_UA =
  /Slackbot|Twitterbot|facebookexternalhit|LinkedInBot|Discordbot/i;
const SEARCH_RANGES = [...botRanges.google, ...botRanges.bing];
// Paths with these endings are assets or API payloads, not pages.
const NON_HTML_EXT =
  /\.(json|xml|txt|csv|js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|pdf|zip|gz|mp4|webm|mp3|wasm)$/i;

/**
 * A preview bot unfurling a link wants the page: a GET or HEAD whose Accept
 * is absent or includes text/html, for a path that is not an asset or API
 * file by extension. Everything else is ordinary agent traffic.
 */
const isHtmlPageRequest = (req: PipelineRequest): boolean =>
  (req.method === "GET" || req.method === "HEAD") &&
  (req.accept === undefined || req.accept.includes("text/html")) &&
  !NON_HTML_EXT.test(req.path);

/** Every enabled payment option, with enough data to complete each (AC-7.2). */
export function buildOfferBody(cfg: FaresealConfig): OfferBody {
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
      voucher_header: "Fareseal-Voucher",
    });
  }
  return { v: 1, price_usd: cfg.toll.price_usd, options };
}

const hasWba = (req: PipelineRequest): boolean =>
  req.signature !== undefined ||
  req.signatureInput !== undefined ||
  req.signatureAgent !== undefined;

// Exported for one caller outside decide(): the bindings' /_fareseal/arrival
// route, which shows a requester their own identity. That route is a free
// path, and decide() skips identify on free paths, so it calls this directly
// with fetchDirectory only (no nonceCache: reading must not burn a replay),
// and only for unsigned requests; a signed arrival request is not verified at
// all (see the hono route), so no directory fetch and no replay burn.
export async function identify(
  req: PipelineRequest,
  cfg: FaresealConfig,
  deps: PipelineDeps,
): Promise<Identity> {
  if (hasWba(req)) {
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
      {
        fetchDirectory: deps.fetchDirectory,
        ...(deps.nonceCache ? { nonceCache: deps.nonceCache } : {}),
      },
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

/**
 * decide() Step 1b as a pure check: the verified search / preview pass this
 * request gets, or null. Exported so the bindings' arrival route reads the
 * same outcome an ordinary request would get, without running decide().
 */
export function verifiedPass(
  req: PipelineRequest,
  cfg: FaresealConfig,
): Decision | null {
  if (cfg.pass_verified.length === 0 || hasWba(req)) return null;
  if (
    cfg.pass_verified.includes("search") &&
    SEARCH_UA.test(req.userAgent) &&
    req.clientIp !== undefined &&
    ipInRanges(req.clientIp, SEARCH_RANGES)
  )
    return { action: "pass", reason: "verified-search", identity: null };
  if (
    cfg.pass_verified.includes("preview") &&
    PREVIEW_UA.test(req.userAgent) &&
    isHtmlPageRequest(req)
  )
    return { action: "pass", reason: "verified-preview", identity: null };
  return null;
}

export async function decide(
  req: PipelineRequest,
  cfg: FaresealConfig,
  deps: PipelineDeps,
): Promise<Decision> {
  // Step 1: free paths pass unconditionally, before any other logic (AC-5.3) —
  // identity is not even computed. (The one exception is the bindings'
  // /_fareseal/arrival route, which calls identify() itself to show the
  // requester their own reading.)
  if (isFreePath(req.path, cfg.free_paths))
    return { action: "pass", reason: "free-path", identity: null };

  // Step 1b (B009, opt-in): verified search and preview bots pass. Never for
  // a Web Bot Auth request, which keeps its normal path. Search needs the
  // operator-published IP range, so a spoofed UA (or no trusted client IP)
  // falls through to the offer like any other agent.
  const verified = verifiedPass(req, cfg);
  if (verified) return verified;

  // Step 2: identify.
  const identity = await identify(req, cfg, deps);

  // Step 3: humans pass, always (II.6).
  if (identity.kind === "human")
    return { action: "pass", reason: "human", identity };

  // Step 4: spoofers meet the consequence (the binding redirects into the maze).
  if (identity.kind === "spoofer")
    return { action: "consequence", reason: "spoof", identity };

  const nowS = deps.nowS ?? Math.floor(Date.now() / 1000);
  const nowMs = nowS * 1000;

  // Step 5: voucher spending (AC-3.2/3.3/3.4). Damped replay and unusable
  // vouchers fall through to the offer; only a failed proof-of-possession is
  // a rejection.
  if (req.voucher !== undefined && deps.siteKeys) {
    let withinWindow = true;
    if (deps.jtiCache) {
      try {
        withinWindow = deps.jtiCache.allow(
          decodeVoucher(req.voucher).jti,
          cfg.limits.replay_window,
        );
      } catch {
        // undecodable: let spendVoucher classify it below
      }
    }
    if (withinWindow) {
      const spend = await spendVoucher(
        req.voucher,
        deps.siteKeys,
        identity.kind === "agent" ? identity.agentKey : null,
        { nowS, allowBearer: cfg.toll.stripe.bearer },
      );
      if (spend.state === "spent") {
        if (identity.kind === "agent")
          deps.ledger?.recordPaid(identity.agentKey, nowMs);
        return {
          action: "pass",
          reason: "voucher",
          identity,
          voucher: spend.next,
        };
      }
      if (spend.state === "mismatch" || spend.state === "bearer-disabled") {
        return { action: "reject", status: 403, reason: spend.state, identity };
      }
      // expired / exhausted / bad-signature / malformed: fall through
    }
  }

  // Step 6: a valid payment proof passes (AC-2.2).
  // R004 L-b: the local repeat of a held early payment's answer (no settle
  // call) records no offer, so an honest agent whose clock runs ahead is not
  // mazed while it waits; the first answer, which reached the facilitator,
  // did record one. Unlike the no-offer faults it still meets step 7, so an
  // agent already mazed stays mazed by repeating one held payment.
  // R-O3: only the first HELD_REPEATS_FREE repeats per key per window are
  // free. After that each one records an offer, or a throwaway payment
  // would hold the offer open for as long as the hold lasts.
  let ledgerOffer = true;
  if (req.payment !== undefined && deps.verifyPayment) {
    const paid = await deps.verifyPayment(req.payment);
    if (paid.ok) {
      if (identity.kind === "agent")
        deps.ledger?.recordPaid(identity.agentKey, nowMs);
      return { action: "pass", reason: "paid", identity };
    }
    // FR-006: our fault (or maybe paid), so the offer again - no consequence
    // check, no ledger.
    if (isNoOfferFault(paid.reason))
      return { action: "offer", identity, body: buildOfferBody(cfg) };
    if (paid.reason === "not-yet-valid-held") {
      // Anonymous traffic is never ledgered, here or at step 8 (spec sec 8).
      ledgerOffer =
        identity.kind === "agent" &&
        deps.ledger !== undefined &&
        deps.ledger.recordHeld(identity.agentKey, nowMs, cfg.toll.window) >
          HELD_REPEATS_FREE;
    }
  }

  // Step 7: grace offers ignored within the window -> the consequence
  // (AC-4.1). Only when a maze exists to serve it, and never for anonymous
  // keys (spec sec 8). Payment at steps 5/6 runs first, so a mazed key that
  // pays never reaches this line - and recordPaid cleared its window (AC-4.4).
  if (
    identity.kind === "agent" &&
    cfg.maze.enabled &&
    deps.ledger?.exhausted(
      identity.agentKey,
      nowMs,
      cfg.toll.window,
      cfg.toll.offer_grace,
    )
  ) {
    return { action: "consequence", reason: "toll-ignored", identity };
  }

  // Step 8: the offer. Only verified keys are ledgered (spec sec 8).
  if (identity.kind === "agent" && ledgerOffer)
    deps.ledger?.recordOffer(identity.agentKey, nowMs, cfg.toll.window);
  return { action: "offer", identity, body: buildOfferBody(cfg) };
}
