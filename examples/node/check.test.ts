import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { generateSecretKey, mintVoucher, publicKeyOf } from "@tollbooth/core";
import { tollbooth } from "@tollbooth/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fetchPaying } from "../agent-client.js";
import { app } from "./index.js";

const human = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,*/*;q=0.8",
};
const curl = { "user-agent": "curl/8.7.1", accept: "*/*" };

const asFetch = (a: Hono): typeof fetch =>
  ((url: RequestInfo | URL, init?: RequestInit) =>
    a.request(url as string, init)) as typeof fetch;

describe("node example over a real local socket", () => {
  it("humans get content, agents get the machine-readable 402 (AC-7.2)", async () => {
    const server = serve({ fetch: app.fetch, port: 0 });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/`, { headers: human })).status).toBe(200);

    const resp = await fetch(`${base}/article`, { headers: curl });
    expect(resp.status).toBe(402);
    const offer = (await resp.json()) as {
      options: Array<Record<string, unknown>>;
    };
    expect(offer.options.find((o) => o.method === "x402")).toMatchObject({
      network: "base-sepolia",
      pay_to: expect.stringMatching(/^0x/),
      price_usd: "0.001",
    });
    expect(resp.headers.get("x-payment-required")).toBeTruthy();
    server.close();
  });
});

describe("agent-client (AC-7.1)", () => {
  it("stays within 80 lines", async () => {
    const source = await readFile(
      new URL("../agent-client.ts", import.meta.url),
      "utf8",
    );
    expect(source.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
  });

  it("reads the 402 offer, pays x402, retries to success", async () => {
    const resp = await fetchPaying("http://example.com/article", {
      ethKeyHex:
        "2e0834786285daccd064ca17f1654f67b4aef298acbb82cef9ec422fb4975622",
      fetchFn: asFetch(app),
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("the article");
  });

  it("spends a voucher when it has one", async () => {
    const secret = generateSecretKey();
    const site = { secret, pub: await publicKeyOf(secret) };
    const vApp = new Hono();
    vApp.use(
      tollbooth({
        config: `
mode = "toll"
[toll.x402]
enabled = false
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_x"
webhook_secret = "whsec_x"
bearer = true
`,
        siteKeys: site,
      }),
    );
    vApp.get("*", (c) => c.text("paid content"));

    const nowS = Math.floor(Date.now() / 1000);
    const voucher = await mintVoucher(
      { agentKey: null, credits: 5, expiresS: nowS + 3600, nowS },
      secret,
    );
    const resp = await fetchPaying("http://example.com/anything", {
      voucher,
      fetchFn: asFetch(vApp),
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("paid content");
    expect(resp.headers.get("tollbooth-voucher")).toBeTruthy(); // the successor rides back
  });
});
