import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { OfferLedger } from "../src/ledger.js";
import { decide, type PipelineDeps } from "../src/pipeline.js";
import {
  dirWith,
  makeAgent,
  NOW,
  signedRequest,
  type TestAgent,
} from "./fixtures/wba.js";

const TOLL_CFG = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "0xabc"
`); // offer_grace 3, window 10m, maze enabled - all defaults

const NO_MAZE_CFG = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "0xabc"
[maze]
enabled = false
`);

const crawler = {
  path: "/article",
  authority: "example.com",
  userAgent: "curl/8.7.1",
  accept: "*/*",
  hasCookies: false,
};

async function agentReq(agent: TestAgent) {
  // long expiry so advancing the clock tests the WINDOW, not signature staleness
  return {
    ...crawler,
    ...(await signedRequest(agent, { expires: NOW + 7200 })),
  };
}

describe("step 7 - offers exhausted -> consequence (AC-4.1)", () => {
  it("grace offers within the window, then the maze", async () => {
    const agent = await makeAgent();
    const req = await agentReq(agent);
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      ledger: new OfferLedger(10),
    };

    for (let i = 0; i < 3; i++)
      expect((await decide(req, TOLL_CFG, deps)).action).toBe("offer");
    const fourth = await decide(req, TOLL_CFG, deps);
    expect(fourth).toMatchObject({
      action: "consequence",
      reason: "toll-ignored",
    });
  });

  it("an expired window is amnesty: offers resume", async () => {
    const agent = await makeAgent();
    const req = await agentReq(agent);
    const ledger = new OfferLedger(10);
    const at = (nowS: number): PipelineDeps => ({
      fetchDirectory: dirWith(agent.jwk),
      nowS,
      ledger,
    });

    for (let i = 0; i < 3; i++) await decide(req, TOLL_CFG, at(NOW));
    expect((await decide(req, TOLL_CFG, at(NOW + 601))).action).toBe("offer"); // window is 600s
  });

  it("anonymous agents are never mazed - offers forever (spec sec 8)", async () => {
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(),
      nowS: NOW,
      ledger: new OfferLedger(10),
    };
    for (let i = 0; i < 6; i++)
      expect((await decide(crawler, TOLL_CFG, deps)).action).toBe("offer");
  });

  it("with the maze disabled there is no consequence, only more offers", async () => {
    const agent = await makeAgent();
    const req = await agentReq(agent);
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      ledger: new OfferLedger(10),
    };
    for (let i = 0; i < 5; i++)
      expect((await decide(req, NO_MAZE_CFG, deps)).action).toBe("offer");
  });
});

describe("AC-4.4 - redemption: the exit is always open", () => {
  it("a mazed key that pays passes, and gets fresh grace afterwards", async () => {
    const agent = await makeAgent();
    const req = await agentReq(agent);
    const ledger = new OfferLedger(10);
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      ledger,
      verifyPayment: (p) => ({
        ok: p === "valid",
        payer: p === "valid" ? "0xpayer" : null,
      }),
    };

    // exhaust the grace
    for (let i = 0; i < 3; i++) await decide(req, TOLL_CFG, deps);
    expect((await decide(req, TOLL_CFG, deps)).action).toBe("consequence");

    // payment redeems immediately - steps 5/6 run before step 7
    const paid = await decide({ ...req, payment: "valid" }, TOLL_CFG, deps);
    expect(paid.action).toBe("pass");

    // and the strike window was cleared: unpaid requests get offers again
    expect((await decide(req, TOLL_CFG, deps)).action).toBe("offer");
    expect((await decide(req, TOLL_CFG, deps)).action).toBe("offer");
    expect((await decide(req, TOLL_CFG, deps)).action).toBe("offer");
    expect((await decide(req, TOLL_CFG, deps)).action).toBe("consequence"); // grace spent again
  });
});
