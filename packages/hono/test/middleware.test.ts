import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  dirWith,
  makeAgent,
  NOW,
  signedRequest,
} from "../../core/test/fixtures/wba.js";
import { type TollboothOptions, tollbooth } from "../src/index.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const browserHeaders = { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT };
const curlHeaders = { "user-agent": "curl/8.7.1", accept: "*/*" };

function appWith(config: string, extra: Partial<TollboothOptions> = {}) {
  const app = new Hono();
  app.use(
    tollbooth({ config, fetchDirectory: dirWith(), nowS: () => NOW, ...extra }),
  );
  app.get("*", (c) => c.text("content"));
  return app;
}

describe("US-1 AC-1.1 - observe mode passes everything unmodified", () => {
  it("passes humans and agents alike to the app", async () => {
    const app = appWith("");
    expect(
      await (
        await app.request("http://example.com/a", { headers: browserHeaders })
      ).text(),
    ).toBe("content");
    const agentResp = await app.request("http://example.com/a", {
      headers: curlHeaders,
    });
    expect(agentResp.status).toBe(200);
    expect(await agentResp.text()).toBe("content");
  });
});

describe("US-1 AC-1.1 - the report endpoint", () => {
  it("404s until report_token is set", async () => {
    const app = appWith("");
    expect(
      (await app.request("http://example.com/_tollbooth/report")).status,
    ).toBe(404);
  });

  it("401s a missing or wrong bearer token", async () => {
    const app = appWith(`report_token = "sekrit"`);
    expect(
      (await app.request("http://example.com/_tollbooth/report")).status,
    ).toBe(401);
    expect(
      (
        await app.request("http://example.com/_tollbooth/report", {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });

  it("serves the per-agent summary: counts, paths, robots compliance, estimate", async () => {
    const app = appWith(`report_token = "sekrit"`);
    // curl obeys robots, then crawls twice; a human browses once
    await app.request("http://example.com/robots.txt", {
      headers: curlHeaders,
    });
    await app.request("http://example.com/article-1", { headers: curlHeaders });
    await app.request("http://example.com/article-2", { headers: curlHeaders });
    await app.request("http://example.com/article-1", {
      headers: browserHeaders,
    });

    const resp = await app.request("http://example.com/_tollbooth/report", {
      headers: { authorization: "Bearer sekrit" },
    });
    expect(resp.status).toBe(200);
    const report = (await resp.json()) as {
      mode: string;
      humans_passed: number;
      free_path_hits: number;
      agents: Array<{
        key: string;
        kind: string;
        requests: number;
        paths: string[];
        robots_txt_fetched: boolean;
        would_have_paid_usd: string;
      }>;
    };
    expect(report.mode).toBe("observe");
    expect(report.humans_passed).toBe(1);
    expect(report.free_path_hits).toBe(1);
    expect(report.agents).toHaveLength(1);
    const curl = report.agents[0];
    if (!curl) throw new Error("expected a curl entry");
    expect(curl.kind).toBe("anonymous-agent");
    expect(curl.requests).toBe(2);
    expect(curl.paths.sort()).toEqual(["/article-1", "/article-2"]);
    expect(curl.robots_txt_fetched).toBe(true);
    expect(curl.would_have_paid_usd).toBe("0.0020");
  });

  it("keys verified agents by their WBA public key", async () => {
    const agent = await makeAgent();
    const app = appWith(`report_token = "t"`, {
      fetchDirectory: dirWith(agent.jwk),
    });
    const wba = await signedRequest(agent);
    await app.request("http://example.com/data", {
      headers: {
        ...curlHeaders,
        signature: wba.signature,
        "signature-input": wba.signatureInput,
        "signature-agent": wba.signatureAgent,
      },
    });
    const report = (await (
      await app.request("http://example.com/_tollbooth/report", {
        headers: { authorization: "Bearer t" },
      })
    ).json()) as { agents: Array<{ key: string; kind: string }> };
    expect(report.agents).toEqual([
      expect.objectContaining({ key: agent.jwk.x, kind: "agent" }),
    ]);
  });
});

describe("toll mode acts on the decision", () => {
  const TOLL = `
mode = "toll"
[toll.x402]
pay_to = "0xabc"
`;

  it("passes humans and free paths, 402s agents with the offer body", async () => {
    const app = appWith(TOLL);
    expect(
      (await app.request("http://example.com/a", { headers: browserHeaders }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request("http://example.com/robots.txt", {
          headers: curlHeaders,
        })
      ).status,
    ).toBe(200);

    const resp = await app.request("http://example.com/a", {
      headers: curlHeaders,
    });
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as {
      v: number;
      options: Array<{ method: string }>;
    };
    expect(body.v).toBe(1);
    expect(body.options).toEqual([
      {
        method: "x402",
        network: "base-sepolia",
        pay_to: "0xabc",
        price_usd: "0.001",
      },
    ]);
  });

  it("adds a Link header to the Stripe option when enabled (AC-2.1)", async () => {
    const app = appWith(`${TOLL}
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "whsec_x"
`);
    const resp = await app.request("http://example.com/a", {
      headers: curlHeaders,
    });
    expect(resp.status).toBe(402);
    expect(resp.headers.get("link")).toContain(
      "https://buy.stripe.com/test_123",
    );
  });
});
