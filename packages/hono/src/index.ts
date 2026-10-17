// SPDX-License-Identifier: MIT
// @tollbooth/hono: thin binding of core's decide() to Hono. One package
// covers Node, Bun and Workers, so nothing here may import node builtins.
// Observe mode computes the decision and records it but always passes -
// and gets no spending deps, so it can never mutate voucher state.
import {
  buildOfferBody,
  buildReceipt,
  type Decision,
  decide,
  type FetchDirectory,
  JtiCache,
  type OfferBody,
  OfferLedger,
  type PipelineDeps,
  type PipelineRequest,
  parseConfig,
  type ReceiptFacts,
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
  ): { headers: Record<string, string>; requirement?: object };
  verifyProof(
    xPayment: string,
    cfg: TollboothConfig,
    opts?: { nowS?: number },
  ): X402VerifyResult | Promise<X402VerifyResult>;
  /**
   * True when a pass means the payment settled on-chain, not just that its
   * signature checked out. Required on mainnet (anything but base-sepolia).
   */
  settles?: boolean;
}

export interface X402VerifyResult {
  ok: boolean;
  payer: string | null;
  reason?: string;
  /** On-chain transaction hash, when a settling verifier has one. */
  transaction?: string;
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
  /**
   * Trusted client IP for `pass_verified = ["search"]`. No default: without
   * it the search pass fails closed. Supply a source you trust (e.g. the
   * socket address on Node or Bun); @tollbooth/cloudflare wires
   * cf-connecting-ip itself.
   */
  clientIp?: (c: Context) => string | undefined;
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
  /** B009 opt-in passes: their own class, neither human nor agent. */
  verifiedSearchPassed: number;
  verifiedPreviewPassed: number;
  freePathHits: number;
  robotsUAs: Set<string>;
  /** Approximate retained size of `agents` (key + ua + paths, in chars). */
  bytes: number;
}

const PATH_SAMPLE_MAX = 20;
const ROBOTS_UA_MAX = 1000;
// Bounded memory: headers and paths are attacker-sized, so every recorded
// copy is capped. The UA is cut at intake (no rule matches past 512 chars of
// a real UA); the path is cut only where it is recorded, because decide()
// needs the full raw path for free-path matching and the WBA "@path" check.
const UA_MAX = 512;
const PATH_MAX = 256;
// SPOOF aggregation (B007): one receipt per claimed key per window, a
// bounded number of pending buckets, and the attacker-chosen strings in a
// SPOOF receipt cut tighter than the intake cap.
const SPOOF_WINDOW_S = 60;
const SPOOF_BUCKETS_MAX = 1000;
const SPOOF_FIELD_MAX = 128;
// The entry cap alone would still let 50k entries of max-size UA + paths
// pin ~300 MB; this budget evicts oldest-first long before that.
const AGENT_STATS_MAX_BYTES = 1_000_000;

const DIRECTORY_MAX_BYTES = 65536;

