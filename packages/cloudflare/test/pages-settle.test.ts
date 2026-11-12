// T-025 acceptance: settle-then-serve. A locally-valid x402 payment passes
// ONLY when the settle endpoint reports settled:true; everything else —
// on-chain failure, garbage, missing configuration — stays 402. Facilitator
// damping: an exact payment already seen is never relayed twice, and a payer
// with repeated fresh failures is cooled down locally (ADR-004).
import { parseConfig } from "@tunnelmindai/fareseal-core";
import { describe, expect, it, vi } from "vitest";
import {
  makeAuth,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import {
  createPagesMiddleware,
  makeSettlingVerify,
  SETTLE_BUCKET_CAP,
} from "../src/index.js";
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

  // T001: the settle route may name the id `transaction` or `tx`.
  const txOf = (r: Response) =>
    JSON.parse(atob(r.headers.get("x-payment-response") ?? "")).transaction;

  it("a settle answering only `tx` surfaces it as the transaction", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe("0xTX");
  });

  it("a settle answering only `transaction` surfaces it", async () => {
    const b = settleBinding({ settled: true, transaction: "0xTXHASH" });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe("0xTXHASH");
  });

  it("with both `transaction` and `tx`, `transaction` wins", async () => {
    const b = settleBinding({
      settled: true,
      transaction: "0xWIN",
      tx: "0xLOSE",
    });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe("0xWIN");
  });

  it("settled:true with no transaction id stays 402 and is never re-settled", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc" });
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

  it("a valid payment that FAILS to settle stays 402 — no free content", async () => {
    const b = settleBinding({ settled: false, reason: "insufficient_funds" });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(402);
  });

  it("a garbage payment never reaches the settle endpoint", async () => {
    const b = settleBinding({ settled: true, tx: "0xTX" });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": "not-a-payment" }), envOf(b)),
    );
    expect(r.status).toBe(402);
    expect(b.settles.length).toBe(0);
  });

  it("an X-PAYMENT over 8192 chars is malformed and never settled (T002 F2)", async () => {
    // A fresh valid payment padded with an extra field: still decodes and
    // verifies, but is longer than MAX_X_PAYMENT_CHARS.
    const p = JSON.parse(atob(freshPayment()));
    p.pad = "x".repeat(6200);
    const big = btoa(JSON.stringify(p));
    expect(big.length).toBeGreaterThan(8192);
    for (const xp of [big, "A".repeat(8193)]) {
      const b = settleBinding({ settled: true, tx: "0xTX" });
      const r = await settlingMw()(
        ctx("/research", agent({ "x-payment": xp }), envOf(b)),
      );
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe("malformed X-PAYMENT header");
      expect(b.settles.length).toBe(0);
    }
  });

  it("no settle token → a valid payment fails closed", async () => {
    const b = settleBinding({ settled: true, tx: "0xTX" });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), { DATA_API: b }),
    );
    expect(r.status).toBe(402);
    expect(b.settles.length).toBe(0);
  });

  it("no settle option at all → payments cannot buy passage (verify-only is not enough)", async () => {
    const b = settleBinding({ settled: true, tx: "0xTX" });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
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

  it("a replayed nonce's 402 says the nonce is already used", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const mw = settlingMw();
    const xp = freshPayment();
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(200);
    const replay = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)));
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("nonce already used");
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

  it("concurrent identical payments settle once and only the first passes", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" }, 20);
    const mw = settlingMw();
    // Warm the isolate state first: a cold burst builds one state per request.
    await mw(ctx("/r", agent(), envOf(b)));
    const xp = freshPayment();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () =>
        mw(ctx("/r", agent({ "x-payment": xp }), envOf(b))),
      ),
    );
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 402).length).toBe(9);
    expect(b.settles.length).toBe(1);
  });

  it("a re-encoded copy of a settled payment is refused without a settle", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const mw = settlingMw();
    const xp = freshPayment();
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(200);
    const reencoded = btoa(JSON.stringify(JSON.parse(atob(xp)), null, 1));
    expect(reencoded).not.toBe(xp);
    // Valid on its own: a fresh isolate would settle it.
    const fresh = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const mw = settlingMw();
    // 31 bytes: the signed bytes32 nonce is 0x00 followed by these.
    const hex = "ab".repeat(31);
    const xp = freshPayment("0.001", hex);
    const spellings = [`0x00${hex}`, `zz${hex}`, `0X${hex.toUpperCase()}`];
    // Each spelling verifies on its own: a fresh isolate would settle it.
    for (const n of spellings) {
      const fresh = settleBinding({
        settled: true,
        payer: "0xabc",
        tx: "0xTX",
      });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" }, 20);
    const mw = settlingMw();
    await mw(ctx("/r", agent(), envOf(b)));
    const hex = "cd".repeat(31);
    const xp = freshPayment("0.001", hex);
    const rs = await Promise.all(
      [`0x${hex}`, `0x00${hex}`, `zz${hex}`, `0x${hex.toUpperCase()}`].map(
        (n) => mw(ctx("/r", agent({ "x-payment": respell(xp, n) }), envOf(b))),
      ),
    );
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 402).length).toBe(3);
    expect(b.settles.length).toBe(1);
  });

  it("past the per-isolate settle budget, payments are throttled without a facilitator call", async () => {
    const outcome: Record<string, unknown> = {
      settled: true,
      payer: "0xabc",
      tx: "0xTX",
    };
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
    const b = settleBinding({ settled: true, tx: "0xTX" });
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

// T004: an operator-side settle failure (our config, our facilitator, our
// 5xx) must not burn the payer's nonce or count toward their cooldown.
const OPERATOR_FAULT =
  "settlement unavailable (operator fault); retry the same payment";

/** A settle endpoint answering `status` with `body` verbatim. */
function rawSettleBinding(status: number, body: unknown) {
  const b = {
    settles: 0,
    fetch: async (req: Request) => {
      if (req.url === SETTLE_URL) {
        b.settles += 1;
        // A string body is sent raw (e.g. a proxy's HTML error page).
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return new Response(text, { status });
      }
      return new Response("{}", { status: 200 });
    },
  };
  return b;
}

describe("makeSettlingVerify — operator-side settle failures (T004)", () => {
  const classes: [string, number, unknown][] = [
    ["HTTP 401 {ok:false,error}", 401, { ok: false, error: "bad token" }],
    ["HTTP 503", 503, { ok: false, error: "down" }],
    ["HTTP 502 non-JSON body", 502, "<html>Bad Gateway</html>"],
    [
      "retryable:true",
      200,
      { ok: true, data: { settled: false, retryable: true } },
    ],
    [
      "settlement-not-configured",
      200,
      {
        ok: true,
        data: { settled: false, reason: "settlement-not-configured" },
      },
    ],
    [
      "verify-error: timeout",
      200,
      { ok: true, data: { settled: false, reason: "verify-error: timeout" } },
    ],
    [
      "settle-error: boom",
      200,
      { ok: true, data: { settled: false, reason: "settle-error: boom" } },
    ],
    [
      "settle-failed(502)",
      200,
      { ok: true, data: { settled: false, reason: "settle-failed(502)" } },
    ],
  ];
  for (const [name, status, body] of classes) {
    it(`${name}: retryable, not cached, no cooldown, operator-fault 402`, async () => {
      const b = rawSettleBinding(status, body);
      const verify = makeSettlingVerify(
        (url, init) => b.fetch(new Request(url, init)),
        SETTLE_URL,
        "settle-secret",
      );
      const cfg = parseConfig(toml());
      const xp = freshPayment();
      expect(await verify(xp, cfg)).toMatchObject({
        ok: false,
        reason: "settle-retryable",
      });
      expect(await verify(xp, cfg)).toMatchObject({
        reason: "settle-retryable",
      });
      expect(b.settles).toBe(2);
      // Same payer, fresh nonces: still no cooldown after four more.
      for (let i = 0; i < 4; i++) await verify(freshPayment(), cfg);
      expect((await verify(freshPayment(), cfg)).reason).toBe(
        "settle-retryable",
      );
      expect(b.settles).toBe(7);
      // Through the middleware, the payer is told it is our fault.
      const r = await settlingMw()(
        ctx("/r", agent({ "x-payment": freshPayment() }), envOf(b)),
      );
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe(OPERATOR_FAULT);
    });
  }

  it("payer-side insufficient_funds is still cached and still cools down", async () => {
    const b = rawSettleBinding(200, {
      ok: true,
      data: { settled: false, reason: "insufficient_funds" },
    });
    const verify = makeSettlingVerify(
      (url, init) => b.fetch(new Request(url, init)),
      SETTLE_URL,
      "settle-secret",
    );
    const cfg = parseConfig(toml());
    const xp = freshPayment();
    expect((await verify(xp, cfg)).reason).toBe("insufficient_funds");
    expect((await verify(xp, cfg)).reason).toBe("insufficient_funds");
    expect(b.settles).toBe(1);
    for (let i = 0; i < 4; i++) await verify(freshPayment(), cfg);
    expect((await verify(freshPayment(), cfg)).reason).toBe("payer-cooldown");
  });
});

describe("createPagesMiddleware — settle carries the resource (E003)", () => {
  it("the settle body carries origin+pathname+search, no fragment", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const r = await settlingMw()(
      ctx("/a/b?x=1#frag", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(b.settles[0]?.body.resource).toBe("https://site.example/a/b?x=1");
  });

  it("a query string is kept in the resource", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    await settlingMw()(
      ctx(
        "/research?page=2&q=x",
        agent({ "x-payment": freshPayment() }),
        envOf(b),
      ),
    );
    expect(b.settles[0]?.body.resource).toBe(
      "https://site.example/research?page=2&q=x",
    );
  });

  it("without a resource (direct adapter call) the body has no resource key", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const verify = makeSettlingVerify(
      (url, init) => b.fetch(new Request(url, init)),
      SETTLE_URL,
      "settle-secret",
    );
    const r = await verify(freshPayment(), parseConfig(toml()));
    expect(r.ok).toBe(true);
    expect(Object.keys(b.settles[0]?.body ?? {}).sort()).toEqual([
      "payment",
      "price_usd",
    ]);
  });
});

describe("createPagesMiddleware — mainnet (B008)", () => {
  it("the settling adapter declares settles:true, so base mainnet starts", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: "0xTX" });
    const mw = createPagesMiddleware({
      config: toml().replace('network = "base-sepolia"', 'network = "base"'),
      settle: { url: SETTLE_URL },
      binding: "DATA_API",
    });
    // Unpaid agent: the offer is built, not a startup refusal.
    const r = await mw(ctx("/research", agent(), envOf(b)));
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({
      accepts: [{ network: "base" }],
    });
  });
});
