/**
 * @tunnelmindai/fareseal-cloudflare — batteries-included Cloudflare Pages middleware.
 *
 * One import, config in, tolling out (ADR-004): per-isolate state cache,
 * seeded maze corpus, receipt reporting + signed traffic snapshots, and
 * settle-then-serve x402 with facilitator damping. The middleware as a
 * whole fails OPEN — any thrown runtime error serves the site untolled —
 * while settlement fails CLOSED: a payment that does not settle on-chain
 * never yields content.
 *
 * Two things do NOT fail open (2.0.0, TunnelMind spec 088):
 *   - a missing outbound route. If `binding` names a service binding that is
 *     absent from env, or outbound reporting is configured with neither
 *     `binding` nor `fetch`, construction throws FaresealBindingMissingError
 *     before any request is issued. There is no implicit global fetch — the
 *     1.x fallback posted test-suite snapshots into production.
 *   - the environment marker. Every outbound write carries
 *     `x-fareseal-env` (and the legacy `x-tollbooth-env`): `production` unless a test runner is detectable
 *     (VITEST / NODE_ENV=test / a vitest worker) or FARESEAL_ENV says
 *     otherwise. A collector refuses anything but `production`.
 *
 * Env contract (read at state build; a changed value rebuilds the state):
 *   (each also read under its pre-rename TOLLBOOTH_ name; FARESEAL_ wins)
 *   FARESEAL_SITE_KEY      base64url ed25519 seed — signs receipts and
 *                           snapshots; reporting is off without it.
 *   FARESEAL_SETTLE_TOKEN  bearer for the settle endpoint; settlement is
 *                           off (payments fail closed) without it.
 *   FARESEAL_FLUSH_INTERVAL_MS  optional snapshot cadence override.
 *   FARESEAL_ENV           optional explicit environment marker; anything
 *                           other than "production" is sent verbatim and
 *                           refused by the collector.
 * Your `config` builder may read any further vars of its own (report
 * tokens, prices) — its output is part of the cache key.
 */
import { buildOffer, verifyProof } from "@tunnelmindai/fareseal-adapter-x402";
import {
  ConfigError,
  canonicalize,
  type FaresealConfig,
  fromBase64Url,
  mazePrefixes,
  parseConfig,
  publicKeyOf,
  ReceiptReporter,
  readEnv,
  type SiteKeyPair,
  sign,
  toBase64Url,
} from "@tunnelmindai/fareseal-core";
import {
  fareseal,
  type X402Adapter,
  type X402VerifyResult,
} from "@tunnelmindai/fareseal-hono";
import {
  corpusFromMap,
  generateCorpus,
  makeMazeHandler,
} from "@tunnelmindai/fareseal-maze";
import { Hono } from "hono";
import { FaresealBindingMissingError } from "./errors.js";

export {
  FaresealBindingMissingError,
  TollboothBindingMissingError,
} from "./errors.js";

const REPORT_PATH = "/_fareseal/report";
const LEGACY_REPORT_PATH = "/_tollbooth/report"; // alias, removed in 3.0.0
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
export const ENV_HEADER = "x-fareseal-env";
/** Pre-rename marker header, sent beside ENV_HEADER; removed in 3.0.0. */
export const ENV_HEADER_LEGACY = "x-tollbooth-env";

// Facilitator damping (ADR-004): signing a well-formed payment costs an
// attacker nothing, relaying it costs the operator facilitator quota. Capped
// maps, oldest-out — eviction is amnesty (Constitution I).
const DAMP_CAP = 512;
const PAYER_FAIL_LIMIT = 3;
const PAYER_COOLDOWN_MS = 600_000;
// ponytail: per-isolate bucket on facilitator calls, not a global budget —
// N isolates spend N × this; move to a Durable Object if that ever matters.
export const SETTLE_BUCKET_CAP = 20;
const SETTLE_REFILL_PER_S = 5;
// Paths are attacker-chosen, so the per-isolate exists cache must be bounded.
const EXISTS_CAP = 1024;

export interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  next: () => Response | Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
}
export type PagesMiddleware = (context: PagesContext) => Promise<Response>;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareFaresealOptions {
  /**
   * fareseal TOML, or a builder over env for values that live in vars and
   * secrets (report token, price). The built text is the state-cache key, so
   * changing any env var it reads rebuilds the toll on the next request.
   */
  config: string | ((env: Record<string, unknown>) => string);
  /** Deterministic maze corpus, generated once per state build (D-5). */
  corpus?: { seed: string; pages?: number };
  /**
   * Settle-then-serve: every locally-valid x402 payment is POSTed here
   * ({ payment, price_usd }, bearer FARESEAL_SETTLE_TOKEN) and passes ONLY
   * on `{ data: { settled: true } }`. Omit to keep payments verify-only —
   * in which case they still never pass here (fail closed by absence).
   */
  settle?: { url: string };
  /** Periodic signed traffic snapshots (requires FARESEAL_SITE_KEY). */
  snapshots?: { url: string; intervalMs?: number };
  /**
   * Env key of a service binding to carry settle/report/snapshot POSTs —
   * on Cloudflare a same-zone self-fetch 522s, so a binding is the reliable
   * route. When named it MUST be present in env with a fetch(); otherwise
   * construction throws FaresealBindingMissingError. No global-fetch fallback.
   */
  binding?: string;
  /**
   * An explicit fetcher for outbound POSTs when there is no service binding
   * (tests: a recording stub; non-Cloudflare hosts: your own client). Ignored
   * when `binding` is set. Never defaulted to the global fetch.
   */
  fetch?: FetchLike;
  /**
   * `"assets"`: before a toll-mode offer, HEAD the path on the Pages static
   * asset binding (`env.ASSETS`) and answer a plain 404 — no offer, no
   * charge — when it returns 404. Answers are cached per isolate (bounded,
   * oldest-out); a throwing check is not cached and falls through to the
   * offer. When set, env.ASSETS MUST have a fetch(); otherwise construction
   * throws FaresealBindingMissingError.
   */
  exists?: "assets";
}

interface State {
  app: Hono<{ Bindings: { NEXT: () => Response | Promise<Response> } }>;
  cfg: FaresealConfig;
  siteKeys: SiteKeyPair | null;
  sitePub: string | null;
  routedFetch: FetchLike | null;
  envMarker: string;
  reporting: boolean;
  settling: boolean;
}

const remember = <K, V>(map: Map<K, V>, k: K, v: V, cap = DAMP_CAP): void => {
  map.set(k, v);
  if (map.size > cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
};

/**
 * Is a test runner detectable from inside this module? True under vitest
 * (VITEST=1 or a worker global), or NODE_ENV=test. On the Pages runtime
 * (workerd) `process` is undefined, so a real deployment reads as not-a-test.
 */
export function testRunnerDetected(): boolean {
  const g = globalThis as Record<string, unknown>;
  const p = g.process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  if (p?.env?.VITEST) return true;
  if (p?.env?.NODE_ENV === "test") return true;
  if (g.__vitest_worker__ !== undefined) return true;
  return false;
}

/**
 * The environment marker every outbound write carries (spec 088, analyze C1):
 * `production` unless a test runner is detected or FARESEAL_ENV says
 * otherwise. A site that installs the package and sets nothing writes as
 * production — open ingest survives — while every vitest run is refused.
 */
export function faresealEnvMarker(env: Record<string, unknown>): string {
  const explicit = readEnv(env, "ENV");
  if (explicit !== "") return explicit;
  return testRunnerDetected() ? "test" : "production";
}

/** Wrap a fetcher so every outbound request carries the environment marker. */
function tagged(fetchFn: FetchLike, marker: string): FetchLike {
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set(ENV_HEADER, marker);
    headers.set(ENV_HEADER_LEGACY, marker);
    return fetchFn(url, { ...init, headers });
  };
}

/**
 * Local verifyProof (fast, free reject), then settle over the routed fetch.
 * Passes ONLY on a successful settle; never throws into the pipeline.
 * Transport/config failures are the operator's own and never damp a payer.
 * @internal Exported for tests only; not part of the supported API.
 */
