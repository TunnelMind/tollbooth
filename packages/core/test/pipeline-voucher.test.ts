import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { JtiCache } from "../src/jti.js";
import { generateSecretKey, publicKeyOf } from "../src/keys.js";
import { decide, type PipelineDeps } from "../src/pipeline.js";
import {
  decodeVoucher,
  mintVoucher,
  type SiteKeyPair,
} from "../src/voucher.js";
import { dirWith, makeAgent, NOW, signedRequest } from "./fixtures/wba.js";

const STRIPE_CFG = (bearer = false) =>
  parseConfig(`
mode = "toll"
[toll.x402]
enabled = false
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "whsec_x"
bearer = ${bearer}
`);

const crawler = {
  path: "/article",
  authority: "example.com",
  userAgent: "curl/8.7.1",
  accept: "*/*",
  hasCookies: false,
};

async function makeSite(): Promise<SiteKeyPair> {
  const secret = generateSecretKey();
  return { secret, pub: await publicKeyOf(secret) };
}

describe("step 5 - voucher spending (T-014)", () => {
  it("AC-3.2: a verified agent with a matching voucher passes with the successor", async () => {
    const site = await makeSite();
    const agent = await makeAgent();
    const cfg = STRIPE_CFG();
    const voucher = await mintVoucher(
      { agentKey: agent.jwk.x, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      site.secret,
    );
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      siteKeys: site,
      jtiCache: new JtiCache(100),
    };
    const req = { ...crawler, ...(await signedRequest(agent)), voucher };
    const decision = await decide(req, cfg, deps);
    if (decision.action !== "pass")
      throw new Error(`expected pass, got ${decision.action}`);
    expect(decision.reason).toBe("voucher");
    expect(decision.voucher).toBeDefined();
    expect(decodeVoucher(decision.voucher as string).credits).toBe(2);
  });

  it("AC-3.4: a different verified key is rejected 403, not offered", async () => {
    const site = await makeSite();
    const owner = await makeAgent();
    const thief = await makeAgent();
    const voucher = await mintVoucher(
      { agentKey: owner.jwk.x, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      site.secret,
    );
    const req = { ...crawler, ...(await signedRequest(thief)), voucher };
    const decision = await decide(req, STRIPE_CFG(), {
      fetchDirectory: dirWith(thief.jwk),
      nowS: NOW,
      siteKeys: site,
    });
    expect(decision).toMatchObject({
      action: "reject",
      status: 403,
      reason: "mismatch",
    });
  });

  it("an anonymous spender of a key-bound voucher is rejected", async () => {
    const site = await makeSite();
    const owner = await makeAgent();
    const voucher = await mintVoucher(
      { agentKey: owner.jwk.x, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      site.secret,
    );
    const decision = await decide({ ...crawler, voucher }, STRIPE_CFG(), {
      fetchDirectory: dirWith(),
      nowS: NOW,
      siteKeys: site,
    });
    expect(decision).toMatchObject({ action: "reject", reason: "mismatch" });
  });

  it("a bearer voucher passes an anonymous agent when the flag is on, 403s when off", async () => {
    const site = await makeSite();
    const voucher = await mintVoucher(
      { agentKey: null, credits: 3, expiresS: NOW + 3600, nowS: NOW },
      site.secret,
    );
    const on = await decide({ ...crawler, voucher }, STRIPE_CFG(true), {
      fetchDirectory: dirWith(),
      nowS: NOW,
      siteKeys: site,
    });
    expect(on.action).toBe("pass");
    const off = await decide({ ...crawler, voucher }, STRIPE_CFG(false), {
      fetchDirectory: dirWith(),
      nowS: NOW,
      siteKeys: site,
    });
    expect(off).toMatchObject({ action: "reject", reason: "bearer-disabled" });
  });

  it("AC-3.3: replay beyond replay_window falls through to the 402 offer", async () => {
    const site = await makeSite();
    const agent = await makeAgent();
    const cfg = STRIPE_CFG(); // limits.replay_window default 2
    const voucher = await mintVoucher(
      { agentKey: agent.jwk.x, credits: 100, expiresS: NOW + 3600, nowS: NOW },
      site.secret,
    );
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      siteKeys: site,
      jtiCache: new JtiCache(100),
    };
    const req = { ...crawler, ...(await signedRequest(agent)), voucher };
    expect((await decide(req, cfg, deps)).action).toBe("pass");
    expect((await decide(req, cfg, deps)).action).toBe("pass"); // soft: within window
    expect((await decide(req, cfg, deps)).action).toBe("offer"); // damped
  });

  it("expired or garbage vouchers fall through to the offer, never a reject", async () => {
    const site = await makeSite();
    const agent = await makeAgent();
    const expired = await mintVoucher(
      {
        agentKey: agent.jwk.x,
        credits: 3,
        expiresS: NOW - 10,
        nowS: NOW - 3600,
      },
      site.secret,
    );
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      siteKeys: site,
    };
    const wba = await signedRequest(agent);
    expect(
      (
        await decide(
          { ...crawler, ...wba, voucher: expired },
          STRIPE_CFG(),
          deps,
        )
      ).action,
    ).toBe("offer");
    expect(
      (
        await decide(
          { ...crawler, ...wba, voucher: "garbage" },
          STRIPE_CFG(),
          deps,
        )
      ).action,
    ).toBe("offer");
  });
});
