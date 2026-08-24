import {
  decodeVoucher,
  generateSecretKey,
  parseConfig,
  publicKeyOf,
  spendVoucher,
} from "@tollbooth/core";
import { beforeEach, describe, expect, it } from "vitest";
import { makeStripeAdapter, verifyStripeSignature } from "../src/index.js";

const NOW = 1_800_000_000;
const SECRET = "whsec_test_secret";
const AGENT_KEY = "buyer-agent-pubkey-b64url";

const CFG = parseConfig(`
mode = "toll"
[toll.x402]
enabled = false
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "${SECRET}"
`);

const encoder = new TextEncoder();

async function stripeSign(
  payload: string,
  secret: string,
  t: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`)),
  );
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

function checkoutEvent(sessionId: string, agentPubkey: string | null): string {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        custom_fields:
          agentPubkey === null
            ? []
            : [
                {
                  key: "agent_pubkey",
                  type: "text",
                  text: { value: agentPubkey },
                },
              ],
      },
    },
  });
}

function extractVoucher(page: string): string {
  const match = /<code id="voucher">([^<]+)<\/code>/.exec(page);
  if (!match?.[1]) throw new Error("no voucher in page");
  return match[1];
}

describe("stripe webhook signature verification", () => {
  it("accepts a valid v1 signature within tolerance", async () => {
    const body = checkoutEvent("cs_1", AGENT_KEY);
    const header = await stripeSign(body, SECRET, NOW);
    expect(
      await verifyStripeSignature(body, header, SECRET, { nowS: NOW }),
    ).toBe(true);
  });

  it("rejects wrong secret, tampered body, stale timestamp, missing header", async () => {
    const body = checkoutEvent("cs_1", AGENT_KEY);
    expect(
      await verifyStripeSignature(
        body,
        await stripeSign(body, "whsec_other", NOW),
        SECRET,
        {
          nowS: NOW,
        },
      ),
    ).toBe(false);
    expect(
      await verifyStripeSignature(
        `${body} `,
        await stripeSign(body, SECRET, NOW),
        SECRET,
        {
          nowS: NOW,
        },
      ),
    ).toBe(false);
    expect(
      await verifyStripeSignature(
        body,
        await stripeSign(body, SECRET, NOW - 400),
        SECRET,
        {
          nowS: NOW,
        },
      ),
    ).toBe(false);
    expect(
      await verifyStripeSignature(body, undefined, SECRET, { nowS: NOW }),
    ).toBe(false);
  });
});

describe("US-3 AC-3.1 - webhook mints, redemption renders once (D-8)", () => {
  let clock: number;
  let site: { secret: Uint8Array; pub: Uint8Array };
  let adapter: ReturnType<typeof makeStripeAdapter>;

  beforeEach(async () => {
    clock = NOW;
    const secret = generateSecretKey();
    site = { secret, pub: await publicKeyOf(secret) };
    adapter = makeStripeAdapter({
      cfg: CFG,
      siteSecret: secret,
      nowS: () => clock,
    });
  });

  async function completeCheckout(
    sessionId: string,
    pubkey: string | null = AGENT_KEY,
  ) {
    const body = checkoutEvent(sessionId, pubkey);
    return adapter.handleWebhook(body, await stripeSign(body, SECRET, clock));
  }

  it("mints a key-bound voucher and renders it exactly once at the redemption route", async () => {
    expect((await completeCheckout("cs_ok")).status).toBe(200);

    const first = adapter.redeem("cs_ok");
    expect(first.status).toBe(200);
    const voucher = extractVoucher(first.body);
    const payload = decodeVoucher(voucher);
    expect(payload).toMatchObject({
      v: 1,
      agent_key: AGENT_KEY,
      credits: 5000,
    });
    expect(payload.expires).toBe(NOW + 30 * 86_400); // voucher_ttl default 30d
    // and it actually spends against the site key
    const spent = await spendVoucher(voucher, site, AGENT_KEY, {
      nowS: NOW,
      allowBearer: false,
    });
    expect(spent.state).toBe("spent");

    // render once: the second attempt 404s
    expect(adapter.redeem("cs_ok").status).toBe(404);
  });

  it("404s unknown sessions and entries past redeem_ttl", async () => {
    expect(adapter.redeem("cs_never").status).toBe(404);
    await completeCheckout("cs_late");
    clock = NOW + 16 * 60; // redeem_ttl default 15m
    expect(adapter.redeem("cs_late").status).toBe(404);
  });

  it("rejects a bad webhook signature and mints nothing", async () => {
    const body = checkoutEvent("cs_forged", AGENT_KEY);
    const result = await adapter.handleWebhook(
      body,
      await stripeSign(body, "whsec_wrong", clock),
    );
    expect(result.status).toBe(400);
    expect(adapter.redeem("cs_forged").status).toBe(404);
  });

  it("acks other event types without minting", async () => {
    const body = JSON.stringify({
      type: "invoice.paid",
      data: { object: { id: "cs_other" } },
    });
    const result = await adapter.handleWebhook(
      body,
      await stripeSign(body, SECRET, clock),
    );
    expect(result.status).toBe(200);
    expect(adapter.redeem("cs_other").status).toBe(404);
  });

  it("without agent_pubkey: mints nothing when bearer is off", async () => {
    const result = await completeCheckout("cs_nokey", null);
    expect(result.status).toBe(200); // never make Stripe retry over a buyer's typo
    expect(adapter.redeem("cs_nokey").status).toBe(404);
  });

  it("without agent_pubkey: mints a bearer voucher when the flag allows", async () => {
    const bearerCfg = parseConfig(`
mode = "toll"
[toll.x402]
enabled = false
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "${SECRET}"
bearer = true
`);
    const bearer = makeStripeAdapter({
      cfg: bearerCfg,
      siteSecret: site.secret,
      nowS: () => clock,
    });
    const body = checkoutEvent("cs_bearer", null);
    await bearer.handleWebhook(body, await stripeSign(body, SECRET, clock));
    const page = bearer.redeem("cs_bearer");
    expect(page.status).toBe(200);
    expect(decodeVoucher(extractVoucher(page.body)).agent_key).toBeNull();
  });
});
