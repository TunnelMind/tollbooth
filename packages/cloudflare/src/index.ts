/**
 * @tollbooth/cloudflare — batteries-included Cloudflare Pages middleware.
 *
 * One import, config in, tolling out (ADR-004): per-isolate state cache,
 * seeded maze corpus, receipt reporting + signed traffic snapshots, and
 * settle-then-serve x402 with facilitator damping. The middleware as a
 * whole fails OPEN — any thrown error serves the site untolled — while
 * settlement fails CLOSED: a payment that does not settle on-chain never
 * yields content.
 *
 * Env contract (read at state build; a changed value rebuilds the state):
 *   TOLLBOOTH_SITE_KEY      base64url ed25519 seed — signs receipts and
 *                           snapshots; reporting is off without it.
 *   TOLLBOOTH_SETTLE_TOKEN  bearer for the settle endpoint; settlement is
 *                           off (payments fail closed) without it.
 *   TOLLBOOTH_FLUSH_INTERVAL_MS  optional snapshot cadence override.
 * Your `config` builder may read any further vars of its own (report
 * tokens, prices) — its output is part of the cache key.
 */
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { generateCorpus } from "@tollbooth/cli";
import {
  canonicalize,
  fromBase64Url,
  parseConfig,
  publicKeyOf,
  ReceiptReporter,
  type SiteKeyPair,
  sign,
  type TollboothConfig,
  toBase64Url,
} from "@tollbooth/core";
import { tollbooth, type X402Adapter } from "@tollbooth/hono";
import { corpusFromMap, makeMazeHandler } from "@tollbooth/maze";
import { Hono } from "hono";

const REPORT_PATH = "/_tollbooth/report";
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

// Facilitator damping (ADR-004): signing a well-formed payment costs an
// attacker nothing, relaying it costs the operator facilitator quota. Capped
// maps, oldest-out — eviction is amnesty (Constitution I).
const DAMP_CAP = 512;
const PAYER_FAIL_LIMIT = 3;
const PAYER_COOLDOWN_MS = 600_000;

export interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  next: () => Response | Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
}
export type PagesMiddleware = (context: PagesContext) => Promise<Response>;

export interface CloudflareTollboothOptions {
  /**
   * tollbooth TOML, or a builder over env for values that live in vars and
   * secrets (report token, price). The built text is the state-cache key, so
   * changing any env var it reads rebuilds the toll on the next request.
   */
  config: string | ((env: Record<string, unknown>) => string);
  /** Deterministic maze corpus, generated once per state build (D-5). */
  corpus?: { seed: string; pages?: number };
  /**
   * Settle-then-serve: every locally-valid x402 payment is POSTed here
   * ({ payment, price_usd }, bearer TOLLBOOTH_SETTLE_TOKEN) and passes ONLY
   * on `{ data: { settled: true } }`. Omit to keep payments verify-only —
   * in which case they still never pass here (fail closed by absence).
   */
  settle?: { url: string };
  /** Periodic signed traffic snapshots (requires TOLLBOOTH_SITE_KEY). */
  snapshots?: { url: string; intervalMs?: number };
  /**
   * Env key of a service binding to carry settle/report/snapshot POSTs —
   * on Cloudflare a same-zone self-fetch 522s, so a binding is the reliable
   * route. Falls back to global fetch when unset or absent from env.
   */
  binding?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface State {
  app: Hono<{ Bindings: { NEXT: () => Response | Promise<Response> } }>;
  cfg: TollboothConfig;
  siteKeys: SiteKeyPair | null;
  sitePub: string | null;
  routedFetch: FetchLike;
  reporting: boolean;
  settling: boolean;
}

const str = (env: Record<string, unknown>, key: string): string =>
  typeof env[key] === "string" ? (env[key] as string).trim() : "";

const remember = <K, V>(map: Map<K, V>, k: K, v: V): void => {
  map.set(k, v);
  if (map.size > DAMP_CAP) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
};

/**
 * Local verifyProof (fast, free reject), then settle over the routed fetch.
 * Passes ONLY on a successful settle; never throws into the pipeline.
 * Transport/config failures are the operator's own and never damp a payer.
 */
function makeSettlingVerify(
  routedFetch: FetchLike,
  settleUrl: string,
  settleToken: string,
): X402Adapter["verifyProof"] {
  const seenPayments = new Map<string, string>();
  const payerFails = new Map<string, { n: number; untilMs: number }>();
  return async (xPayment, cfg, opts = {}) => {
    const local = verifyProof(xPayment, cfg, opts);
    if (!local.ok || local.payer === null) return local;
    const payer = local.payer;
    if (settleToken === "")
      return { ok: false, payer: null, reason: "settlement-unconfigured" };
    const seen = seenPayments.get(xPayment);
    if (seen !== undefined) return { ok: false, payer: null, reason: seen };
    const now = Date.now();
    const fails = payerFails.get(payer);
    if (fails && fails.n >= PAYER_FAIL_LIMIT && now < fails.untilMs)
      return { ok: false, payer: null, reason: "payer-cooldown" };
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
        }),
      });
      const data =
        ((await resp.json()) as { data?: Record<string, unknown> })?.data ?? {};
      if (data.settled === true) {
        remember(seenPayments, xPayment, "already-settled"); // EIP-3009 nonces are single-use
        payerFails.delete(payer);
        return {
          ok: true,
          payer: typeof data.payer === "string" ? data.payer : payer,
        };
      }
      const reason =
        typeof data.reason === "string" ? data.reason : "settle-failed";
      remember(seenPayments, xPayment, reason);
      remember(payerFails, payer, {
        n: (fails && now < fails.untilMs ? fails.n : 0) + 1,
        untilMs: now + PAYER_COOLDOWN_MS,
      });
      return { ok: false, payer: null, reason };
    } catch {
      return { ok: false, payer: null, reason: "settle-unreachable" };
    }
  };
}

