// @tollbooth/hono: thin binding of core's decide() to Hono. One package
// covers Node, Bun and Workers, so nothing here may import node builtins.
// Observe mode computes the decision and records it but always passes;
// toll mode acts on it.
import {
  type Decision,
  decide,
  type FetchDirectory,
  type PipelineRequest,
  parseConfig,
  type TollboothConfig,
} from "@tollbooth/core";
import type { Context, MiddlewareHandler } from "hono";

export interface TollboothOptions {
  /** Parsed config, or TOML source (parsed with the same fail-hard rules). */
  config: TollboothConfig | string;
  /** Override the built-in fetching (tests; custom caching). */
  fetchDirectory?: FetchDirectory;
  /** Injectable clock, epoch seconds. */
  nowS?: () => number;
}

const REPORT_PATH = "/_tollbooth/report";

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

function reportJson(stats: Stats, cfg: TollboothConfig) {
  const price = Number(cfg.toll.price_usd);
  return {
    mode: cfg.mode,
    humans_passed: stats.humansPassed,
    free_path_hits: stats.freePathHits,
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

function offerResponse(
  c: Context,
  decision: Decision & { action: "offer" },
  cfg: TollboothConfig,
) {
  // x402 payment-required headers are the adapter's job (T-009, wired at
  // T-010); this layer owns the machine-readable body and the Link header
  // to the Stripe option (AC-2.1).
  if (cfg.toll.stripe.enabled)
    c.header(
      "link",
      `<${cfg.toll.stripe.payment_link}>; rel="payment"; title="stripe-voucher"`,
    );
  return c.json(decision.body, 402);
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
  const fetchDirectory = options.fetchDirectory ?? makeDirectoryFetcher();

  return async (c, next) => {
    if (c.req.path === REPORT_PATH && c.req.method === "GET") {
      if (cfg.report_token === "") return c.text("Not Found", 404);
      if (c.req.header("authorization") !== `Bearer ${cfg.report_token}`)
        return c.text("Unauthorized", 401);
      return c.json(reportJson(stats, cfg));
    }

    const req = requestFromContext(c);
    const decision = await decide(req, cfg, {
      fetchDirectory,
      ...(options.nowS !== undefined ? { nowS: options.nowS() } : {}),
    });
    record(stats, req, decision, cfg.limits.agent_ledger_max);

    if (cfg.mode === "observe" || decision.action === "pass") return next();
    if (decision.action === "offer") return offerResponse(c, decision, cfg);
    // decision.action === "consequence": the maze lands at T-017; until then
    // the safe interim for a spoofer is the offer — never a block, never a
    // challenge (Constitution II).
    return c.json({ v: 1 as const, error: "payment required" }, 402);
  };
}
