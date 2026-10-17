import { describe, expect, it } from "vitest";
import { botRanges, ipInRanges } from "../src/botranges.js";
import { parseConfig } from "../src/config.js";
import { decide, type PipelineRequest } from "../src/pipeline.js";
import { dirWith } from "./fixtures/wba.js";

const toll = (extra = "") =>
  parseConfig(`
mode = "toll"
${extra}
[toll.x402]
pay_to = "0xabc"
`);
const OFF = toll();
const SEARCH = toll(`pass_verified = ["search"]`);
const PREVIEW = toll(`pass_verified = ["preview"]`);
const BOTH = toll(`pass_verified = ["search", "preview"]`);
const deps = { fetchDirectory: dirWith() };

// A real Google crawler IP: the first address of a vendored range.
const GOOGLE_V4 = (
  botRanges.google.find((r) => !r.includes(":")) as string
).split("/")[0] as string;

const googlebot: PipelineRequest = {
  path: "/article",
  authority: "example.com",
  method: "GET",
  userAgent:
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  accept: "text/html",
  hasCookies: false,
  clientIp: GOOGLE_V4,
};
const slackbot: PipelineRequest = {
  path: "/article",
  authority: "example.com",
  method: "GET",
  userAgent: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  hasCookies: false,
};

describe("B009 config", () => {
  it("pass_verified defaults to [] and rejects unknown classes", () => {
    expect(parseConfig("").pass_verified).toEqual([]);
    expect(SEARCH.pass_verified).toEqual(["search"]);
    expect(() => parseConfig(`pass_verified = ["all"]`)).toThrowError(
      /pass_verified/,
    );
  });
});

describe("B009 verified search bots", () => {
  it("default config: a Googlebot from a real Google IP still gets the offer", async () => {
    expect(ipInRanges(GOOGLE_V4, botRanges.google)).toBe(true);
    expect((await decide(googlebot, OFF, deps)).action).toBe("offer");
    // "preview" alone does not pass search bots either
    expect((await decide(googlebot, PREVIEW, deps)).action).toBe("offer");
  });

  it('"search" on: the same request passes as verified-search', async () => {
    const d = await decide(googlebot, SEARCH, deps);
    expect(d).toEqual({
      action: "pass",
      reason: "verified-search",
      identity: null,
    });
    // bingbot from a Bing range too
    const bingIp = (botRanges.bing[0] as string).split("/")[0] as string;
    const bing = await decide(
      {
        ...googlebot,
        userAgent: "Mozilla/5.0 (compatible; bingbot/2.0)",
        clientIp: bingIp,
      },
      SEARCH,
      deps,
    );
    expect(bing.action === "pass" && bing.reason).toBe("verified-search");
  });

  it("a spoofed Googlebot UA from a non-Google IP still gets the 402", async () => {
    const d = await decide(
      { ...googlebot, clientIp: "203.0.113.9" },
      BOTH,
      deps,
    );
    expect(d.action).toBe("offer");
  });

  it("a Googlebot UA with no clientIp still gets the 402", async () => {
    const { clientIp: _, ...noIp } = googlebot;
    expect((await decide(noIp, BOTH, deps)).action).toBe("offer");
  });

  it("a Google IP with a non-search UA is not passed", async () => {
    const d = await decide(
      { ...googlebot, userAgent: "curl/8.7.1" },
      SEARCH,
      deps,
    );
    expect(d.action).toBe("offer");
  });

  it("a request with Web Bot Auth headers keeps its normal path", async () => {
    const d = await decide(
      { ...googlebot, signatureAgent: '"https://bot.example"' },
      SEARCH,
      deps,
    );
    expect(d.action).not.toBe("pass");
  });

  it("free paths still win first", async () => {
    const d = await decide({ ...googlebot, path: "/robots.txt" }, SEARCH, deps);
    expect(d.action === "pass" && d.reason).toBe("free-path");
  });
});

describe("B009 preview bots", () => {
  it('Slackbot on an HTML GET passes only with "preview" on', async () => {
    expect((await decide(slackbot, OFF, deps)).action).toBe("offer");
    expect((await decide(slackbot, SEARCH, deps)).action).toBe("offer");
    const d = await decide(slackbot, PREVIEW, deps);
    expect(d.action === "pass" && d.reason).toBe("verified-preview");
    const head = await decide(
      { ...slackbot, method: "HEAD", accept: "text/html,*/*" },
      PREVIEW,
      deps,
    );
    expect(head.action === "pass" && head.reason).toBe("verified-preview");
  });

  it("does not pass API, asset, non-HTML-accept or POST requests", async () => {
    for (const req of [
      { ...slackbot, path: "/api/x.json" },
      { ...slackbot, path: "/logo.png" },
      { ...slackbot, accept: "application/json" },
      { ...slackbot, method: "POST" },
    ])
      expect((await decide(req, PREVIEW, deps)).action).toBe("offer");
  });
});

describe("B009 ipInRanges", () => {
  it("IPv4 boundaries", () => {
    const r = ["192.0.2.0/25"];
    expect(ipInRanges("192.0.2.0", r)).toBe(true);
    expect(ipInRanges("192.0.2.127", r)).toBe(true);
    expect(ipInRanges("192.0.2.128", r)).toBe(false);
    expect(ipInRanges("192.0.1.255", r)).toBe(false);
    expect(ipInRanges("10.1.2.3", ["10.1.2.3/32"])).toBe(true);
    expect(ipInRanges("10.1.2.4", ["10.1.2.3/32"])).toBe(false);
    expect(ipInRanges("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    // IPv4-mapped IPv6, as a dual-stack socket reports it
    expect(ipInRanges("::ffff:192.0.2.5", r)).toBe(true);
    expect(ipInRanges("::ffff:c000:205", r)).toBe(true);
  });

  it("IPv6 boundaries", () => {
    const r = ["2001:4860:4801:10::/64"];
    expect(ipInRanges("2001:4860:4801:10::", r)).toBe(true);
    expect(ipInRanges("2001:4860:4801:10:ffff:ffff:ffff:ffff", r)).toBe(true);
    expect(ipInRanges("2001:4860:4801:11::", r)).toBe(false);
    expect(ipInRanges("2001:4860:4801:f:ffff:ffff:ffff:ffff", r)).toBe(false);
    expect(ipInRanges("2001:DB8::1", ["2001:db8::/127"])).toBe(true);
    expect(ipInRanges("2001:db8::2", ["2001:db8::/127"])).toBe(false);
  });

  it("families never cross and malformed input never matches", () => {
    expect(ipInRanges("192.0.2.1", ["::/0"])).toBe(false);
    expect(ipInRanges("2001:db8::1", ["0.0.0.0/0"])).toBe(false);
    for (const bad of [
      "",
      "1.2.3",
      "1.2.3.256",
      "1.2.3.4.5",
      "x",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "12345::",
    ])
      expect(ipInRanges(bad, ["0.0.0.0/0", "::/0"])).toBe(false);
    expect(ipInRanges("1.2.3.4", ["1.2.3.0/", "1.2.3.0/33", "1.2.3.0"])).toBe(
      false,
    );
  });

  it("the vendored snapshot is dated, sourced and non-empty", () => {
    expect(botRanges.snapshot).toBe("2026-10-17");
    expect(botRanges.sources.google).toMatch(
      /^https:\/\/developers\.google\.com\//,
    );
    expect(botRanges.sources.bing).toMatch(/^https:\/\/www\.bing\.com\//);
    expect(botRanges.google.length).toBeGreaterThan(0);
    expect(botRanges.bing.length).toBeGreaterThan(0);
  });
});
