import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { OfferLedger } from "../src/ledger.js";
import {
  decide,
  isNoOfferFault,
  isOperatorFault,
  type PipelineDeps,
} from "../src/pipeline.js";
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

describe("FR-006 - no maze for a payment we failed", () => {
  // offer_grace 3, maze enabled: the defaults. Skew pinned as in
  // pipeline-consequence so one signed request stays valid for all attempts.
  const CFG = parseConfig(`
mode = "toll"
wba_skew_tolerance = "300s"
[toll.x402]
pay_to = "0xabc"
`);

  async function setup(reason: string) {
    const agent = await makeAgent();
    const ledger = new OfferLedger(10);
    const req = {
      ...crawler,
      ...(await signedRequest(agent, { expires: NOW + 300 })),
      payment: "xp",
    };
    const deps: PipelineDeps = {
      fetchDirectory: dirWith(agent.jwk),
      nowS: NOW,
      ledger,
      verifyPayment: () => ({ ok: false, payer: null, reason }),
    };
    return { agent, ledger, req, deps };
  }

  it.each([
    "settle-retryable",
    "settlement-unconfigured",
    "settle-unreachable",
    "settle-failed(503)",
    "verify-failed(429)",
  ])("%s: four attempts are four offers, nothing ledgered", async (reason) => {
    const { agent, ledger, req, deps } = await setup(reason);
    const actions: string[] = [];
    for (let i = 0; i < 4; i++)
      actions.push((await decide(req, CFG, deps)).action);
    expect(actions).toEqual(["offer", "offer", "offer", "offer"]);
    expect(ledger.get(agent.jwk.x as string)).toBeUndefined();
  });

  // R004 (second review 2 L-a): changed from no-offer. Any client can empty
  // our settle bucket, so settle-throttled records an offer as on main.
  it("settle-throttled now records an offer: offer x3, then the consequence", async () => {
    const { agent, ledger, req, deps } = await setup("settle-throttled");
    const actions: string[] = [];
    for (let i = 0; i < 4; i++)
      actions.push((await decide(req, CFG, deps)).action);
    expect(actions).toEqual(["offer", "offer", "offer", "consequence"]);
    expect(ledger.get(agent.jwk.x as string)).toBeDefined();
  });

  // R002 L3/L7: the payer may have paid (settled, unusable tx id; or a
  // non-2xx claiming settled:true), so no offer is recorded either.
  it.each(["no-transaction-id", "settle-unconfirmed"])(
    "%s: four attempts are four offers, no consequence, nothing ledgered",
    async (reason) => {
      const { agent, ledger, req, deps } = await setup(reason);
      const actions: string[] = [];
      for (let i = 0; i < 4; i++)
        actions.push((await decide(req, CFG, deps)).action);
      expect(actions).toEqual(["offer", "offer", "offer", "offer"]);
      expect(ledger.get(agent.jwk.x as string)).toBeUndefined();
    },
  );

  it("isNoOfferFault: operator faults plus the two maybe-paid reasons, not payer faults", () => {
    for (const r of [
      "settle-retryable",
      "settlement-unconfigured",
      "settlement-not-configured",
      "settle-unreachable",
      "settle-failed(503)",
      "settle-failed(401)",
      "verify-failed(429)",
      "verify-error: boom",
      "no-transaction-id",
      "settle-unconfirmed",
    ])
      expect(isNoOfferFault(r)).toBe(true);
    // R004: settle-throttled (a client can cause it) and the first
    // not-yet-valid (it reached the facilitator) record an offer; the held
    // repeat keeps the consequence (its ledger skip is in decide).
    for (const r of [
      "not-yet-valid-held",
      undefined,
      "expired",
      "settle-failed",
      "settle-throttled",
      "not-yet-valid",
    ])
      expect(isNoOfferFault(r)).toBe(false);
    expect(isOperatorFault("settle-throttled")).toBe(true); // hono text unchanged
    // The operator set itself is unchanged (hono's "retry" text keys off it).
    expect(isOperatorFault("no-transaction-id")).toBe(false);
    expect(isOperatorFault("settle-unconfirmed")).toBe(false);
  });

  // R003 (second review L8): both reason regexes are anchored at both ends,
  // so a near-miss stays a payer fault (killed mutant: drop the `^`).
  it("isOperatorFault: the reason patterns are anchored", () => {
    for (const r of [
      "verify-error: boom",
      "settle-error:",
      "settle-failed(500)",
      "verify-failed(429)",
    ])
      expect(isOperatorFault(r)).toBe(true);
    for (const r of [
      "x settle-failed(500)",
      "xsettle-failed(500)",
      "x verify-error:",
      "x settle-error: boom",
      "settle-failed(500)x",
      "settle-failed(500)\n",
    ])
      expect(isOperatorFault(r)).toBe(false);
  });

  // R004 L-b (rework): the held repeat skips only the ledger write. Below the
  // grace it is an offer and the count is unchanged; once exhausted it is
  // the consequence, so repeating a held payment cannot dodge the maze.
  it("not-yet-valid-held under the grace: the offer, ledger count unchanged", async () => {
    const { agent, ledger, req, deps } = await setup("not-yet-valid-held");
    const key = agent.jwk.x as string;
    for (let i = 0; i < 2; i++) ledger.recordOffer(key, NOW * 1000, 600_000);
    for (let i = 0; i < 4; i++)
      expect((await decide(req, CFG, deps)).action).toBe("offer");
    expect(ledger.get(key)?.offersSent).toBe(2);
  });

  it("not-yet-valid-held with 3 offers ledgered: the consequence", async () => {
    const { agent, ledger, req, deps } = await setup("not-yet-valid-held");
    const key = agent.jwk.x as string;
    for (let i = 0; i < 3; i++) ledger.recordOffer(key, NOW * 1000, 600_000);
    expect((await decide(req, CFG, deps)).action).toBe("consequence");
    expect(ledger.get(key)?.offersSent).toBe(3);
  });

  // R-O3: 60 held repeats per window are free (an honest agent polling once
  // a second through the 60 s skew never needs more). From the 61st each one
  // records an offer, so a held payment cannot keep the offer open for ever.
  it("held repeats: 60 record no offer, the 61st does, then the grace runs out", async () => {
    const { agent, ledger, req, deps } = await setup("not-yet-valid-held");
    const key = agent.jwk.x as string;
    for (let i = 0; i < 60; i++)
      expect((await decide(req, CFG, deps)).action).toBe("offer");
    expect(ledger.get(key)).toMatchObject({ offersSent: 0, heldInWindow: 60 });
    expect((await decide(req, CFG, deps)).action).toBe("offer");
    expect(ledger.get(key)?.offersSent).toBe(1);
    // Repeats 62 and 63 spend the rest of the grace (3); 64 is the maze.
    const actions: string[] = [];
    for (let i = 0; i < 3; i++)
      actions.push((await decide(req, CFG, deps)).action);
    expect(actions).toEqual(["offer", "offer", "consequence"]);
    expect(ledger.get(key)?.offersSent).toBe(3);
  });

  it("held repeats at the cap with the grace already spent: the consequence", async () => {
    const { agent, ledger, req, deps } = await setup("not-yet-valid-held");
    const key = agent.jwk.x as string;
    for (let i = 0; i < 2; i++) ledger.recordOffer(key, NOW * 1000, 600_000);
    for (let i = 0; i < 61; i++)
      expect((await decide(req, CFG, deps)).action).toBe("offer");
    expect(ledger.get(key)?.offersSent).toBe(3);
    expect((await decide(req, CFG, deps)).action).toBe("consequence");
  });

  it("held repeats from an anonymous agent are never ledgered", async () => {
    const { ledger, deps } = await setup("not-yet-valid-held");
    // No signature headers: anonymous-agent, the same deps and ledger.
    const anon = { ...crawler, payment: "xp" };
    for (let i = 0; i < 65; i++) {
      const decision = await decide(anon, CFG, deps);
      expect(decision.action).toBe("offer");
      expect(decision.identity?.kind).toBe("anonymous-agent");
    }
    expect(ledger.size).toBe(0);
  });

  it("an already-exhausted agent with an operator-fault payment gets the offer", async () => {
    const { agent, ledger, req, deps } = await setup("settle-retryable");
    const key = agent.jwk.x as string;
    for (let i = 0; i < 3; i++) ledger.recordOffer(key, NOW * 1000, 600_000);
    expect(ledger.exhausted(key, NOW * 1000, 600_000, 3)).toBe(true);
    expect((await decide(req, CFG, deps)).action).toBe("offer");
    expect(ledger.get(key)?.offersSent).toBe(3);
  });

  it("a payer fault (expired) keeps the consequence after the grace", async () => {
    const { agent, ledger, req, deps } = await setup("expired");
    const actions: string[] = [];
    for (let i = 0; i < 4; i++)
      actions.push((await decide(req, CFG, deps)).action);
    expect(actions).toEqual(["offer", "offer", "offer", "consequence"]);
    expect(ledger.get(agent.jwk.x as string)?.offersSent).toBe(3);
  });
});
