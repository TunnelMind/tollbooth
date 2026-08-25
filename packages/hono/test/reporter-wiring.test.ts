// AC-6.3 wired: decisions become signed receipts, batched to the configured
// log endpoint, verifiable offline - and the request never waits for any of
// it. Reporting is off by default; this test turns it on explicitly.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import {
  generateSecretKey,
  publicKeyOf,
  type Receipt,
  ReceiptReporter,
  type SiteKeyPair,
  verifyReceipt,
} from "@tollbooth/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  NOW,
  PAY_TO,
  validPayment,
} from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
} from "../../core/test/fixtures/wba.js";
import { tollbooth } from "../src/index.js";

const CFG = `
mode = "toll"
report = true
report_url = "https://log.test/ingest"
[toll.x402]
pay_to = "${PAY_TO}"
`;

async function setup() {
  const secret = generateSecretKey();
  const site: SiteKeyPair = { secret, pub: await publicKeyOf(secret) };
  const batches: Receipt[][] = [];
  const reporter = new ReceiptReporter({
    url: "https://log.test/ingest",
    autoFlush: false,
    fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      batches.push(
        (JSON.parse(init?.body as string) as { receipts: Receipt[] }).receipts,
      );
      return new Response("", { status: 200 });
    }) as typeof fetch,
  });
  const agent = await makeAgent();
  const app = new Hono();
  app.use(
    tollbooth({
      config: CFG,
      siteKeys: site,
      reporter,
      x402: { buildOffer, verifyProof },
      fetchDirectory: dirWith(agent.jwk),
      nowS: () => NOW,
    }),
  );
  app.get("*", (c) => c.text("content"));
  return { app, site, agent, reporter, batches };
}

describe("receipt emission wiring", () => {
  it("a spoofed request emits a SPOOF receipt that verifies offline", async () => {
    const { app, site, agent, reporter, batches } = await setup();
    const wba = await signedRequest(agent);
    await app.request("http://evil.example/article", {
      headers: {
        "user-agent": "curl/8.7.1",
        accept: "*/*",
        signature: wba.signature,
        "signature-input": wba.signatureInput,
        "signature-agent": wba.signatureAgent,
        host: "evil.example",
      },
    });
    await vi.waitFor(() => expect(reporter.queued).toBe(1));
    await reporter.flush();

    const receipt = batches[0]?.[0];
    if (!receipt) throw new Error("no receipt");
    expect(receipt.type).toBe("SPOOF");
    expect(receipt.agent_key).toBeNull();
    expect(receipt.claimed_key).toBe(agent.jwk.x);
    expect(receipt.path_class).toBe("/article");
    expect(await verifyReceipt(receipt, site.pub)).toEqual({ ok: true });
  });

  it("a paid request emits PASS_PAID; offers and humans emit nothing", async () => {
    const { app, reporter, batches } = await setup();
    await app.request("http://example.com/article", {
      headers: { "user-agent": "curl/8.7.1", accept: "*/*" },
    }); // 402 offer: no receipt
    await app.request("http://example.com/article", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept: "text/html,*/*;q=0.8",
      },
    }); // human: no receipt
    await app.request("http://example.com/article", {
      headers: {
        "user-agent": "curl/8.7.1",
        accept: "*/*",
        "x-payment": validPayment(),
      },
    }); // paid

    await vi.waitFor(() => expect(reporter.queued).toBe(1));
    await reporter.flush();
    expect(batches[0]?.map((r) => r.type)).toEqual(["PASS_PAID"]);
  });

  it("the report endpoint exposes queue depth and drops", async () => {
    const secret = generateSecretKey();
    const site: SiteKeyPair = { secret, pub: await publicKeyOf(secret) };
    const app = new Hono();
    app.use(
      tollbooth({
        config: `report_token = "t"`,
        siteKeys: site,
        fetchDirectory: dirWith(),
        nowS: () => NOW,
      }),
    );
    const report = (await (
      await app.request("http://example.com/_tollbooth/report", {
        headers: { authorization: "Bearer t" },
      })
    ).json()) as { receipts_queued: number; receipts_dropped: number };
    expect(report.receipts_queued).toBe(0);
    expect(report.receipts_dropped).toBe(0);
  });
});
