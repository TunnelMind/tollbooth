// Full US-3 integration: an agent operator prepays via Stripe, their crawler
// spends the voucher. Purchase (mocked webhook) -> render-once redemption ->
// key-bound spends with decrementing re-signs -> mismatch 403 -> soft replay
// damping. Everything crosses a real Hono app.
import { makeStripeAdapter } from "@tunnelmindai/fareseal-adapter-stripe";
import {
  decodeVoucher,
  generateSecretKey,
  parseConfig,
  publicKeyOf,
  type SiteKeyPair,
} from "@tunnelmindai/fareseal-core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  checkoutEvent,
  extractVoucher,
  stripeSign,
} from "../../adapter-stripe/test/fixtures/webhook.js";
import {
  dirWith,
  makeAgent,
  NOW,
  signedRequest,
  type TestAgent,
} from "../../core/test/fixtures/wba.js";
import { fareseal } from "../src/index.js";

const WEBHOOK_SECRET = "whsec_integration";

const CFG = `
mode = "toll"
[toll.x402]
enabled = false
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "${WEBHOOK_SECRET}"
`;

async function setup(...directoryAgents: TestAgent[]) {
  const secret = generateSecretKey();
  const site: SiteKeyPair = { secret, pub: await publicKeyOf(secret) };
  const stripe = makeStripeAdapter({
    cfg: parseConfig(CFG),
    siteSecret: secret,
    nowS: () => NOW,
  });
  const app = new Hono();
  app.use(
    fareseal({
      config: CFG,
      siteKeys: site,
      stripe,
      fetchDirectory: dirWith(...directoryAgents.map((a) => a.jwk)),
      nowS: () => NOW,
    }),
  );
  app.get("*", (c) => c.text("content"));
  return app;
}

function wbaHeaders(wba: Awaited<ReturnType<typeof signedRequest>>) {
  return {
    "user-agent": "curl/8.7.1",
    accept: "*/*",
    signature: wba.signature,
    "signature-input": wba.signatureInput,
    "signature-agent": wba.signatureAgent,
  };
}

async function purchase(app: Hono, sessionId: string, agentPubkey: string) {
  const body = checkoutEvent(sessionId, agentPubkey);
  const resp = await app.request(
    "http://example.com/_tollbooth/stripe-webhook",
    {
      method: "POST",
      body,
      headers: {
        "stripe-signature": await stripeSign(body, WEBHOOK_SECRET, NOW),
      },
    },
  );
  expect(resp.status).toBe(200);
  const page = await app.request(
    `http://example.com/_tollbooth/voucher/${sessionId}`,
  );
  expect(page.status).toBe(200);
  return extractVoucher(await page.text());
}

describe("T006 webhook and voucher under the /_fareseal prefix", () => {
  it("purchase and redeem work on /_fareseal/*; the legacy voucher URL is gone after one redeem", async () => {
    const agent = await makeAgent();
    const app = await setup(agent);
    const body = checkoutEvent("cs_t006", agent.jwk.x);
    const hook = await app.request(
      "http://example.com/_fareseal/stripe-webhook",
      {
        method: "POST",
        body,
        headers: {
          "stripe-signature": await stripeSign(body, WEBHOOK_SECRET, NOW),
        },
      },
    );
    expect(hook.status).toBe(200);
    const page = await app.request(
      "http://example.com/_fareseal/voucher/cs_t006",
    );
    expect(page.status).toBe(200);
    expect(extractVoucher(await page.text())).toBeTruthy();
    expect(
      (await app.request("http://example.com/_tollbooth/voucher/cs_t006"))
        .status,
    ).toBe(404);
  });
});

