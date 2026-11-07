// SPDX-License-Identifier: MIT
// The arrival reading: for one request, every field tollbooth read, what it
// read it for, and whether anything of it is kept. It is the requester's own
// data shown back to them, so it is pure — no clock, no counters, no I/O —
// and the same request always reads the same.
import type { Decision, Identity, PipelineRequest } from "./pipeline.js";

/**
 * Every header name the bindings' request parser reads (`requestFromContext`
 * in @tunnelmindai/tollbooth-hono). It lives here because hono and cloudflare both depend
 * on core; hono's parser test checks its `header("…")` reads against this
 * list, and the arrival test checks each name has exactly one row — so the
 * reading cannot drift from what is actually parsed.
 */
export const REQUEST_HEADERS_READ = [
  "host",
  "user-agent",
  "accept",
  "cookie",
  "sec-fetch-site",
  "signature",
  "signature-input",
  "signature-agent",
  "x-payment",
  "tollbooth-voucher",
] as const;

// "counter only": a verified search/preview pass bumps its own counter and
// keeps nothing else. Humans and free paths read "no" (the humans counter is
// shared and keeps nothing of the request).
export type ArrivalKept =
  | "no"
  | "counter only"
  | "agent ledger (ua, count, paths)";

export interface ArrivalRow {
  name: string;
  value: string | null;
  read: "value" | "presence only" | "not read";
  used_for: string;
  kept: ArrivalKept;
  /** Whether this request sent the field — the presence tollbooth observed. */
  present: boolean;
}

export interface ArrivalReading {
  rows: ArrivalRow[];
  identity: {
    kind: Identity["kind"] | null;
    /** How the identity was reached; null when the decision skipped identify. */
    via: "web-bot-auth" | "heuristics" | null;
    /** The rule / verification strings behind it (identity.via); [] when none. */
    matched: string[];
  };
  decision: { type: Decision["action"]; reason: string | null };
  never_read: string[];
  /** What every `kept` describes: always ARRIVAL_KEPT_SCOPE. */
  kept_scope: typeof ARRIVAL_KEPT_SCOPE;
}

export const LEDGER = "agent ledger (ua, count, paths)" satisfies ArrivalKept;

/** identity.via marker for a signed request read on the arrival route,
 *  which never fetches the signer's directory (see the hono route). */
export const SIGNATURE_UNVERIFIED =
  "signature present; not verified on this route (no directory fetch)";

export const ARRIVAL_KEPT_SCOPE =
  "an ordinary request like this one; this arrival request itself is never recorded";

/**
 * What record() in @tunnelmindai/tollbooth-hono keeps for a request with this decision, in
 * record()'s own branch order. record() gates its agent ledger on this, so the
 * reading and the ledger cannot drift. Takes any Decision; the arrival route
 * also passes `{ identity }` alone for "identified, not a verified pass".
 */
export function keptFor(decision: {
  reason?: string;
  identity: Identity | null;
}): ArrivalKept {
  // The free-path and verified-* reasons only ever occur on a pass.
  // ponytail: free-path /robots.txt also adds the UA to a capped robots set;
  // the kept vocabulary has no word for it, so it reads "no".
  if (decision.reason === "free-path") return "no";
  if (
    decision.reason === "verified-search" ||
    decision.reason === "verified-preview"
  )
    return "counter only";
  if (decision.identity === null || decision.identity.kind === "human")
    return "no";
  return LEDGER;
}

/**
 * `decision` is what the reading reports as this request's decision. `ordinary`
 * is what an ordinary request like this one would get, and sets `kept` on the
 * path and user-agent rows (the only fields a ledger entry stores); it
 * defaults to `decision`. The arrival route passes both, because the arrival
 * request itself is a free path and never recorded.
 */