export interface DirectoryFetcherOptions {
  /** Positive cache lifetime (default 1h). */
  ttlMs?: number;
  /** LRU cap for each of the positive and negative caches (default 256). */
  maxEntries?: number;
  /** How long a failed fetch is remembered per URL (default 5 min). */
  negativeTtlMs?: number;
  /** New origins this isolate may fetch from per minute (default 20). */
  originsPerMin?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * In-memory, LRU-capped cache over the WBA key-directory fetch. The URL comes
 * from the attacker-controlled Signature-Agent header, so every request could
 * otherwise make us fetch anywhere: https only, no redirects (a redirect
 * could land on http or an internal host), a byte cap enforced while
 * streaming, failures remembered for negativeTtlMs, and a per-minute budget
 * of origins we have never fetched from. Cache hits cost nothing.
 * redirect is "manual", not "error": workerd throws on "error", and the !ok
 * check refuses the 3xx (or status-0 opaqueredirect) without following it.
 */
export function makeDirectoryFetcher(
  opts: DirectoryFetcherOptions = {},
): FetchDirectory {
  const {
    ttlMs = 3_600_000,
    maxEntries = 256,
    negativeTtlMs = 300_000,
    originsPerMin = 20,
    fetchImpl = fetch,
    now = Date.now,
  } = opts;
  const cache = new Map<string, { at: number; jwks: unknown }>();
  const failures = new Map<string, { at: number; err: unknown }>();
  let windowStart = now();
  const windowOrigins = new Set<string>();
  const put = <V>(m: Map<string, V>, k: string, v: V) => {
    m.delete(k);
    if (m.size >= maxEntries) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
    m.set(k, v);
  };
  // ponytail: linear scan of both caches (<= 2 x maxEntries keys); keep an
  // origin index if maxEntries ever grows large.
  const knownOrigin = (origin: string) => {
    for (const k of cache.keys()) if (new URL(k).origin === origin) return true;
    for (const k of failures.keys())
      if (new URL(k).origin === origin) return true;
    return false;
  };

  return async (url) => {
    const t = now();
    const hit = cache.get(url);
    if (hit && t - hit.at < ttlMs) return hit.jwks;
    const failed = failures.get(url);
    if (failed && t - failed.at < negativeTtlMs) throw failed.err;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("directory URL invalid");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("directory URL must be https");
    }
    if (t - windowStart >= 60_000) {
      windowStart = t;
      windowOrigins.clear();
    }
    const origin = parsed.origin;
    if (!windowOrigins.has(origin) && !knownOrigin(origin)) {
      // Not negative-cached: a spent budget says nothing about this URL.
      if (windowOrigins.size >= originsPerMin) {
        throw new Error("directory new-origin budget exhausted");
      }
      windowOrigins.add(origin);
    }

    try {
      const resp = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "user-agent": "tollbooth-wba-verifier/0.0" },
      });
      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`directory fetch ${resp.status}`);
      }
      if (Number(resp.headers.get("content-length")) > DIRECTORY_MAX_BYTES) {
        await resp.body?.cancel();
        throw new Error("directory exceeds 64KB cap");
      }
      const jwks: unknown = JSON.parse(await readCapped(resp));
      put(cache, url, { at: now(), jwks });
      failures.delete(url);
      return jwks;
    } catch (err) {
      put(failures, url, { at: now(), err });
      throw err;
    }
  };
}

