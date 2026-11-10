// A001: the arrival reading — every field fareseal read for this request,
// and whether any of it is kept.
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_KEPT_SCOPE,
  arrivalReading,
  keptFor,
  LEDGER,
  REQUEST_HEADERS_READ,
} from "../src/arrival.js";
import type { Decision, PipelineRequest } from "../src/pipeline.js";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const browser: PipelineRequest = {
  path: "/page",
  authority: "example.com",
  method: "GET",
  scheme: "https",
  userAgent: CHROME,
  accept: "text/html",
  hasCookies: true,
  secFetchSite: "none",
};
const human: Decision = {
  action: "pass",
  reason: "human",
  identity: { kind: "human" },
};

const curl: PipelineRequest = {
  path: "/data",
  authority: "example.com",
  method: "GET",
  scheme: "https",
  userAgent: "curl/8.0",
  hasCookies: false,
  payment: "secret-payment",
  voucher: "secret-voucher",
  signature: "sig1=:abc:",
  signatureInput: 'sig1=();keyid="k"',
  signatureAgent:
    "https://agent.example/.well-known/http-message-signatures-directory",
};
const anon: Decision = {
  action: "consequence",
  reason: "toll-ignored",
  identity: {
    kind: "anonymous-agent",
    via: ["ua-prefix:curl/", "accept-no-html"],
  },
};

