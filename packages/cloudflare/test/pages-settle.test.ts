// T-025 acceptance: settle-then-serve. A locally-valid x402 payment passes
// ONLY when the settle endpoint reports settled:true; everything else —
// on-chain failure, garbage, missing configuration — stays 402. Facilitator
// damping: an exact payment already seen is never relayed twice, and a payer
// with repeated fresh failures is cooled down locally (ADR-004).
import { describe, expect, it } from "vitest";
import {
  makeAuth,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import { createPagesMiddleware } from "../src/index.js";
import { agent, ctx, toml } from "./helpers.js";

const SETTLE_URL = "https://collector.example/v1/settle";

function freshPayment(priceUsd = "0.001"): string {
  const nowS = Math.floor(Date.now() / 1000);
  const auth = makeAuth({
    value: String(Math.round(Number(priceUsd) * 1_000_000)),
    validAfter: "0",
    validBefore: String(nowS + 300),
    nonce: `0x${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`,
  });
  return payment(auth, signAuth(auth));
}

function settleBinding(outcome: Record<string, unknown>) {
  const b = {
    settles: [] as { auth: string | null; body: Record<string, unknown> }[],
    fetch: async (req: Request) => {
      if (req.url === SETTLE_URL) {
        b.settles.push({
          auth: req.headers.get("authorization"),
          body: (await req.json()) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, data: outcome }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    },
  };
  return b;
}

function settlingMw(price = "0.001") {
  return createPagesMiddleware({
    config: toml("", price),
    settle: { url: SETTLE_URL },
    binding: "DATA_API",
  });
}
const envOf = (b: { fetch: (req: Request) => Promise<Response> }) => ({
  TOLLBOOTH_SETTLE_TOKEN: "settle-secret",
  DATA_API: b,
});

describe("createPagesMiddleware — settle-then-serve", () => {
  it("a valid payment that settles on-chain passes, with the bearer and price forwarded", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const mw = settlingMw("0.002");
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment("0.002") }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(b.settles[0]?.auth).toBe("Bearer settle-secret");
    expect(b.settles[0]?.body.price_usd).toBe("0.002");
  });

  it("a valid payment that FAILS to settle stays 402 — no free content", async () => {
    const b = settleBinding({ settled: false, reason: "insufficient_funds" });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(402);
  });

  it("a garbage payment never reaches the settle endpoint", async () => {
    const b = settleBinding({ settled: true });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": "not-a-payment" }), envOf(b)),
    );
    expect(r.status).toBe(402);
    expect(b.settles.length).toBe(0);
  });

  it("no settle token → a valid payment fails closed", async () => {
    const b = settleBinding({ settled: true });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), { DATA_API: b }),
    );
    expect(r.status).toBe(402);
    expect(b.settles.length).toBe(0);
  });

  it("no settle option at all → payments cannot buy passage (verify-only is not enough)", async () => {
    const b = settleBinding({ settled: true });
    const mw = createPagesMiddleware({ config: toml(), binding: "DATA_API" });
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(402);
  });

  it("a failed payment is never relayed twice", async () => {
    const b = settleBinding({ settled: false, reason: "nonce_used" });
    const mw = settlingMw();
    const xp = freshPayment();
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(402);
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(402);
    expect(b.settles.length).toBe(1);
  });

  it("a settled payment replayed on a later request is rejected from cache", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc" });
    const mw = settlingMw();
    const xp = freshPayment();
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(200);
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(402);
    expect(b.settles.length).toBe(1);
  });

  it("a payer with repeated fresh failures gets a cooldown, not more facilitator calls", async () => {
    const b = settleBinding({ settled: false, reason: "insufficient_funds" });
    const mw = settlingMw();
    for (let i = 0; i < 5; i++) {
      const r = await mw(
        ctx("/r", agent({ "x-payment": freshPayment() }), envOf(b)),
      );
      expect(r.status).not.toBe(200);
    }
    expect(b.settles.length).toBe(3);
  });

  it("the authed report says settling:true when the wire is live", async () => {
    const b = settleBinding({ settled: true });
    const mw = createPagesMiddleware({
      config: toml("report-token-3"),
      settle: { url: SETTLE_URL },
      binding: "DATA_API",
    });
    const r = await mw(
      ctx(
        "/_tollbooth/report",
        { authorization: "Bearer report-token-3" },
        envOf(b),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("x-tollbooth-settling")).toBe("true");
  });
});