/** Reads the body as text, cancelling the stream once it passes the cap. */
async function readCapped(resp: Response): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > DIRECTORY_MAX_BYTES) {
      await reader.cancel();
      throw new Error("directory exceeds 64KB cap");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function requestFromContext(
  c: Context,
  clientIpOf?: (c: Context) => string | undefined,
): PipelineRequest {
  // No default source: headers like cf-connecting-ip or x-forwarded-for are
  // client-forgeable unless a known edge sets them, so only the caller can
  // say which is trustworthy. Without options.clientIp the search pass fails
  // closed; @tollbooth/cloudflare passes cf-connecting-ip explicitly.
  const clientIp = clientIpOf?.(c);
  const url = new URL(c.req.url);
  const header = (name: string) => c.req.header(name);
  return {
    // Raw (still %-encoded) pathname: c.req.path is decoded, which would break
    // a WBA "@path" signature made over the wire bytes and free-path matching.
    path: url.pathname,
    authority: header("host") ?? url.host,
    method: c.req.method,
    scheme: url.protocol.replace(":", ""),
    userAgent: (header("user-agent") ?? "").slice(0, UA_MAX),
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
    ...(clientIp !== undefined ? { clientIp } : {}),
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
  if (decision.action === "pass" && decision.reason === "verified-search") {
    stats.verifiedSearchPassed += 1;
    return;
  }
  if (decision.action === "pass" && decision.reason === "verified-preview") {
    stats.verifiedPreviewPassed += 1;
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
    if (stats.agents.size >= cap) evictOldest(stats);
    entry = { kind: identity.kind, ua: req.userAgent, requests: 0, paths: [] };
    stats.agents.set(key, entry);
    stats.bytes += key.length + entry.ua.length;
  }
  entry.requests += 1;
  const path = req.path.slice(0, PATH_MAX);
  if (!entry.paths.includes(path) && entry.paths.length < PATH_SAMPLE_MAX) {
    entry.paths.push(path);
    stats.bytes += path.length;
  }
  // Byte budget, oldest first; the current entry is always kept (it is the
  // newest unless it was an existing one; ua + 20 paths keep it near 6 KB).
  while (stats.bytes > AGENT_STATS_MAX_BYTES && stats.agents.size > 1) {
    if (stats.agents.keys().next().value === key) break;
    evictOldest(stats);
  }
}

function evictOldest(stats: Stats): void {
  const oldest = stats.agents.entries().next().value;
  if (oldest === undefined) return;
  const [key, s] = oldest;
  stats.agents.delete(key);
  stats.bytes -= key.length + s.ua.length;
  for (const p of s.paths) stats.bytes -= p.length;
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
    verified_search_passed: stats.verifiedSearchPassed,
    verified_preview_passed: stats.verifiedPreviewPassed,
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

/**
 * Constant-time bearer check. Hashing both sides first gives two 32-byte
 * digests, so neither the length nor a matching prefix of the secret leaks
 * through response timing; the XOR loop then never exits early. WebCrypto
 * only, so this stays runtime-neutral (Node, Bun, Workers).
 */
async function bearerMatches(
  got: string | undefined,
  want: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(got ?? "")),
    crypto.subtle.digest("SHA-256", enc.encode(want)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return got !== undefined && diff === 0;
}

export function tollbooth(options: TollboothOptions): MiddlewareHandler {
  const cfg =
    typeof options.config === "string"
      ? parseConfig(options.config)
      : options.config;
  // A verify-only adapter accepts a signed authorization that may never be
  // collected (replayed, or the payer's balance moved): fine on a testnet,
  // real lost money on mainnet. Refuse at startup, not per request.
  if (
    options.x402 &&
    cfg.toll.x402.enabled &&
    cfg.toll.x402.network !== "base-sepolia" &&
    !options.x402.settles
  )
    throw new Error(
      `verify-only x402 adapter refused on mainnet (network "${cfg.toll.x402.network}"): use a settling verifier or base-sepolia`,
    );
  const stats: Stats = {
    agents: new Map(),
    humansPassed: 0,
    verifiedSearchPassed: 0,
    verifiedPreviewPassed: 0,
    freePathHits: 0,
    robotsUAs: new Set(),
    bytes: 0,
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
  // Pending SPOOF buckets, keyed by the (capped) claimed key; null is the
  // "no key claimed" bucket. Insertion order is window-start order.
  const spoofBuckets = new Map<string | null, ReceiptFacts>();

  const offerResponse = (c: Context, body: OfferBody) => {
    // The adapter owns the x402 payment-required headers (D-7); this layer
    // owns the machine-readable body and the Link header to the Stripe
    // option (AC-2.1). The body carries both dialects: x402 v1 clients read
    // x402Version/error/accepts, older tollbooth clients read v/price_usd/
    // options - no key is shared, so each ignores the other's fields.
    let x402Body = {};
    if (x402 && cfg.toll.x402.enabled) {
      // Absolute, without the fragment: x402 v1 clients sign for this URL.
      const url = new URL(c.req.url);
      const { headers, requirement } = x402.buildOffer(
        cfg,
        `${url.origin}${url.pathname}${url.search}`,
      );
      for (const [name, value] of Object.entries(headers))
        c.header(name, value);
      if (requirement)
        x402Body = {
          x402Version: 1,
          error: "X-PAYMENT header is required",
          accepts: [requirement],
        };
    }
    if (cfg.toll.stripe.enabled)
      c.header(
        "link",
        `<${cfg.toll.stripe.payment_link}>; rel="payment"; title="stripe-voucher"`,
      );
    // An offer is per-request (price, payment state): never cache a 402.
    c.header("cache-control", "no-store");
    return c.json({ ...body, ...x402Body }, 402);
  };

  const handler = async (c: Context, next: () => Promise<void>) => {
    if (c.req.path === REPORT_PATH && c.req.method === "GET") {
      if (cfg.report_token === "") return c.text("Not Found", 404);
      if (
        !(await bearerMatches(
          c.req.header("authorization"),
          `Bearer ${cfg.report_token}`,
        ))
      )
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

    const req = requestFromContext(c, options.clientIp);
    const nowS = options.nowS?.();
    // The verify result for this request, kept for X-PAYMENT-RESPONSE.
    let payment: X402VerifyResult | undefined;
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
                  verifyPayment: async (p: string) => {
                    payment = await x402.verifyProof(
                      p,
                      cfg,
                      nowS !== undefined ? { nowS } : {},
                    );
                    return payment;
                  },
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
      const facts = receiptFactsFor(
        decision,
        { userAgent: req.userAgent, path: req.path.slice(0, PATH_MAX) },
        window,
      );
      // A runtime that kills background work after the response (Workers)
      // hands us WAIT_UNTIL on c.env: the chain then flushes inside it. null
      // means "Workers, but no waitUntil" - the receipt cannot survive, so it
      // is counted as dropped. Absent (node/bun) keeps the fire-and-forget
      // path and the reporter's own flush loop.
      const waitUntil = (
        c.env as
          | { WAIT_UNTIL?: ((p: Promise<unknown>) => void) | null }
          | undefined
      )?.WAIT_UNTIL;
      const emit = (f: ReceiptFacts) => {
        if (waitUntil === null) return reporter.noteDropped();
        const work = buildReceipt(f, siteKeys)
          .then((receipt) => reporter.enqueue(receipt))
          .catch(() => reporter.noteDropped());
        if (typeof waitUntil === "function") {
          try {
            waitUntil(work.then(() => reporter.flush()));
          } catch {
            reporter.noteDropped();
          }
        } else void work;
      };
      // SPOOF is unauthenticated: anyone can claim any key. The commons must
      // never attribute a SPOOF receipt to the claimed key; it is evidence of
      // an attack naming that key, not of that key's conduct. So spoofs are
      // aggregated per claimed key per SPOOF_WINDOW_S into ONE receipt with a
      // count - 1,000 junk signatures naming a key are one receipt, not a
      // thousand rows framing it. The bucket keeps the first request's facts.
      // ponytail: buckets emit lazily on the next SPOOF request (any key), so
      // a bucket with no later spoof traffic stays pending until the process
      // restarts; upgrade path = a timer, or a flush at shutdown.
      if (facts?.type === "SPOOF") {
        for (const [k, b] of spoofBuckets) {
          if (nowSec - b.windowStartS < SPOOF_WINDOW_S) break;
          spoofBuckets.delete(k);
          emit(b);
        }
        const claimed =
          typeof facts.claimedKey === "string"
            ? facts.claimedKey.slice(0, SPOOF_FIELD_MAX)
            : null;
        let bucket = spoofBuckets.get(claimed);
        if (bucket && nowSec - bucket.windowStartS >= SPOOF_WINDOW_S) {
          spoofBuckets.delete(claimed);
          emit(bucket);
          bucket = undefined;
        }
        if (bucket) {
          bucket.count += 1;
          bucket.windowEndS = Math.max(bucket.windowEndS, nowSec);
        } else {
          // Full: emit the oldest bucket early rather than lose its count.
          if (spoofBuckets.size >= SPOOF_BUCKETS_MAX) {
            const [k, b] = spoofBuckets.entries().next().value as [
              string | null,
              ReceiptFacts,
            ];
            spoofBuckets.delete(k);
            emit(b);
          }
          spoofBuckets.set(claimed, {
            ...facts,
            claimedKey: claimed,
            ua: facts.ua.replace(/\p{Cc}/gu, "").slice(0, SPOOF_FIELD_MAX),
            count: 1,
            windowStartS: nowSec,
            windowEndS: nowSec,
          });
        }
      } else if (facts) emit(facts);
    }

    if (cfg.mode === "observe") return next();
    if (decision.action === "pass") {
      if (decision.voucher !== undefined)
        c.header("tollbooth-voucher", decision.voucher);
      await next();
      // x402 v1 settlement receipt. A local-only verifier has no on-chain
      // transaction, so `transaction` is "" there.
      if (decision.reason === "paid" && payment?.ok)
        c.header(
          "x-payment-response",
          btoa(
            JSON.stringify({
              success: true,
              transaction: payment.transaction ?? "",
              network: cfg.toll.x402.network,
              payer: payment.payer,
            }),
          ),
        );
      return;
    }
    if (decision.action === "offer") return offerResponse(c, decision.body);
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
    return offerResponse(c, buildOfferBody(cfg));
  };

  // Fail open (Constitution II: never block on our own fault). A throw from
  // tollbooth's own logic (decide, verify, record, receipts, offers) hands
  // the request to the origin instead of a 500. Errors from the origin, i.e.
  // after next() was called, propagate as before - and next() runs once.
  return async (c, next) => {
    let passed = false;
    const once = () => {
      passed = true;
      return next();
    };
    try {
      return await handler(c, once);
    } catch (err) {
      if (passed) throw err;
      return next();
    }
  };
}