const row = (r: ReturnType<typeof arrivalReading>, name: string) => {
  const found = r.rows.find((x) => x.name === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
};

describe("arrivalReading", () => {
  it("a human browser request keeps nothing", () => {
    const r = arrivalReading(browser, human);
    expect(r.rows.every((x) => x.kept === "no")).toBe(true);
    expect(r.identity).toEqual({
      kind: "human",
      via: "heuristics",
      matched: [],
    });
    expect(r.decision).toEqual({ type: "pass", reason: "human" });
    expect(row(r, "user-agent").value).toBe(CHROME);
    expect(row(r, "user-agent").used_for).toContain("512");
    expect(row(r, "x-payment")).toMatchObject({
      value: null,
      read: "presence only",
    });
  });

  it("an anon:<ua> agent request names the ledger for ua and path", () => {
    const r = arrivalReading(curl, anon);
    expect(row(r, "user-agent").kept).toBe("agent ledger (ua, count, paths)");
    expect(row(r, "path").kept).toBe("agent ledger (ua, count, paths)");
    for (const x of r.rows)
      if (x.name !== "user-agent" && x.name !== "path")
        expect(x.kept).toBe("no");
    expect(r.identity).toEqual({
      kind: "anonymous-agent",
      via: "heuristics",
      matched: ["ua-prefix:curl/", "accept-no-html"],
    });
    expect(r.decision).toEqual({ type: "consequence", reason: "toll-ignored" });
  });

  it("never echoes payment, voucher or signature values", () => {
    const r = arrivalReading(curl, anon);
    for (const name of [
      "x-payment",
      "fareseal-voucher",
      "tollbooth-voucher",
      "signature",
      "signature-input",
    ])
      expect(row(r, name)).toMatchObject({
        value: null,
        read: "presence only",
      });
    const json = JSON.stringify(r);
    for (const s of ["secret-payment", "secret-voucher", "abc", "keyid"])
      expect(json).not.toContain(s);
    expect(row(r, "signature-agent").value).toBe(curl.signatureAgent);
  });

  it("a cookie is read for presence only, its value never", () => {
    expect(row(arrivalReading(browser, human), "cookie")).toMatchObject({
      value: null,
      read: "presence only",
    });
  });

  it("the body is one row: not read, not kept", () => {
    const bodies = arrivalReading(browser, human).rows.filter(
      (x) => x.name === "body",
    );
    expect(bodies).toEqual([
      {
        name: "body",
        value: null,
        read: "not read",
        used_for: "nothing",
        kept: "no",
        present: false,
      },
    ]);
  });

  it("lists never_read and handles a free-path decision", () => {
    const r = arrivalReading(browser, {
      action: "pass",
      reason: "free-path",
      identity: null,
    });
    expect(r.never_read).toEqual([
      "cookie value",
      "request body",
      "country",
      "asn",
      "request.cf",
    ]);
    expect(r.identity).toEqual({ kind: null, via: null, matched: [] });
    expect(r.rows.every((x) => x.kept === "no")).toBe(true);
  });

  it("is deterministic", () => {
    expect(arrivalReading(curl, anon)).toEqual(arrivalReading(curl, anon));
  });

  it("has exactly one row per parsed header and per non-header field", () => {
    const names = arrivalReading(browser, human).rows.map((x) => x.name);
    for (const h of [
      ...REQUEST_HEADERS_READ,
      "method",
      "path",
      "scheme",
      "client_ip",
      "body",
    ])
      expect(names.filter((n) => n === h)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  // A005: `kept` follows keptFor, record()'s own classification.
  it("a verified search pass keeps a counter only, never the ledger", () => {
    const googlebot: PipelineRequest = {
      ...browser,
      userAgent:
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    };
    for (const reason of ["verified-search", "verified-preview"] as const) {
      const r = arrivalReading(googlebot, {
        action: "pass",
        reason,
        identity: null,
      });
      expect(row(r, "path").kept).toBe("counter only");
      expect(row(r, "user-agent").kept).toBe("counter only");
      for (const x of r.rows) expect(["no", "counter only"]).toContain(x.kept);
    }
  });

  it("an ordinary decision sets kept apart from the reported decision", () => {
    const freePath: Decision = {
      action: "pass",
      reason: "free-path",
      identity: anon.identity,
    };
    const r = arrivalReading(curl, freePath, { identity: anon.identity });
    expect(row(r, "path").kept).toBe(LEDGER);
    expect(r.decision).toEqual({ type: "pass", reason: "free-path" });
    expect(
      arrivalReading(browser, human, {
        identity: { kind: "human" },
      }).rows.every((x) => x.kept === "no"),
    ).toBe(true);
  });

  it("keptFor follows record()'s branch order", () => {
    const agent = { kind: "agent", agentKey: "k" } as const;
    expect(keptFor({ reason: "free-path", identity: agent })).toBe("no");
    expect(keptFor({ reason: "verified-search", identity: null })).toBe(
      "counter only",
    );
    expect(keptFor({ identity: null })).toBe("no");
    expect(keptFor(human)).toBe("no");
    expect(keptFor(anon)).toBe(LEDGER);
    expect(keptFor({ identity: agent })).toBe(LEDGER);
    expect(
      keptFor({
        reason: "spoof",
        identity: { kind: "spoofer", claimedKey: null, claimedKeyId: null },
      }),
    ).toBe(LEDGER);
  });

  it("says what every kept describes", () => {
    expect(arrivalReading(curl, anon).kept_scope).toBe(
      "an ordinary request like this one; this arrival request itself is never recorded",
    );
    expect(arrivalReading(browser, human).kept_scope).toBe(ARRIVAL_KEPT_SCOPE);
  });
});

// A009: every row reports the presence fareseal observed; presence-only rows
// still never echo a value.
describe("arrivalReading present", () => {
  const PRESENCE_ONLY = [
    "cookie",
    "signature",
    "signature-input",
    "x-payment",
    "fareseal-voucher",
    "tollbooth-voucher",
  ];

  it("every row has a boolean present", () => {
    for (const r of [
      arrivalReading(browser, human),
      arrivalReading(curl, anon),
    ])
      for (const x of r.rows) expect(typeof x.present).toBe("boolean");
  });

  it("presence-only rows: present follows what was sent, value stays null", () => {
    // curl sends the four proofs and no cookie; the browser the reverse.
    const sent = { cookie: false, rest: true };
    for (const [req, d, proofs] of [
      [curl, anon, sent.rest],
      [browser, human, !sent.rest],
    ] as const) {
      const r = arrivalReading(req, d);
      for (const name of PRESENCE_ONLY)
        expect(row(r, name)).toMatchObject({
          value: null,
          read: "presence only",
          present: name === "cookie" ? req.hasCookies : proofs,
        });
      const json = JSON.stringify(r);
      for (const s of ["secret-payment", "secret-voucher", "abc", "keyid"])
        expect(json).not.toContain(s);
    }
  });

  it("cookie present is the request's hasCookies (what the heuristics read)", () => {
    for (const hasCookies of [true, false])
      expect(
        row(arrivalReading({ ...browser, hasCookies }, human), "cookie")
          .present,
      ).toBe(hasCookies);
  });

  it("value rows: present iff a value was read; empty user-agent is not sent", () => {
    const r = arrivalReading(curl, anon);
    for (const name of ["accept", "sec-fetch-site", "client_ip"])
      expect(row(r, name).present).toBe(false);
    for (const name of ["method", "path", "host", "scheme", "signature-agent"])
      expect(row(r, name).present).toBe(true);
    expect(row(r, "user-agent").present).toBe(true);
    expect(
      row(arrivalReading({ ...curl, userAgent: "" }, anon), "user-agent")
        .present,
    ).toBe(false);
    expect(row(arrivalReading(browser, human), "accept").present).toBe(true);
    expect(row(r, "body").present).toBe(false);
  });
});