/** The Pages middleware: `export const onRequest = createPagesMiddleware({...})`. */
export function createPagesMiddleware(
  opts: CloudflareTollboothOptions,
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
    const seed = str(env, "TOLLBOOTH_SITE_KEY");
    const settleToken = str(env, "TOLLBOOTH_SETTLE_TOKEN");
    const binding =
      opts.binding !== undefined
        ? (env[opts.binding] as { fetch?: unknown } | undefined)
        : undefined;
    const routedFetch: FetchLike =
      binding && typeof binding.fetch === "function"
        ? (url, init) =>
            (binding.fetch as (req: Request) => Promise<Response>)(
              new Request(url, init),
            )
        : (url, init) => fetch(url, init);

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
    const reporter =
      siteKeys && reportUrl
        ? new ReceiptReporter({
            url: reportUrl,
            domain: cfg.report_domain,
            fetchFn: routedFetch as typeof fetch,
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
      Bindings: { NEXT: () => Response | Promise<Response> };
    }>();
    app.use(
      tollbooth({
        config: cfg,
        ...(opts.settle
          ? {
              x402: {
                buildOffer,
                verifyProof: makeSettlingVerify(
                  routedFetch,
                  opts.settle.url,
                  settleToken,
                ),
              },
            }
          : {}),
        ...(maze ? { maze } : {}),
        ...(siteKeys ? { siteKeys } : {}),
        ...(reporter ? { reporter } : {}),
      }),
    );
    app.all("*", (c) => c.env.NEXT());
    return { app, cfg, siteKeys, sitePub, routedFetch, reporting, settling };
  }

  async function flushSnapshot(s: State, url: string): Promise<void> {
    if (!s.reporting || !s.siteKeys) return;
    const resp = await s.app.fetch(
      new Request(`https://tollbooth.internal${REPORT_PATH}`, {
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
          ? { "x-tollbooth-domain": s.cfg.report_domain }
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
        str(context.env, "TOLLBOOTH_SITE_KEY") ? "k" : "",
        str(context.env, "TOLLBOOTH_SETTLE_TOKEN") ? "s" : "",
        opts.binding !== undefined && context.env[opts.binding] ? "b" : "",
      ].join("|");
      if (state === null || stateKey !== key) {
        state = await buildState(context.env, toml);
        stateKey = key;
      }
      const s = state;
      const resp = await s.app.fetch(context.request, {
        NEXT: () => context.next(),
      });

      const path = new URL(context.request.url).pathname;
      if (path === REPORT_PATH && resp.status === 200) {
        const out = new Response(resp.body, resp);
        out.headers.set("x-tollbooth-mode", s.cfg.mode);
        out.headers.set("x-tollbooth-reporting", String(s.reporting));
        out.headers.set("x-tollbooth-settling", String(s.settling));
        return out;
      }

      if (
        opts.snapshots &&
        s.reporting &&
        typeof context.waitUntil === "function"
      ) {
        const interval = Number(
          str(context.env, "TOLLBOOTH_FLUSH_INTERVAL_MS") ||
            (opts.snapshots.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS),
        );
        const now = Date.now();
        if (
          !path.startsWith("/_tollbooth") &&
          !path.startsWith(s.cfg.maze.prefix) &&
          now - lastFlushMs >= interval
        ) {
          lastFlushMs = now;
          const url = opts.snapshots.url;
          context.waitUntil(
            flushSnapshot(s, url).catch((e) =>
              console.error("tollbooth snapshot flush failed:", e),
            ),
          );
        }
      }
      return resp;
    } catch (err) {
      console.error("tollbooth middleware failed open:", err);
      return context.next();
    }
  };
}
