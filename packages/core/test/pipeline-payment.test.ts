import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { OfferLedger } from "../src/ledger.js";
import { decide, type PipelineDeps } from "../src/pipeline.js";
import { dirWith, makeAgent, NOW, signedRequest } from "./fixtures/wba.js";

const TOLL_CFG = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "0xabc"
`);

const crawler = {
  path: "/article",
  authority: "example.com",
  userAgent: "curl/8.7.1",
  accept: "*/*",
  hasCookies: false,
};

const paidDeps = (ok: boolean): PipelineDeps => ({
  fetchDirectory: dirWith(),
  nowS: NOW,
  verifyPayment: () => ({ ok, payer: ok ? "0xpayer" : null }),
});

describe("step 6 - x402 payment proof (T-010)", () => {
  it("a valid payment passes an agent (AC-2.2)", async () => {
    const decision = await decide(
      { ...crawler, payment: "xp" },
      TOLL_CFG,
      paidDeps(true),
    );
    expect(decision.action).toBe("pass");
    if (decision.action === "pass") expect(decision.reason).toBe("paid");
  });

  it("an invalid payment falls through to the offer", async () => {
    const decision = await decide(
      { ...crawler, payment: "xp" },
      TOLL_CFG,
      paidDeps(false),
    );
    expect(decision.action).toBe("offer");
  });

  it("humans pass as humans even when a payment header is present", async () => {
    const human = {
      ...crawler,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
      accept: "text/html,*/*;q=0.8",
      payment: "xp",
    };
    const decision = await decide(human, TOLL_CFG, paidDeps(true));
    if (decision.action !== "pass") throw new Error("expected pass");
    expect(decision.reason).toBe("human");
  });
});

describe("D-3 ledger wiring", () => {
  it("verified agents accumulate offers, then paid_ever on payment", async () => {
    const agent = await makeAgent();
    const ledger = new OfferLedger(10);
    const wba = await signedRequest(agent);
    const req = { ...crawler, ...wba };
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      ledger,
    };

    await decide(req, TOLL_CFG, deps);
    await decide(req, TOLL_CFG, deps);
    expect(ledger.get(agent.jwk.x)).toMatchObject({
      offersSent: 2,
      paidEver: false,
    });

    await decide({ ...req, payment: "xp" }, TOLL_CFG, {
      ...deps,
      verifyPayment: () => ({ ok: true, payer: "0xpayer" }),
    });
    expect(ledger.get(agent.jwk.x)).toMatchObject({
      offersSent: 2,
      paidEver: true,
    });
  });

  it("anonymous agents are never ledgered (spec sec 8 honest limit)", async () => {
    const ledger = new OfferLedger(10);
    await decide(crawler, TOLL_CFG, {
      fetchDirectory: dirWith(),
      nowS: NOW,
      ledger,
    });
    expect(ledger.size).toBe(0);
  });
});