export function arrivalReading(
  req: PipelineRequest,
  decision: Decision,
  ordinary: Parameters<typeof keptFor>[0] = decision,
): ArrivalReading {
  const identity = decision.identity;
  const kept = keptFor(ordinary);
  const opt = (v: string | undefined) => v ?? null;
  // The signature pair, the x402 payment and the voucher carry proofs of
  // payment or possession: echoing them back would put a bearer-like secret in
  // a response that proxies and logs may keep. Presence only: the value stays
  // null whether or not this request sent one, like the cookie row, and
  // `present` reports what was observed ("not read" is kept for what is never
  // read at all, the body).
  const secret = (
    name: string,
    used_for: string,
    present: boolean,
  ): ArrivalRow => ({
    name,
    value: null,
    read: "presence only",
    used_for,
    kept: "no",
    present,
  });
  const valueRow = (
    name: string,
    value: string | null,
    used_for: string,
    rowKept: ArrivalKept = "no",
    present = value !== null,
  ): ArrivalRow => ({
    name,
    value,
    read: "value",
    used_for,
    kept: rowKept,
    present,
  });

  const rows: ArrivalRow[] = [
    valueRow("method", opt(req.method), "Web Bot Auth @method component"),
    valueRow(
      "path",
      req.path,
      "free-path matching, Web Bot Auth @path component",
      kept,
    ),
    valueRow("host", req.authority, "Web Bot Auth @authority component"),
    valueRow("scheme", opt(req.scheme), "Web Bot Auth @scheme component"),
    valueRow(
      "user-agent",
      req.userAgent,
      "agent heuristics, verified search/preview match (value truncated to 512 characters at intake)",
      kept,
      // The parser fills an absent user-agent with "" (requestFromContext).
      req.userAgent !== "",
    ),
    valueRow("accept", opt(req.accept), "agent heuristics (text/html?)"),
    // The cookie value is never read; only whether one was sent feeds the
    // heuristics.
    {
      name: "cookie",
      value: null,
      read: "presence only",
      used_for: "agent heuristics (any cookie sent?)",
      kept: "no",
      // The same field the heuristics read, so the two cannot disagree.
      present: req.hasCookies,
    },
    valueRow(
      "sec-fetch-site",
      opt(req.secFetchSite),
      "agent heuristics (browser fetch metadata)",
    ),
    secret(
      "signature",
      "Web Bot Auth verification",
      req.signature !== undefined,
    ),
    secret(
      "signature-input",
      "Web Bot Auth verification",
      req.signatureInput !== undefined,
    ),
    // signature-agent is a public directory URL, not a secret.
    valueRow(
      "signature-agent",
      opt(req.signatureAgent),
      "Web Bot Auth key directory lookup",
    ),
    secret("x-payment", "x402 payment verification", req.payment !== undefined),
    secret("tollbooth-voucher", "voucher spend", req.voucher !== undefined),
    valueRow(
      "client_ip",
      opt(req.clientIp),
      "verified search bot IP-range check (as injected by the binding)",
    ),
    {
      name: "body",
      value: null,
      read: "not read",
      used_for: "nothing",
      kept: "no",
      // Never read, so nothing of it is observed — not even presence.
      present: false,
    },
  ];

  return {
    rows,
    identity: identityOf(identity),
    decision: {
      type: decision.action,
      reason: "reason" in decision ? decision.reason : null,
    },
    never_read: [
      "cookie value",
      "request body",
      "country",
      "asn",
      "request.cf",
    ],
    kept_scope: ARRIVAL_KEPT_SCOPE,
  };
}

function identityOf(identity: Identity | null): ArrivalReading["identity"] {
  if (identity === null) return { kind: null, via: null, matched: [] };
  switch (identity.kind) {
    case "human":
      return { kind: "human", via: "heuristics", matched: [] };
    case "agent":
    case "spoofer":
      return { kind: identity.kind, via: "web-bot-auth", matched: [] };
    case "anonymous-agent":
      return {
        kind: "anonymous-agent",
        // identify() tags unevaluable WBA claims "wba-<state>", and the
        // arrival route tags signed requests SIGNATURE_UNVERIFIED; anything
        // else is a heuristics rule name.
        via: identity.via.some(
          (v) => v.startsWith("wba-") || v === SIGNATURE_UNVERIFIED,
        )
          ? "web-bot-auth"
          : "heuristics",
        matched: [...identity.via],
      };
  }
}
