// A001: the arrival reading — every field tollbooth read for this request,
// and whether any of it is kept.
import { describe, expect, it } from "vitest";
import { arrivalReading, REQUEST_HEADERS_READ } from "../src/arrival.js";
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
});
