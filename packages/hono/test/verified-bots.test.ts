import { botRanges } from "@tollbooth/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { dirWith, NOW } from "../../core/test/fixtures/wba.js";
import { type TollboothOptions, tollbooth } from "../src/index.js";

const CFG = `
mode = "toll"
report_token = "sekrit"
pass_verified = ["search", "preview"]
[toll.x402]
pay_to = "0xabc"
`;
const GOOGLE_V4 = (
  botRanges.google.find((r) => !r.includes(":")) as string
).split("/")[0] as string;
const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// The Workers-style trusted source, as @tollbooth/cloudflare wires it.
const CF_IP: Partial<TollboothOptions> = {
  clientIp: (c) => c.req.header("cf-connecting-ip"),
};

function appWith(config: string, extra: Partial<TollboothOptions> = {}) {
  const app = new Hono();
  app.use(
    tollbooth({ config, fetchDirectory: dirWith(), nowS: () => NOW, ...extra }),
  );
  app.get("*", (c) => c.text("content"));
  return app;
}

async function report(app: Hono) {
  const resp = await app.request("http://example.com/_tollbooth/report", {
    headers: { authorization: "Bearer sekrit" },
  });
  return (await resp.json()) as {
    humans_passed: number;
    verified_search_passed: number;
    verified_preview_passed: number;
    agents: unknown[];
  };
}

describe("B009 hono binding", () => {
  it("with no clientIp the search pass fails closed: cf-connecting-ip is ignored", async () => {
    const app = appWith(CFG);
    const forged = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": GOOGLE_V4 },
    });
    expect(forged.status).toBe(402);
    const xff = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "x-forwarded-for": GOOGLE_V4 },
    });
    expect(xff.status).toBe(402);
  });

  it("passes a Googlebot from a trusted in-range IP; a spoofed IP gets the 402", async () => {
    const app = appWith(CFG, CF_IP);
    const ok = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": GOOGLE_V4 },
    });
    expect(ok.status).toBe(200);
    const spoof = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": "203.0.113.9" },
    });
    expect(spoof.status).toBe(402);
    // x-forwarded-for is not the configured source
    const xff = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "x-forwarded-for": GOOGLE_V4 },
    });
    expect(xff.status).toBe(402);
  });

  it("options.clientIp overrides the trusted source", async () => {
    const app = appWith(CFG, { clientIp: () => GOOGLE_V4 });
    const resp = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": "203.0.113.9" },
    });
    expect(resp.status).toBe(200);
  });

  it("counts verified passes in their own stats class", async () => {
    const app = appWith(CFG, CF_IP);
    await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": GOOGLE_V4 },
    });
    await app.request("http://example.com/b", {
      headers: { "user-agent": "Twitterbot/1.0", accept: "text/html" },
    });
    await app.request("http://example.com/c", {
      headers: { "user-agent": "Discordbot/2.0" },
    });
    const r = await report(app);
    expect(r.verified_search_passed).toBe(1);
    expect(r.verified_preview_passed).toBe(2);
    expect(r.humans_passed).toBe(0);
    expect(r.agents).toEqual([]);
  });

  it("observe mode still passes everything and counts the class", async () => {
    const app = appWith(CFG.replace(`"toll"`, `"observe"`), CF_IP);
    const resp = await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": "203.0.113.9" },
    });
    expect(resp.status).toBe(200);
    await app.request("http://example.com/a", {
      headers: { "user-agent": GOOGLEBOT, "cf-connecting-ip": GOOGLE_V4 },
    });
    const r = await report(app);
    expect(r.verified_search_passed).toBe(1);
    expect(r.agents).toHaveLength(1);
  });
});
