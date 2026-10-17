// T-025 acceptance: settle-then-serve. A locally-valid x402 payment passes
// ONLY when the settle endpoint reports settled:true; everything else —
// on-chain failure, garbage, missing configuration — stays 402. Facilitator
// damping: an exact payment already seen is never relayed twice, and a payer
// with repeated fresh failures is cooled down locally (ADR-004).
import { describe, expect, it, vi } from "vitest";
import {
  makeAuth,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import { createPagesMiddleware, SETTLE_BUCKET_CAP } from "../src/index.js";
import { agent, ctx, toml } from "./helpers.js";

const SETTLE_URL = "https://collector.example/v1/settle";

function freshPayment(priceUsd = "0.001", nonceHex?: string): string {
  const nowS = Math.floor(Date.now() / 1000);
  const auth = makeAuth({
    value: String(Math.round(Number(priceUsd) * 1_000_000)),
    validAfter: "0",
    validBefore: String(nowS + 300),
    nonce: `0x${nonceHex ?? (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`,
  });
  return payment(auth, signAuth(auth));
}

/** Same payment and signature, nonce field rewritten to `nonce`. */
function respell(xp: string, nonce: string): string {
  const p = JSON.parse(atob(xp));
  p.payload.authorization.nonce = nonce;
  return btoa(JSON.stringify(p));
}

function settleBinding(outcome: Record<string, unknown>, delayMs = 0) {
  const b = {
    settles: [] as { auth: string | null; body: Record<string, unknown> }[],
    fetch: async (req: Request) => {
      if (req.url === SETTLE_URL) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
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

  it("the settle transaction surfaces in X-PAYMENT-RESPONSE", async () => {
    const b = settleBinding({
      settled: true,
      payer: "0xabc",
      transaction: "0xTXHASH",
    });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(atob(r.headers.get("x-payment-response") ?? ""))).toEqual(
      {
        success: true,
        transaction: "0xTXHASH",
        network: "base-sepolia",
        payer: "0xabc",
      },
    );
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

  it("concurrent identical payments settle once and all pass", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc" }, 20);
    const mw = settlingMw();
    // Warm the isolate state first: a cold burst builds one state per request.
    await mw(ctx("/r", agent(), envOf(b)));
    const xp = freshPayment();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () =>
        mw(ctx("/r", agent({ "x-payment": xp }), envOf(b))),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(b.settles.length).toBe(1);
  });

  it("a re-encoded copy of a settled payment is refused without a settle", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc" });
    const mw = settlingMw();
    const xp = freshPayment();
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(200);
    const reencoded = btoa(JSON.stringify(JSON.parse(atob(xp)), null, 1));
    expect(reencoded).not.toBe(xp);
    // Valid on its own: a fresh isolate would settle it.
    const fresh = settleBinding({ settled: true, payer: "0xabc" });
    expect(
      (
        await settlingMw()(
          ctx("/r", agent({ "x-payment": reencoded }), envOf(fresh)),
        )
      ).status,
    ).toBe(200);
    expect(
      (await mw(ctx("/r", agent({ "x-payment": reencoded }), envOf(b)))).status,
    ).toBe(402);
    expect(b.settles.length).toBe(1);
  });

  it("other spellings of a settled nonce (prefix, leading zeros, case) are refused without a settle", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc" });
    const mw = settlingMw();
    // 31 bytes: the signed bytes32 nonce is 0x00 followed by these.
    const hex = "ab".repeat(31);
    const xp = freshPayment("0.001", hex);
    const spellings = [`0x00${hex}`, `zz${hex}`, `0X${hex.toUpperCase()}`];
    // Each spelling verifies on its own: a fresh isolate would settle it.
    for (const n of spellings) {
      const fresh = settleBinding({ settled: true, payer: "0xabc" });
      expect(
        (
          await settlingMw()(
            ctx("/r", agent({ "x-payment": respell(xp, n) }), envOf(fresh)),
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(200);
    for (const n of spellings) {
      const r = await mw(
        ctx("/r", agent({ "x-payment": respell(xp, n) }), envOf(b)),
      );
      expect(r.status).toBe(402);
    }
    expect(b.settles.length).toBe(1);
  });

  it("a concurrent burst of nonce spellings settles once", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc" }, 20);
    const mw = settlingMw();
    await mw(ctx("/r", agent(), envOf(b)));
    const hex = "cd".repeat(31);
    const xp = freshPayment("0.001", hex);
    const rs = await Promise.all(
      [`0x${hex}`, `0x00${hex}`, `zz${hex}`, `0x${hex.toUpperCase()}`].map(
        (n) => mw(ctx("/r", agent({ "x-payment": respell(xp, n) }), envOf(b))),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(b.settles.length).toBe(1);
  });

  it("past the per-isolate settle budget, payments are throttled without a facilitator call", async () => {
    const outcome: Record<string, unknown> = { settled: true, payer: "0xabc" };
    const b = settleBinding(outcome);
    const mw = settlingMw();
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      for (let i = 0; i < SETTLE_BUCKET_CAP; i++) {
        const r = await mw(
          ctx("/r", agent({ "x-payment": freshPayment() }), envOf(b)),
        );
        expect(r.status).toBe(200);
      }
      const throttled = Array.from({ length: 3 }, () => freshPayment());
      for (const xp of throttled) {
        const r = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)));
        expect(r.status).toBe(402);
      }
      expect(b.settles.length).toBe(SETTLE_BUCKET_CAP);
      // One second refills the bucket. The throttled payment was never
      // cached as seen, so it settles now.
      clock.mockReturnValue(t0 + 1000);
      expect(
        (
          await mw(
            ctx("/r", agent({ "x-payment": throttled[0] ?? "" }), envOf(b)),
          )
        ).status,
      ).toBe(200);
      // Three throttles did not count as payer failures: a failing payment
      // still reaches the facilitator instead of hitting payer-cooldown.
      outcome.settled = false;
      await mw(ctx("/r", agent({ "x-payment": freshPayment() }), envOf(b)));
      expect(b.settles.length).toBe(SETTLE_BUCKET_CAP + 2);
    } finally {
      clock.mockRestore();
    }
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