describe("US-3 end to end", () => {
  it("purchase -> redeem once -> spend with decrementing re-signs", async () => {
    const agent = await makeAgent();
    const app = await setup(agent);
    const wba = await signedRequest(agent);

    // Unpaid: 402 with the Link header to the Stripe option (AC-2.1).
    const unpaid = await app.request("http://example.com/article", {
      headers: wbaHeaders(wba),
    });
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("link")).toContain(
      "https://buy.stripe.com/test_123",
    );

    // Operator's buyer completes checkout; crawler collects the voucher once.
    const voucher = await purchase(app, "cs_us3", agent.jwk.x);
    expect(decodeVoucher(voucher)).toMatchObject({
      agent_key: agent.jwk.x,
      credits: 5000,
    });
    expect(
      (await app.request("http://example.com/_tollbooth/voucher/cs_us3"))
        .status,
    ).toBe(404);

    // Spend: pass, and the response carries the re-signed successor (AC-3.2).
    const first = await app.request("http://example.com/article", {
      headers: { ...wbaHeaders(wba), "tollbooth-voucher": voucher },
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("content");
    const successor = first.headers.get("tollbooth-voucher");
    if (!successor) throw new Error("no successor voucher on response");
    expect(decodeVoucher(successor).credits).toBe(4999);

    // Chain continues from the successor.
    const second = await app.request("http://example.com/article", {
      headers: { ...wbaHeaders(wba), "tollbooth-voucher": successor },
    });
    expect(second.status).toBe(200);
    expect(
      decodeVoucher(second.headers.get("tollbooth-voucher") ?? "").credits,
    ).toBe(4998);
  });

  // T007: `fareseal-voucher` is the new request header; `tollbooth-voucher`
  // stays accepted and emitted until 3.0.0.
  it("T007: voucher header rename, compat window", async () => {
    const agent = await makeAgent();
    const app = await setup(agent);
    const voucher = await purchase(app, "cs_t007", agent.jwk.x);
    const spend = async (h: Record<string, string>) =>
      app.request("http://example.com/article", {
        headers: { ...wbaHeaders(await signedRequest(agent)), ...h },
      });

    // New header alone spends; the response carries both, same value.
    const viaNew = await spend({ "fareseal-voucher": voucher });
    expect(viaNew.status).toBe(200);
    const successor = viaNew.headers.get("fareseal-voucher");
    if (!successor) throw new Error("no successor voucher on response");
    expect(viaNew.headers.get("tollbooth-voucher")).toBe(successor);
    expect(decodeVoucher(successor).credits).toBe(4999);

    // Old header alone still spends.
    const viaOld = await spend({ "tollbooth-voucher": successor });
    expect(viaOld.status).toBe(200);
    const next = viaOld.headers.get("fareseal-voucher") ?? "";
    expect(decodeVoucher(next).credits).toBe(4998);

    // Both present, different values: the new header wins (old one is junk).
    const both = await spend({
      "fareseal-voucher": next,
      "tollbooth-voucher": "not-a-voucher",
    });
    expect(both.status).toBe(200);
    expect(
      decodeVoucher(both.headers.get("fareseal-voucher") ?? "").credits,
    ).toBe(4997);
  });

  it("AC-3.4: another verified agent spending the voucher gets 403", async () => {
    const owner = await makeAgent();
    const thief = await makeAgent();
    const app = await setup(owner, thief);
    const voucher = await purchase(app, "cs_theft", owner.jwk.x);

    const resp = await app.request("http://example.com/article", {
      headers: {
        ...wbaHeaders(await signedRequest(thief)),
        "tollbooth-voucher": voucher,
      },
    });
    expect(resp.status).toBe(403);
  });

  it("AC-3.3: replaying one signed state is soft-damped after replay_window", async () => {
    const agent = await makeAgent();
    const app = await setup(agent);
    const wba = await signedRequest(agent);
    const voucher = await purchase(app, "cs_replay", agent.jwk.x);
    const replay = () =>
      app.request("http://example.com/article", {
        headers: { ...wbaHeaders(wba), "tollbooth-voucher": voucher },
      });

    expect((await replay()).status).toBe(200); // spend 1
    expect((await replay()).status).toBe(200); // soft over-spend, within window 2
    expect((await replay()).status).toBe(402); // damped: back to the offer
  });
});