export function makeSettlingVerify(
  routedFetch: FetchLike,
  settleUrl: string,
  settleToken: string,
): X402Adapter["verifyProof"] {
  // Keyed `${from}:${nonce}` — the EIP-3009 identity — so a re-encoded copy
  // of the same authorization is still the same payment.
  const seenPayments = new Map<string, string>();
  const payerFails = new Map<string, { n: number; untilMs: number }>();
  // Concurrent identical payments share one settle; only the starter passes.
  // The x402 resource is not in the signed EIP-3009 authorization, so sharing
  // ok:true would let one payment sent to many paths unlock all of them.
  const inflight = new Map<string, Promise<X402VerifyResult>>();
  const bucket = { tokens: SETTLE_BUCKET_CAP, atMs: Date.now() };
  return async (xPayment, cfg, opts = {}) => {
    const local = verifyProof(xPayment, cfg, opts);
    if (!local.ok || local.payer === null) return local;
    const payer = local.payer;
    if (settleToken === "")
      return { ok: false, payer: null, reason: "settlement-unconfigured" };
    // verifyProof already proved this decodes to a well-formed authorization.
    // It hashes pad32(hexToBytes(nonce.slice(2))): any 2-char prefix, any
    // leading zeros, any hex case sign the same bytes32. Key on that value.
    // Odd-length hex is rejected there; "" (nonce 0) is not, hence `|| "0"`.
    const nonce = (
      JSON.parse(atob(xPayment)) as {
        payload: { authorization: { nonce: string } };
      }
    ).payload.authorization.nonce;
    const key = `${payer}:${BigInt(`0x${nonce.slice(2) || "0"}`).toString(16)}`;
    const seen = seenPayments.get(key);
    if (seen !== undefined) return { ok: false, payer: null, reason: seen };
    const pending = inflight.get(key);
    if (pending !== undefined) {
      const leader = await pending;
      return {
        ok: false,
        payer: null,
        reason: leader.ok ? "already-settled" : leader.reason,
      };
    }
    const now = Date.now();
    const fails = payerFails.get(payer);
    if (fails && fails.n >= PAYER_FAIL_LIMIT && now < fails.untilMs)
      return { ok: false, payer: null, reason: "payer-cooldown" };
    bucket.tokens = Math.min(
      SETTLE_BUCKET_CAP,
      bucket.tokens + ((now - bucket.atMs) / 1000) * SETTLE_REFILL_PER_S,
    );
    bucket.atMs = now;
    // The operator's own limit, not the payer's fault: no damping, no cache.
    if (bucket.tokens < 1)
      return { ok: false, payer: null, reason: "settle-throttled" };
    bucket.tokens -= 1;
    const settle = async (): Promise<X402VerifyResult> => {
      try {
        const resp = await routedFetch(settleUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${settleToken}`,
          },
          body: JSON.stringify({
            payment: xPayment,
            price_usd: cfg.toll.price_usd,
            // The data-api settle route pins the resource today
            // (tollbooth-settle.js:42); carried for the adr-x402v2 follow-up,
            // because the Bazaar indexes by resource. Omitted when absent so
            // older callers' bodies stay byte-identical.
            ...(typeof opts.resource === "string"
              ? { resource: opts.resource }
              : {}),
          }),
        });
        // A non-2xx body may not parse (a proxy's HTML 502); it is still
        // classified by status below. A 2xx that fails to parse throws, as
        // before, into settle-unreachable.
        const body = (await (resp.ok
          ? resp.json()
          : resp.json().catch(() => null))) as {
          data?: Record<string, unknown>;
        } | null;
        const data = body?.data ?? {};
        if (data.settled === true) {
          // Settle routes name the on-chain id `transaction` or `tx`;
          // `transaction` wins when both are present.
          const txId =
            typeof data.transaction === "string" && data.transaction !== ""
              ? data.transaction
              : typeof data.tx === "string" && data.tx !== ""
                ? data.tx
                : null;
          if (txId === null) {
            // A settle we cannot point the payer at is not proof of payment.
            // Remember it (the nonce may be spent; never settle it twice), but
            // leave payerFails alone: a malformed answer is not the payer's
            // fault.
            remember(seenPayments, key, "no-transaction-id");
            return { ok: false, payer: null, reason: "no-transaction-id" };
          }
          remember(seenPayments, key, "already-settled"); // EIP-3009 nonces are single-use
          payerFails.delete(payer);
          return {
            ok: true,
            payer: typeof data.payer === "string" ? data.payer : payer,
            // Surfaced to the payer in X-PAYMENT-RESPONSE.
            transaction: txId,
          };
        }
        const reason =
          typeof data.reason === "string" ? data.reason : "settle-failed";
        // An operator fault (non-2xx settle, our config, our facilitator's
        // 5xx) must not burn the payer's nonce or cooldown: not cached, not
        // counted, so the same X-PAYMENT can be retried once we are healthy.
        if (
          !resp.ok ||
          data.retryable === true ||
          reason === "settlement-not-configured" ||
          reason === "network-mismatch" ||
          reason.startsWith("verify-error:") ||
          reason.startsWith("settle-error:") ||
          /^(verify|settle)-failed\(5\d\d\)$/.test(reason)
        )
          return { ok: false, payer: null, reason: "settle-retryable" };
        remember(seenPayments, key, reason);
        remember(payerFails, payer, {
          n: (fails && now < fails.untilMs ? fails.n : 0) + 1,
          untilMs: now + PAYER_COOLDOWN_MS,
        });
        return { ok: false, payer: null, reason };
      } catch {
        return { ok: false, payer: null, reason: "settle-unreachable" };
      }
    };
    const p = settle();
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  };
}

/**
 * Resolve the outbound route, or throw. Called at state build, which runs on
 * the first request — before any outbound call can happen (the first
 * outbound call is a settle or a snapshot flush, both after the state exists).
 */
function resolveRoutedFetch(
  opts: CloudflareFaresealOptions,
  env: Record<string, unknown>,
  needsFetch: boolean,
): FetchLike | null {
  if (opts.binding !== undefined) {
    const binding = env[opts.binding] as
      | { fetch: (req: Request) => Promise<Response> }
      | undefined;
    if (!binding || typeof binding.fetch !== "function") {
      throw new FaresealBindingMissingError(opts.binding, Object.keys(env));
    }
    // Call fetch as a method: workerd throws `Illegal invocation` when a
    // service binding's fetch runs without the binding as `this`.
    // https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors
    return (url, init) => binding.fetch(new Request(url, init));
  }
  if (opts.fetch !== undefined) return opts.fetch;
  if (needsFetch) throw new FaresealBindingMissingError(null, Object.keys(env));
  return null; // nothing outbound is configured; nothing to route
}

/**
 * The `exists: "assets"` check over the Pages static asset binding, or throw
 * when the binding is missing. Built per state, so a rebuilt state gets a
 * fresh binding and an empty cache. A rejected fetch is left to propagate:
 * the hono layer treats it as "exists" (today's offer) and nothing is cached.
 */
function makeAssetsExists(
  env: Record<string, unknown>,
): (path: string) => Promise<boolean> {
  const assets = env.ASSETS as
    | { fetch: (req: Request) => Promise<Response> }
    | undefined;
  if (!assets || typeof assets.fetch !== "function")
    throw new FaresealBindingMissingError("ASSETS", Object.keys(env));
  const cache = new Map<string, boolean>();
  return async (path) => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    // Concatenate rather than resolve: `new URL("//x/y", base)` would treat a
    // leading `//` as a host and check `/y` instead of the requested path.
    const resp = await assets.fetch(
      new Request(`https://assets.internal${path}`, { method: "HEAD" }),
    );
    const found = resp.status !== 404;
    remember(cache, path, found, EXISTS_CAP);
    return found;
  };
}

/** The Pages middleware: `export const onRequest = createPagesMiddleware({...})`. */
export function createPagesMiddleware(
  opts: CloudflareFaresealOptions,
): PagesMiddleware {
  let state: State | null = null;
  let stateKey: string | null = null;
  let isolateId: string | null = null;
  let seq = 0;
  let lastFlushMs = 0;

  async function buildState(
    env: Record<string, unknown>,
    toml: string,
  ): Promise<State> {
    const cfg = parseConfig(toml);
    const seed = readEnv(env, "SITE_KEY");
    const settleToken = readEnv(env, "SETTLE_TOKEN");
    const envMarker = faresealEnvMarker(env);

    let siteKeys: SiteKeyPair | null = null;
    let sitePub: string | null = null;
    if (seed !== "") {
      const secret = fromBase64Url(seed);
      const pub = await publicKeyOf(secret);
      siteKeys = { secret, pub };
      sitePub = toBase64Url(pub);
    }
    const reportUrl = cfg.report && cfg.report_url ? cfg.report_url : null;
    const reporting = Boolean(siteKeys && reportUrl);

    // Anything that would POST needs a route; resolve (or throw) BEFORE wiring it.
    // Snapshots post only when reporting does, so they add no case here.
    const needsFetch = reporting || opts.settle !== undefined;
    const raw = resolveRoutedFetch(opts, env, needsFetch);
    const routedFetch = raw === null ? null : tagged(raw, envMarker);
    const exists = opts.exists === "assets" ? makeAssetsExists(env) : null;

    const reporter =
      siteKeys && reportUrl && routedFetch
        ? new ReceiptReporter({
            url: reportUrl,
            domain: cfg.report_domain,
            fetchFn: routedFetch as typeof fetch,
            // No sleep loop on Workers: the isolate may be frozen between
            // requests, so each request flushes inside its own waitUntil.
            autoFlush: false,
          })
        : undefined;

    const maze =
      cfg.maze.enabled && opts.corpus
        ? makeMazeHandler({
            corpus: corpusFromMap(
              generateCorpus({
                seed: opts.corpus.seed,
                pages: opts.corpus.pages ?? 256,
                pageBytesMax: cfg.maze.page_bytes_max,
              }),
            ),
            cfg,
          })
        : undefined;

    const settling = Boolean(opts.settle && settleToken !== "");
    const app = new Hono<{
      Bindings: {
        NEXT: () => Response | Promise<Response>;
        WAIT_UNTIL?: ((p: Promise<unknown>) => void) | null;
      };
    }>();
    app.use(
      fareseal({
        config: cfg,
        // Cloudflare's edge sets this header; clients cannot forge it on Workers.
        clientIp: (c) => c.req.header("cf-connecting-ip"),
        ...(opts.settle && routedFetch
          ? {
              x402: {
                buildOffer,
                verifyProof: makeSettlingVerify(
                  routedFetch,
                  opts.settle.url,
                  settleToken,
                ),
                // Passes only on a settled payment (an empty token fails
                // closed), so mainnet is allowed.
                settles: true,
              },
            }
          : {}),
        ...(maze ? { maze } : {}),
        ...(siteKeys ? { siteKeys } : {}),
        ...(reporter ? { reporter } : {}),
        ...(exists ? { exists } : {}),
      }),
    );
    app.all("*", (c) => c.env.NEXT());
    return {
      app,
      cfg,
      siteKeys,
      sitePub,
      routedFetch,
      envMarker,
      reporting,
      settling,
    };
  }

  async function flushSnapshot(s: State, url: string): Promise<void> {
    if (!s.reporting || !s.siteKeys || !s.routedFetch) return;
    const resp = await s.app.fetch(
      new Request(`https://fareseal.internal${REPORT_PATH}`, {
        headers: { authorization: `Bearer ${s.cfg.report_token}` },
      }),
      { NEXT: () => new Response("", { status: 404 }) },
    );
    if (resp.status !== 200) return;
    const report = (await resp.json()) as {
      humans_passed: number;
      free_path_hits: number;
      agents?: unknown[];
    };
    isolateId ??= crypto.randomUUID();
    seq += 1;
    const unsigned = {
      v: 1,
      kind: "tollbooth-observe-snapshot",
      site: s.sitePub,
      isolate_id: isolateId,
      seq,
      taken_at: new Date().toISOString(),
      humans_passed: report.humans_passed,
      free_path_hits: report.free_path_hits,
      agents: (report.agents ?? []).slice(0, 100),
    };
    const sig = toBase64Url(
      await sign(canonicalize(unsigned), s.siteKeys.secret),
    );
    await s.routedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(s.cfg.report_domain
          ? {
              "x-fareseal-domain": s.cfg.report_domain,
              "x-tollbooth-domain": s.cfg.report_domain, // alias, 3.0.0
            }
          : {}),
      },
      body: JSON.stringify({ ...unsigned, sig }),
    });
  }

  return async (context) => {
    try {
      const toml =
        typeof opts.config === "string"
          ? opts.config
          : opts.config(context.env);
      const key = [
        toml,
        readEnv(context.env, "SITE_KEY") ? "k" : "",
        readEnv(context.env, "SETTLE_TOKEN") ? "s" : "",
        opts.binding !== undefined && context.env[opts.binding] ? "b" : "",
        readEnv(context.env, "ENV"),
      ].join("|");
      if (state === null || stateKey !== key) {
        state = await buildState(context.env, toml);
        stateKey = key;
      }
      const s = state;
      const resp = await s.app.fetch(context.request, {
        NEXT: () => context.next(),
        // null (not undefined) tells the hono layer a receipt here would be
        // lost, so it counts the drop instead of queuing into a frozen isolate.
        WAIT_UNTIL:
          typeof context.waitUntil === "function"
            ? (p: Promise<unknown>) => context.waitUntil?.(p)
            : null,
      });

      const path = new URL(context.request.url).pathname;
      if (
        (path === REPORT_PATH || path === LEGACY_REPORT_PATH) &&
        resp.status === 200
      ) {
        const out = new Response(resp.body, resp);
        out.headers.set("x-fareseal-mode", s.cfg.mode);
        out.headers.set("x-tollbooth-mode", s.cfg.mode);
        out.headers.set("x-fareseal-reporting", String(s.reporting));
        out.headers.set("x-tollbooth-reporting", String(s.reporting));
        out.headers.set("x-fareseal-settling", String(s.settling));
        out.headers.set("x-tollbooth-settling", String(s.settling));
        out.headers.set("x-fareseal-env", s.envMarker);
        out.headers.set("x-tollbooth-env", s.envMarker);
        return out;
      }

      if (
        opts.snapshots &&
        s.reporting &&
        typeof context.waitUntil === "function"
      ) {
        const interval = Number(
          readEnv(context.env, "FLUSH_INTERVAL_MS") ||
            (opts.snapshots.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS),
        );
        const now = Date.now();
        if (
          !path.startsWith("/_fareseal") &&
          !path.startsWith("/_tollbooth") &&
          !mazePrefixes(s.cfg.maze.prefix).some((p) => path.startsWith(p)) &&
          now - lastFlushMs >= interval
        ) {
          lastFlushMs = now;
          const url = opts.snapshots.url;
          context.waitUntil(
            flushSnapshot(s, url).catch((e) =>
              console.error("fareseal snapshot flush failed:", e),
            ),
          );
        }
      }
      return resp;
    } catch (err) {
      // A missing outbound route or an invalid config (e.g. a misspelled
      // [toll.x402] network) is an operator error, not a runtime one: it must
      // surface (a red suite, a failed request), never serve the site
      // untolled in silence.
      if (err instanceof FaresealBindingMissingError) throw err;
      if (err instanceof ConfigError) throw err;
      console.error("fareseal middleware failed open:", err);
      return context.next();
    }
  };
}

/** @deprecated renamed CloudflareFaresealOptions on 2026-11-10; removed in 3.0.0 */
export type CloudflareTollboothOptions = CloudflareFaresealOptions;

/** @deprecated renamed faresealEnvMarker on 2026-11-10; removed in 3.0.0 */
export const tollboothEnvMarker = faresealEnvMarker;
