// SPDX-License-Identifier: MIT
// @tollbooth/hono: thin binding of core's decide() to Hono. One package
// covers Node, Bun and Workers, so nothing here may import node builtins.
// Observe mode computes the decision and records it but always passes -
// and gets no spending deps, so it can never mutate voucher state.
import {
  buildReceipt,
  type Decision,
  decide,
  type FetchDirectory,
  JtiCache,
  OfferLedger,
  type PipelineDeps,
  type PipelineRequest,
  parseConfig,
  ReceiptReporter,
  receiptFactsFor,
  type SiteKeyPair,
  type TollboothConfig,
} from "@tollbooth/core";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The x402 adapter is injected, never imported: operators who only use
 * Stripe never pull chain libraries (D-7, AC-2.3). @tollbooth/adapter-x402
 * satisfies this shape structurally.
 */
export interface X402Adapter {
  buildOffer(
    cfg: TollboothConfig,
    resource: string,
  ): { headers: Record<string, string> };
  verifyProof(
    xPayment: string,
    cfg: TollboothConfig,
    opts?: { nowS?: number },
  ):
    | { ok: boolean; payer: string | null; reason?: string }
    | Promise<{ ok: boolean; payer: string | null; reason?: string }>;
}

/** @tollbooth/maze's makeMazeHandler satisfies this structurally. */
export type MazeHandler = (
  path: string,
) => Promise<{ status: number; body: string; headers: Record<string, string> }>;

/** @tollbooth/adapter-stripe's makeStripeAdapter satisfies this structurally. */
export interface StripeRoutes {
  handleWebhook(
    rawBody: string,
    stripeSignature: string | undefined,
  ): Promise<{ status: number; body: string }>;
  redeem(sessionId: string): {
    status: number;
    body: string;
    contentType: "text/html";
  };
}

export interface TollboothOptions {
  /** Parsed config, or TOML source (parsed with the same fail-hard rules). */
  config: TollboothConfig | string;
  /** Site keypair for voucher verify/re-sign (load via @tollbooth/core/node). */
  siteKeys?: SiteKeyPair;
  /** The x402 payment adapter (pass @tollbooth/adapter-x402's exports). */
  x402?: X402Adapter;
  /** The maze handler; serves the prefix and receives consequence redirects. */
  maze?: MazeHandler;
  /** The Stripe adapter; mounts the webhook and redemption routes. */
  stripe?: StripeRoutes;
  /** Receipt reporter override (tests); defaults from report/report_url config. */
  reporter?: ReceiptReporter;
  /** Override the built-in fetching (tests; custom caching). */
  fetchDirectory?: FetchDirectory;
  /** Injectable clock, epoch seconds. */
  nowS?: () => number;
}

const REPORT_PATH = "/_tollbooth/report";
const WEBHOOK_PATH = "/_tollbooth/stripe-webhook";
const VOUCHER_PATH_PREFIX = "/_tollbooth/voucher/";

interface AgentStat {
  kind: "agent" | "anonymous-agent" | "spoofer";
  ua: string;
  requests: number;
  paths: string[];
}

interface Stats {
  agents: Map<string, AgentStat>;
  humansPassed: number;
  freePathHits: number;
  robotsUAs: Set<string>;
}

const PATH_SAMPLE_MAX = 20;
const ROBOTS_UA_MAX = 1000;

/** In-memory, LRU-capped 1h cache over the WBA key-directory fetch. */
function makeDirectoryFetcher(
  ttlMs = 3_600_000,
  maxEntries = 256,
): FetchDirectory {
  const cache = new Map<string, { at: number; jwks: unknown }>();
  return async (url) => {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.jwks;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "user-agent": "tollbooth-wba-verifier/0.0" },
    });
    if (!resp.ok) throw new Error(`directory fetch ${resp.status}`);
    const text = await resp.text();
    if (text.length > 65536) throw new Error("directory exceeds 64KB cap");
    const jwks: unknown = JSON.parse(text);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, { at: Date.now(), jwks });
    return jwks;
  };
}

