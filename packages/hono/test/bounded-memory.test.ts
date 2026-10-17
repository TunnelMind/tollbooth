// B004: attacker-sized UAs and paths must not grow the middleware's memory
// without bound - every recorded copy is truncated and the stats map has a
// byte budget on top of its entry cap.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import {
  generateSecretKey,
  publicKeyOf,
  type Receipt,
  ReceiptReporter,
} from "@tollbooth/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { NOW, PAY_TO } from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
} from "../../core/test/fixtures/wba.js";
import { tollbooth } from "../src/index.js";

const LONG_PATH = `/${"p".repeat(1000)}`;

describe("B004 bounded memory", () => {
  it("1,500 requests with distinct 100 KB UAs keep the report under 2 MB", async () => {
    const app = new Hono();
    app.use(
      tollbooth({
        // Entry cap below the request count, so both bounds are exercised.
        config: `report_token = "t"\n[limits]\nagent_ledger_max = 1000\n`,
        fetchDirectory: dirWith(),
        nowS: () => NOW,
      }),
    );
    app.get("*", (c) => c.text("content"));

    const filler = "x".repeat(100_000);
    for (let i = 0; i < 1500; i++)
      await app.request(`http://example.com${LONG_PATH}${i}`, {
        headers: { "user-agent": `bot-${i}/${filler}`, accept: "*/*" },
      });

    const resp = await app.request("http://example.com/_tollbooth/report", {
      headers: { authorization: "Bearer t" },
    });
    const body = await resp.text();
    expect(body.length).toBeLessThan(2_000_000);
    const report = JSON.parse(body) as {
      agents: Array<{ key: string; ua: string; paths: string[] }>;
    };
    expect(report.agents.length).toBeGreaterThan(0);
    // ~1.3 KB retained per entry: the 1 MB byte budget binds before the
    // 1,000-entry cap does.
    expect(report.agents.length).toBeLessThan(1000);
    for (const a of report.agents) {
      expect(a.ua.length).toBeLessThanOrEqual(512);
      for (const p of a.paths) expect(p.length).toBeLessThanOrEqual(256);
    }
    // oldest-first: the newest agent survived the byte-budget eviction
    expect(report.agents.at(-1)?.ua.startsWith("bot-1499/")).toBe(true);
    // The explicit timeout covers a loaded suite.
  }, 30_000);

  it("records a >256-char path and >512-char UA in a receipt truncated", async () => {
    const secret = generateSecretKey();
    const site = { secret, pub: await publicKeyOf(secret) };
    const enqueued: Receipt[] = [];
    const reporter = new ReceiptReporter({
      url: "https://log.test/ingest",
      autoFlush: false,
    });
    reporter.enqueue = (r: Receipt) => {
      enqueued.push(r);
    };
    const agent = await makeAgent();
    const app = new Hono();
    app.use(
      tollbooth({
        config: `mode = "toll"\nreport = true\nreport_url = "https://log.test/ingest"\n[toll.x402]\npay_to = "${PAY_TO}"\n`,
        siteKeys: site,
        reporter,
        x402: { buildOffer, verifyProof },
        fetchDirectory: dirWith(agent.jwk),
        nowS: () => NOW,
      }),
    );
    app.get("*", (c) => c.text("content"));
    // A signature from another key: a SPOOF, which always emits a receipt.
    const wba = await signedRequest(agent);
    await app.request(`http://evil.example${LONG_PATH}`, {
      headers: {
        "user-agent": `curl/8.7.1 ${"u".repeat(1000)}`,
        accept: "*/*",
        signature: wba.signature,
        "signature-input": wba.signatureInput,
        "signature-agent": wba.signatureAgent,
        host: "evil.example",
      },
    });
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    // receipts keep only the first segment, cut from the 256-char path
    expect(enqueued[0]?.path_class).toBe(LONG_PATH.slice(0, 256));
    expect(enqueued[0]?.ua.length).toBe(512);
  });
});
