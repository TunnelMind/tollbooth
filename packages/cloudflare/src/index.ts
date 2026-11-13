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
  isOperatorFault,
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
// Hard limit on one settle call (spec 006 R002, second review M1). Without it
// a settle route that never answers holds the request, its per-payer
// reservation and its `inflight` entry for the life of the isolate. A timeout
// is answered like any other fetch reject: settle-unreachable, not cached,
// not counted. 10 s is judgment, not measured facilitator latency.
const SETTLE_TIMEOUT_MS = 10_000;
// A per-payer reservation older than this no longer counts and is removed
// when next read. It covers the case the timeout cannot: on Workers a client
// disconnect can cancel the request, and then the release in `finally` never
// runs. 30 s = the settle timeout plus a 20 s margin (judgment), so a
// reservation does not expire while its own settle can still be running.
const RESERVATION_TTL_MS = 30_000;
// Operator-fault answers one hold's due pass survives (row A7, R003 L1).
// ponytail: a fixed cap, the owner's choice; make it config if 3 proves wrong.
const DUE_FAULT_LIMIT = 3;
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
 * @internal Exported for tests only; not part of the supported API. So is
 * `_sizes()` on the returned function: the sizes of the per-isolate maps.
 */
export function makeSettlingVerify(
  routedFetch: FetchLike,
  settleUrl: string,
  settleToken: string,
): X402Adapter["verifyProof"] & {
  /** @internal Test hook; not part of the supported API. */
  _sizes(): {
    seen: number;
    payerFails: number;
    notYetValid: number;
    inflight: number;
    payerInflight: number;
  };
} {
  // Keyed `${from}:${nonce}` — the EIP-3009 identity — so a re-encoded copy
  // of the same authorization is still the same payment.
  const seenPayments = new Map<string, string>();
  const payerFails = new Map<string, { n: number; untilMs: number }>();
  // Row 5 rejects, key -> validAfter (epoch s). Answered locally until then,
  // so one early authorization costs one settle call, not one per request.
  // `faults`: operator-fault answers its due attempts have had (row A7).
  const notYetValid = new Map<string, { validAfter: bigint; faults: number }>();
  // Concurrent identical payments share one settle; only the starter passes.
  // The x402 resource is not in the signed EIP-3009 authorization, so sharing
  // ok:true would let one payment sent to many paths unlock all of them.
  const inflight = new Map<string, Promise<X402VerifyResult>>();
  // Settle calls started per payer and not finished (R-O1, spec 006). They
  // count toward PAYER_FAIL_LIMIT with the recorded failures; otherwise a
  // concurrent burst from one payer all passes the cooldown check before the
  // first answer lands, one settle call each. One object per settle call,
  // holding its start time: release removes exactly that object, and one
  // older than RESERVATION_TTL_MS is dropped on read, so a settle whose
  // release never runs cannot lock its payer out (R002 M1). Bounded: a
  // reservation costs a bucket token, so at most SETTLE_BUCKET_CAP +
  // SETTLE_REFILL_PER_S x 30 s = 170 are younger than the limit, and every
  // new one sweeps the older out.
  const payerInflight = new Map<string, { atMs: number }[]>();
  /** The payer's reservations still inside the limit; the rest are removed. */
  const liveReservations = (payer: string, now: number): { atMs: number }[] => {
    const live = (payerInflight.get(payer) ?? []).filter(
      (r) => now - r.atMs < RESERVATION_TTL_MS,
    );
    if (live.length > 0) payerInflight.set(payer, live);
    else payerInflight.delete(payer);
    return live;
  };
  const bucket = { tokens: SETTLE_BUCKET_CAP, atMs: Date.now() };
  const verify: X402Adapter["verifyProof"] = async (
    xPayment,
    cfg,
    opts = {},
  ) => {
    const local = verifyProof(xPayment, cfg, opts);
    if (!local.ok || local.payer === null) return local;
    const payer = local.payer;
    if (settleToken === "")
      return { ok: false, payer: null, reason: "settlement-unconfigured" };
    // verifyProof already proved this decodes to a well-formed authorization.
    // It hashes pad32(hexToBytes(nonce.slice(2))): any 2-char prefix, any
    // leading zeros, any hex case sign the same bytes32. Key on that value.
    // Odd-length hex is rejected there; "" (nonce 0) is not, hence `|| "0"`.
    const { nonce, validAfter } = (
      JSON.parse(atob(xPayment)) as {
        payload: { authorization: { nonce: string; validAfter: string } };
      }
    ).payload.authorization;
    const key = `${payer}:${BigInt(`0x${nonce.slice(2) || "0"}`).toString(16)}`;
    const seen = seenPayments.get(key);
    if (seen !== undefined) return { ok: false, payer: null, reason: seen };
    // Before inflight/cooldown/bucket: no settle call, no token, no count.
    // Same clock as verifyProof (opts.nowS, else wall time).
    const nowS = BigInt(opts.nowS ?? Math.floor(Date.now() / 1000));
    const hold = notYetValid.get(key);
    const early = hold?.validAfter;
    // R-O4 (spec 006): once validAfter has passed, the held payment is "due"
    // and this one attempt goes to settle even if the payer is cooled down.
    // Otherwise an honest payer with a fast clock, cooled down by its own
    // early payments, could never settle them. The entry stays until a
    // bucket token is taken (below), so a throttled due attempt stays due.
    const due = early !== undefined && nowS >= early;
    if (early !== undefined) {
      // Its own reason so core records no offer for it (R004 L-b); hono
      // shows the payer the same "not yet valid" text.
      // retryAfterS: hono turns it into `Retry-After` on this 402 only.
      if (nowS < early)
        return {
          ok: false,
          payer: null,
          reason: "not-yet-valid-held",
          retryAfterS: Number(early - nowS),
        };
    }
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
    // Live failures plus settles in flight. With nothing in flight this is
    // the plain cooldown check. Known cost: an honest payer's 4th concurrent
    // payment is refused too (not cached, so it can be sent again).
    // A due attempt (R-O4) skips this once; its outcome is counted as usual.
    const live = fails && now < fails.untilMs ? fails.n : 0;
    if (!due && live + liveReservations(payer, now).length >= PAYER_FAIL_LIMIT)
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
    // The due pass is spent with the token. Like the reservation below, in
    // the same synchronous run as the checks: a concurrent copy finds no
    // entry and joins `inflight` instead of settling again.
    if (due) notYetValid.delete(key);
    // Reserve in the same synchronous run as the check above: no await
    // between them, so concurrent requests cannot all pass first.
    // ponytail: every new reservation scans the whole map for expired ones
    // (at most 170 entries, see above); keep an age-ordered list if the
    // bucket ever grows by orders of magnitude.
    for (const p of payerInflight.keys()) liveReservations(p, now);
    const reservation = { atMs: now };
    payerInflight.set(payer, [
      ...(payerInflight.get(payer) ?? []),
      reservation,
    ]);
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
          // Fires as a rejected fetch (or body read): the catch below.
          signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
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
        if (resp.ok && data.settled === true) {
          // Settle routes name the on-chain id `transaction` or `tx`. Only a
          // 32-byte hex hash (0x + 64 hex, surrounding whitespace trimmed)
          // counts; `transaction` wins when valid, else a valid `tx` serves.
          const txId =
            [data.transaction, data.tx]
              .map((v) => (typeof v === "string" ? v.trim() : ""))
              .find((v) => /^0x[0-9a-fA-F]{64}$/.test(v)) ?? null;
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
        // FR-001 (spec 003), rows 3a → 3 → 4 → 5 → 6/7, first match wins. An
        // operator fault must not burn the payer's nonce or cooldown: not
        // cached, not counted, so the same X-PAYMENT can be retried once we
        // are healthy.
        // Row 3a (R002 L7): a non-2xx that says settled:true. Money may have
        // moved, so it is neither served nor "retry the same payment", and
        // not the payer's fault: not cached, not counted, no offer in core.
        if (data.settled === true)
          return { ok: false, payer: null, reason: "settle-unconfirmed" };
        // Row 3: the settle route says it is ours (its config, or the
        // facilitator refusing our credentials/rate or failing with a 5xx).
        // core's isOperatorFault is the one classifier (R002 L5), so a reason
        // hono calls "retry the same payment" is never cached here.
        // network-mismatch is ours too (the route's network, not the
        // payment's: verifyProof already checked that); an explicit
        // retryable:true beats the HTTP status.
        if (
          data.retryable === true ||
          reason === "network-mismatch" ||
          isOperatorFault(reason)
        )
          return { ok: false, payer: null, reason: "settle-retryable" };
        // Row 4: the settle route itself is down, refuses our token or rate,
        // or is not there (404/405: a wrong settle.url or method, R002 L1),
        // whatever the body says.
        if (
          resp.status >= 500 ||
          [401, 403, 404, 405, 429].includes(resp.status)
        )
          return { ok: false, payer: null, reason: "settle-retryable" };
        // Row 5: the authorization is not valid yet (payer clock ahead of
        // the chain's). Not cached: the same X-PAYMENT may be retried once
        // valid_after has passed; until then the retry is answered locally
        // (R001, second review L2). Counted toward the payer's cooldown, as
        // on main (R004, second review 2 M1): otherwise fresh early nonces
        // from one payer cost a settle call each. The hold means one count
        // per payment while it is early, and a later successful settle
        // clears the count, so an honest early payment still settles.
        // Offers: this answer records one in core (else a verified agent
        // could attach a fresh early unfunded payment to every request and
        // never be mazed, L6); the held repeats above record none (L-b).
        if (reason.includes("valid_after")) {
          // Held only while still early by our clock. A due attempt never
          // is (R-O4, row A5), so it is not held again and the next retry is
          // an ordinary attempt that meets the cooldown. The same goes for
          // any attempt whose validAfter is already past (facilitator clock
          // behind ours): an entry written then would make the next retry
          // "due", a pass through the cooldown after every ordinary attempt.
          if (BigInt(validAfter) > nowS)
            remember(notYetValid, key, {
              validAfter: BigInt(validAfter),
              faults: 0,
            });
          // Re-read at write time, not the pre-await `fails`: concurrent
          // settles from one payer finish out of order and each must count.
          // The clock too (L2): with the pre-await `now`, a slow settle
          // landing last would end the cooldown early, at its start + 600 s.
          const cur = payerFails.get(payer);
          const t = Date.now();
          remember(payerFails, payer, {
            n: (cur && t < cur.untilMs ? cur.n : 0) + 1,
            untilMs: t + PAYER_COOLDOWN_MS,
          });
          return { ok: false, payer: null, reason: "not-yet-valid" };
        }
        // Row 6 (2xx settled:false) and row 7 (any other non-2xx: a 4xx the
        // client caused, e.g. an oversize or malformed payment) are the
        // payer's: cached for the nonce and counted toward the cooldown.
        // Known cost (R002 L1): the data-api route answers OUR bad price_usd
        // with a 400 too, so that misconfiguration is charged to the payer.
        remember(seenPayments, key, reason);
        // Count and clock re-read at write time, as in row 5.
        const cur = payerFails.get(payer);
        const t = Date.now();
        remember(payerFails, payer, {
          n: (cur && t < cur.untilMs ? cur.n : 0) + 1,
          untilMs: t + PAYER_COOLDOWN_MS,
        });
        return { ok: false, payer: null, reason };
      } catch {
        return { ok: false, payer: null, reason: "settle-unreachable" };
      }
    };
    const p = settle();
    inflight.set(key, p);
    try {
      const result = await p;
      // Row A7: an operator fault ("retry the same payment") must not cost
      // the payer its due pass. Put the hold back, same validAfter, so the
      // retry is the due attempt again. settle-unconfirmed and
      // no-transaction-id are not operator faults: not put back.
      // Bounded (R003 L1): the DUE_FAULT_LIMIT-th operator fault for one hold
      // drops it, so the next retry is an ordinary attempt that meets the
      // cooldown. Otherwise a cooled-down payer with one due hold gets a
      // settle call on every request for as long as the facilitator is down.
      if (
        hold !== undefined &&
        due &&
        !result.ok &&
        isOperatorFault(result.reason) &&
        hold.faults + 1 < DUE_FAULT_LIMIT
      )
        remember(notYetValid, key, { ...hold, faults: hold.faults + 1 });
      return result;
    } finally {
      inflight.delete(key);
      // Release on every outcome; settle() itself never rejects. Only this
      // call's own reservation: if it expired and was swept while the settle
      // ran, there is nothing to remove and the payer's newer ones stay.
      const left = (payerInflight.get(payer) ?? []).filter(
        (r) => r !== reservation,
      );
      if (left.length > 0) payerInflight.set(payer, left);
      else payerInflight.delete(payer);
    }
  };
  return Object.assign(verify, {
    _sizes: () => ({
      seen: seenPayments.size,
      payerFails: payerFails.size,
      notYetValid: notYetValid.size,
      inflight: inflight.size,
      payerInflight: payerInflight.size,
    }),
  });
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
  // The build in progress, if any. Requests that arrive during it await this
  // one promise, so a cold isolate's first burst shares one State (one
  // in-flight map, one bucket, one set of reservations) instead of each
  // request building its own.
  let building: { key: string; p: Promise<State> } | null = null;
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
      let s: State;
      if (state !== null && stateKey === key) {
        s = state;
      } else {
        if (building === null || building.key !== key) {
          const p: Promise<State> = buildState(context.env, toml)
            .then((built) => {
              state = built;
              stateKey = key;
              return built;
            })
            // Settled either way, the entry goes: a rejected build is not
            // kept, so the next request builds again.
            .finally(() => {
              if (building?.p === p) building = null;
            });
          building = { key, p };
        }
        s = await building.p;
      }
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
