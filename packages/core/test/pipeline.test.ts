import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { decide } from "../src/pipeline.js";
import { dirWith, makeAgent, NOW, signedRequest } from "./fixtures/wba.js";

const TOLL_CFG = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "0xabc"
`);

const STRIPE_CFG = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "0xabc"
[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "whsec_x"
`);

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const human = {
  path: "/article",
  authority: "example.com",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: BROWSER_ACCEPT,
  hasCookies: false,
};

const crawler = {
  path: "/article",
  authority: "example.com",
  userAgent: "curl/8.7.1",
  accept: "*/*",
  hasCookies: false,
};

const deps = (fetchDirectory = dirWith()) => ({ fetchDirectory, nowS: NOW });

describe("step 1 - free paths pass before any other logic (AC-5.3)", () => {
  it("passes everyone, without ever calling the directory fetcher", async () => {
    let fetched = false;
    const spyFetch = async () => {
      fetched = true;
      return { keys: [] };
    };
    const agent = await makeAgent();
    const req = {
      ...crawler,
      ...(await signedRequest(agent)),
      path: "/robots.txt",
    };
    const decision = await decide(req, TOLL_CFG, {
      fetchDirectory: spyFetch,
      nowS: NOW,
    });
    expect(decision).toEqual({
      action: "pass",
      reason: "free-path",
      identity: null,
    });
    expect(fetched).toBe(false);
  });

  it("supports prefix entries ending in a slash", async () => {
    const cfg = parseConfig(`free_paths = ["/public/"]`);
    const decision = await decide(
      { ...crawler, path: "/public/data.json" },
      cfg,
      deps(),
    );
    expect(decision.action).toBe("pass");
  });
});

describe("steps 2-3 - humans pass untouched (US-5)", () => {
  it("AC-5.1: no signature, no heuristic match -> pass", async () => {
    const decision = await decide(human, TOLL_CFG, deps());
    expect(decision).toEqual({
      action: "pass",
      reason: "human",
      identity: { kind: "human" },
    });
  });

  it("AC-5.2: ambiguous browser subresource shape -> pass", async () => {
    const req = { ...human, accept: "*/*", secFetchSite: "same-origin" };
    expect((await decide(req, TOLL_CFG, deps())).action).toBe("pass");
  });
});

describe("step 2 - the identification ladder (D-4)", () => {
  it("(a) verified WBA signature -> identified agent, offered", async () => {
    const agent = await makeAgent();
    const req = { ...crawler, ...(await signedRequest(agent)) };
    const decision = await decide(req, TOLL_CFG, deps(dirWith(agent.jwk)));
    expect(decision.action).toBe("offer");
    expect(decision.identity).toEqual({ kind: "agent", agentKey: agent.jwk.x });
  });

  it("(b) cryptographically invalid signature -> spoofer (consequence, wired at T-017)", async () => {
    const agent = await makeAgent();
    const req = {
      ...crawler,
      ...(await signedRequest(agent)),
      authority: "evil.example",
    };
    const decision = await decide(req, TOLL_CFG, deps(dirWith(agent.jwk)));
    if (decision.action !== "consequence")
      throw new Error("expected consequence");
    expect(decision.identity.kind).toBe("spoofer");
    if (decision.identity.kind === "spoofer") {
      expect(decision.identity.claimedKey).toBe(agent.jwk.x);
    }
  });

  it("stale-but-valid signature -> anonymous, offered, never spoof (IV.13)", async () => {
    const agent = await makeAgent();
    const req = {
      ...crawler,
      ...(await signedRequest(agent, { expires: NOW - 400 })),
    };
    const decision = await decide(req, TOLL_CFG, deps(dirWith(agent.jwk)));
    expect(decision.action).toBe("offer");
    expect(decision.identity).toEqual({
      kind: "anonymous-agent",
      via: ["wba-stale"],
    });
  });

  it("unknown key -> anonymous, not spoof (could be key rotation)", async () => {
    const agent = await makeAgent();
    const other = await makeAgent();
    const req = { ...crawler, ...(await signedRequest(agent)) };
    const decision = await decide(req, TOLL_CFG, deps(dirWith(other.jwk)));
    expect(decision.action).toBe("offer");
    expect(decision.identity).toEqual({
      kind: "anonymous-agent",
      via: ["wba-unknown_key"],
    });
  });

  it("unreachable directory -> anonymous, offered (cannot verify is not forgery)", async () => {
    const agent = await makeAgent();
    const req = { ...crawler, ...(await signedRequest(agent)) };
    const failing = async () => {
      throw new Error("503");
    };
    const decision = await decide(req, TOLL_CFG, {
      fetchDirectory: failing,
      nowS: NOW,
    });
    expect(decision.action).toBe("offer");
    expect(decision.identity).toEqual({
      kind: "anonymous-agent",
      via: ["wba-directory_unreachable"],
    });
  });

  it("malformed WBA headers -> anonymous (broken client, not attacker)", async () => {
    const req = {
      ...crawler,
      signature: "??",
      signatureInput: "!!",
      signatureAgent: "nope",
    };
    const decision = await decide(req, TOLL_CFG, deps());
    expect(decision.action).toBe("offer");
    expect(decision.identity).toEqual({
      kind: "anonymous-agent",
      via: ["wba-malformed"],
    });
  });

  it("(c) heuristic agent -> anonymous, offered, with the matched rules as facts", async () => {
    const decision = await decide(crawler, TOLL_CFG, deps());
    if (decision.action !== "offer") throw new Error("expected offer");
    expect(decision.identity.kind).toBe("anonymous-agent");
    if (decision.identity.kind === "anonymous-agent") {
      expect(decision.identity.via).toContain("ua-prefix:curl/");
    }
  });
});

describe("step 8 - the 402 offer body (AC-2.1 shape, AC-7.2 machine-readable)", () => {
  it("lists the x402 option with price, pay-to and network from config", async () => {
    const decision = await decide(crawler, TOLL_CFG, deps());
    if (decision.action !== "offer") throw new Error("expected offer");
    expect(decision.body.v).toBe(1);
    expect(decision.body.price_usd).toBe("0.001");
    expect(decision.body.options).toEqual([
      {
        method: "x402",
        network: "base-sepolia",
        pay_to: "0xabc",
        price_usd: "0.001",
      },
    ]);
  });

  it("adds the stripe-voucher option when enabled, with everything needed to complete it", async () => {
    const decision = await decide(crawler, STRIPE_CFG, deps());
    if (decision.action !== "offer") throw new Error("expected offer");
    expect(decision.body.options).toHaveLength(2);
    expect(decision.body.options[1]).toEqual({
      method: "stripe-voucher",
      payment_link: "https://buy.stripe.com/test_123",
      credits: 5000,
      voucher_header: "Tollbooth-Voucher",
    });
  });
});
