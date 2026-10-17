// B007: SPOOF receipts can't frame a key. Anyone can send junk signatures
// naming any key, so spoofs aggregate per claimed key per 60 s window into
// ONE receipt carrying a count, and the attacker-chosen strings are capped.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import {
  generateSecretKey,
  publicKeyOf,
  type Receipt,
  ReceiptReporter,
  verifyReceipt,
} from "@tollbooth/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { NOW, PAY_TO } from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
  type TestAgent,
} from "../../core/test/fixtures/wba.js";
import { tollbooth } from "../src/index.js";

async function setup(...agents: TestAgent[]) {
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
  const clock = { now: NOW };
  const app = new Hono();
  app.use(
    tollbooth({
      config: `mode = "toll"\nreport = true\nreport_url = "https://log.test/ingest"\n[toll.x402]\npay_to = "${PAY_TO}"\n`,
      siteKeys: site,
      reporter,
      x402: { buildOffer, verifyProof },
      fetchDirectory: dirWith(...agents.map((a) => a.jwk)),
      nowS: () => clock.now,
    }),
  );
  app.get("*", (c) => c.text("content"));
  return { app, site, enqueued, clock };
}

// A signature for example.com sent to evil.example: a SPOOF naming `agent`.
async function spoofHeaders(
  agent: TestAgent,
  created = NOW,
  ua = "curl/8.7.1",
) {
  const wba = await signedRequest(agent, { created, expires: created + 60 });
  return {
    "user-agent": ua,
    accept: "*/*",
    signature: wba.signature,
    "signature-input": wba.signatureInput,
    "signature-agent": wba.signatureAgent,
    host: "evil.example",
  };
}

const spoof = (app: Hono, headers: Record<string, string>) =>
  app.request("http://evil.example/article", { headers });

describe("B007 SPOOF aggregation", () => {
  it("1,000 spoofs naming one key in a window are ONE receipt with count 1000", async () => {
    const agent = await makeAgent();
    const { app, site, enqueued, clock } = await setup(agent);
    const headers = await spoofHeaders(agent);
    for (let i = 0; i < 1000; i++) await spoof(app, headers);
    expect(enqueued).toHaveLength(0); // pending, not emitted per request

    // The window has elapsed: the next spoof flushes the bucket. The trigger
    // request is NOT counted in it - it opens the next window's bucket.
    clock.now = NOW + 61;
    await spoof(app, await spoofHeaders(agent, NOW + 61));
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const r = enqueued[0] as Receipt;
    expect(r.type).toBe("SPOOF");
    expect(r.count).toBe(1000);
    expect(r.claimed_key).toBe(agent.jwk.x);
    expect(r.agent_key).toBeNull();
    expect(await verifyReceipt(r, site.pub)).toEqual({ ok: true });
    // ...and no stray second receipt for the trigger
    await new Promise((res) => setTimeout(res, 20));
    expect(enqueued).toHaveLength(1);
  }, 30_000);

  it("caps the SPOOF ua at 128 chars and strips control chars", async () => {
    const agent = await makeAgent();
    const { app, enqueued, clock } = await setup(agent);
    const ua = `bad\u0001\u001b[31m\u007f${"u".repeat(1000)}`;
    await spoof(app, await spoofHeaders(agent, NOW, ua));
    clock.now = NOW + 61;
    await spoof(app, await spoofHeaders(agent, NOW + 61));
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const r = enqueued[0] as Receipt;
    expect(r.ua.length).toBeLessThanOrEqual(128);
    expect(r.ua.startsWith("bad[31m")).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point
    expect(/[\u0000-\u001f\u007f]/.test(r.ua)).toBe(false);
    expect(r.claimed_key?.length).toBeLessThanOrEqual(128);
  });

  it("spoofs naming two different keys yield two receipts", async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { app, enqueued, clock } = await setup(a, b);
    const ha = await spoofHeaders(a);
    const hb = await spoofHeaders(b);
    for (let i = 0; i < 3; i++) await spoof(app, ha);
    for (let i = 0; i < 5; i++) await spoof(app, hb);
    clock.now = NOW + 61;
    await spoof(app, await spoofHeaders(a, NOW + 61));
    await vi.waitFor(() => expect(enqueued).toHaveLength(2));
    const byKey = Object.fromEntries(
      enqueued.map((r) => [r.claimed_key, r.count]),
    );
    expect(byKey).toEqual({ [a.jwk.x]: 3, [b.jwk.x]: 5 });
  });
});