function requestFromContext(c: Context): PipelineRequest {
  const url = new URL(c.req.url);
  const header = (name: string) => c.req.header(name);
  return {
    path: c.req.path,
    authority: header("host") ?? url.host,
    method: c.req.method,
    scheme: url.protocol.replace(":", ""),
    userAgent: header("user-agent") ?? "",
    ...(header("accept") !== undefined
      ? { accept: header("accept") as string }
      : {}),
    hasCookies: header("cookie") !== undefined,
    ...(header("sec-fetch-site") !== undefined
      ? { secFetchSite: header("sec-fetch-site") as string }
      : {}),
    ...(header("signature") !== undefined
      ? { signature: header("signature") as string }
      : {}),
    ...(header("signature-input") !== undefined
      ? { signatureInput: header("signature-input") as string }
      : {}),
    ...(header("signature-agent") !== undefined
      ? { signatureAgent: header("signature-agent") as string }
      : {}),
    ...(header("x-payment") !== undefined
      ? { payment: header("x-payment") as string }
      : {}),
    ...(header("tollbooth-voucher") !== undefined
      ? { voucher: header("tollbooth-voucher") as string }
      : {}),
  };
}

function record(
  stats: Stats,
  req: PipelineRequest,
  decision: Decision,
  cap: number,
): void {
  if (decision.action === "pass" && decision.reason === "free-path") {
    stats.freePathHits += 1;
    if (req.path === "/robots.txt" && stats.robotsUAs.size < ROBOTS_UA_MAX)
      stats.robotsUAs.add(req.userAgent);
    return;
  }
  const identity = decision.identity;
  if (identity === null) return;
  if (identity.kind === "human") {
    stats.humansPassed += 1;
    return;
  }
  const key =
    identity.kind === "agent"
      ? identity.agentKey
      : identity.kind === "spoofer"
        ? `spoof:${identity.claimedKeyId ?? "unknown"}`
        : `anon:${req.userAgent}`;
  let entry = stats.agents.get(key);
  if (!entry) {
    // Bounded map; eviction is amnesty (D-3 spirit), never an error.
    if (stats.agents.size >= cap) {
      const oldest = stats.agents.keys().next().value;
      if (oldest !== undefined) stats.agents.delete(oldest);
    }
    entry = { kind: identity.kind, ua: req.userAgent, requests: 0, paths: [] };
    stats.agents.set(key, entry);
  }
  entry.requests += 1;
  if (!entry.paths.includes(req.path) && entry.paths.length < PATH_SAMPLE_MAX)
    entry.paths.push(req.path);
}

function reportJson(
  stats: Stats,
  cfg: TollboothConfig,
  reporter?: ReceiptReporter,
) {
  const price = Number(cfg.toll.price_usd);
  return {
    mode: cfg.mode,
    humans_passed: stats.humansPassed,
    free_path_hits: stats.freePathHits,
    receipts_queued: reporter?.queued ?? 0,
    receipts_dropped: reporter?.dropped ?? 0,
    agents: [...stats.agents.entries()].map(([key, s]) => ({
      key,
      kind: s.kind,
      ua: s.ua,
      requests: s.requests,
      paths: s.paths,
      robots_txt_fetched: stats.robotsUAs.has(s.ua),
      // an estimate, not a ledger: requests x configured price
      would_have_paid_usd: (s.requests * price).toFixed(4),
    })),
  };
}

export function tollbooth(options: TollboothOptions): MiddlewareHandler {
  const cfg =
    typeof options.config === "string"
      ? parseConfig(options.config)
      : options.config;
  const stats: Stats = {
    agents: new Map(),
    humansPassed: 0,
    freePathHits: 0,
    robotsUAs: new Set(),
  };
  const ledger = new OfferLedger(cfg.limits.agent_ledger_max);
  const jtiCache = new JtiCache(cfg.limits.jti_lru_max);
  const fetchDirectory = options.fetchDirectory ?? makeDirectoryFetcher();
  const { x402, stripe, siteKeys, maze } = options;
  const reporter =
    options.reporter ??
    (cfg.report && cfg.report_url !== undefined
      ? new ReceiptReporter({ url: cfg.report_url, domain: cfg.report_domain })
      : undefined);

  const offerResponse = (
    c: Context,
    decision: Decision & { action: "offer" },
  ) => {
    // The adapter owns the x402 payment-required headers (D-7); this layer
    // owns the machine-readable body and the Link header to the Stripe
    // option (AC-2.1).
    if (x402 && cfg.toll.x402.enabled) {
      const { headers } = x402.buildOffer(cfg, c.req.path);
      for (const [name, value] of Object.entries(headers))
        c.header(name, value);
    }
    if (cfg.toll.stripe.enabled)
      c.header(
        "link",
        `<${cfg.toll.stripe.payment_link}>; rel="payment"; title="stripe-voucher"`,
      );
    return c.json(decision.body, 402);
  };

  return async (c, next) => {
    if (c.req.path === REPORT_PATH && c.req.method === "GET") {
      if (cfg.report_token === "") return c.text("Not Found", 404);
      if (c.req.header("authorization") !== `Bearer ${cfg.report_token}`)
        return c.text("Unauthorized", 401);
      return c.json(reportJson(stats, cfg, reporter));
    }
    if (stripe && c.req.path === WEBHOOK_PATH && c.req.method === "POST") {
      const result = await stripe.handleWebhook(
        await c.req.text(),
        c.req.header("stripe-signature"),
      );
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      stripe &&
      c.req.method === "GET" &&
      c.req.path.startsWith(VOUCHER_PATH_PREFIX)
    ) {
      const page = stripe.redeem(c.req.path.slice(VOUCHER_PATH_PREFIX.length));
      return new Response(page.body, {
        status: page.status,
        headers: { "content-type": page.contentType },
      });
    }

    if (
      maze &&
      (c.req.path === cfg.maze.prefix ||
        c.req.path.startsWith(`${cfg.maze.prefix}/`))
    ) {
      const page = await maze(c.req.path);
      return new Response(page.body, {
        status: page.status,
        headers: page.headers,
      });
    }

    const req = requestFromContext(c);
    const nowS = options.nowS?.();
    // Spending deps only in toll mode: observe must never mutate voucher
    // state or burn replay counts.
    const spendDeps: Partial<PipelineDeps> =
      cfg.mode === "toll"
        ? {
            ledger,
            jtiCache,
            ...(siteKeys ? { siteKeys } : {}),
            ...(x402
              ? {
                  verifyPayment: (p: string) =>
                    x402.verifyProof(
                      p,
                      cfg,
                      nowS !== undefined ? { nowS } : {},
                    ),
                }
              : {}),
          }
        : {};
    const decision = await decide(req, cfg, {
      fetchDirectory,
      ...spendDeps,
      ...(nowS !== undefined ? { nowS } : {}),
    });
    record(stats, req, decision, cfg.limits.agent_ledger_max);

    // Receipt emission (AC-6.3): sign-and-enqueue in the background, gated
    // on report=true - the request never waits and never fails on this.
    if (reporter && siteKeys && cfg.report) {
      const nowSec = nowS ?? Math.floor(Date.now() / 1000);
      const agentKey =
        decision.identity?.kind === "agent" ? decision.identity.agentKey : null;
      const state = agentKey === null ? undefined : ledger.get(agentKey);
      const window = state
        ? {
            count: Math.max(state.offersInWindow, 1),
            windowStartS: Math.floor(state.windowStart / 1000),
            windowEndS: nowSec,
          }
        : { count: 1, windowStartS: nowSec, windowEndS: nowSec };
      const facts = receiptFactsFor(decision, req, window);
      if (facts)
        void buildReceipt(facts, siteKeys)
          .then((receipt) => reporter.enqueue(receipt))
          .catch(() => {});
    }

    if (cfg.mode === "observe") return next();
    if (decision.action === "pass") {
      if (decision.voucher !== undefined)
        c.header("tollbooth-voucher", decision.voucher);
      return next();
    }
    if (decision.action === "offer") return offerResponse(c, decision);
    if (decision.action === "reject")
      return c.json(
        { v: 1 as const, error: `voucher ${decision.reason}` },
        decision.status,
      );
    // decision.action === "consequence" (spoof or toll-ignored): redirect
    // into the maze - decoys are never served at real content URLs (VI.18).
    // Without a maze the safe fallback stays the 402 offer - never a block,
    // never a challenge (Constitution II).
    if (maze && cfg.maze.enabled) {
      c.header("cache-control", "no-store");
      return c.redirect(`${cfg.maze.prefix}/`, 302);
    }
    return c.json({ v: 1 as const, error: "payment required" }, 402);
  };
}
