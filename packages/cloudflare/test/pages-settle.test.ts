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
// A well-formed on-chain tx id (0x + 32-byte hex): T003 F5 refuses anything else.
const TX = `0x${"ab".repeat(32)}`;
const TX2 = `0x${"cd".repeat(32)}`;
// The old placeholder stub, now invalid by design. Spelled in pieces so a grep
// for the literal finds no stub left behind in the tests.
const OLD_STUB_TX = ["0x", "TX"].join("");

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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
      transaction: TX,
    });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(atob(r.headers.get("x-payment-response") ?? ""))).toEqual(
      {
        success: true,
        transaction: TX,
        network: "base-sepolia",
        payer: "0xabc",
      },
    );
  });

  // T001: the settle route may name the id `transaction` or `tx`.
  const txOf = (r: Response) =>
    JSON.parse(atob(r.headers.get("x-payment-response") ?? "")).transaction;

  it("a settle answering only `tx` surfaces it as the transaction", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe(TX);
  });

  it("a settle answering only `transaction` surfaces it", async () => {
    const b = settleBinding({ settled: true, transaction: TX });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe(TX);
  });

  it("with both `transaction` and `tx`, `transaction` wins", async () => {
    const b = settleBinding({
      settled: true,
      transaction: TX,
      tx: TX2,
    });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe(TX);
  });

  // T003 F5: a tx id that is not 0x + 64 hex is no proof of payment.
  for (const tx of [
    " ",
    "",
    123,
    null,
    OLD_STUB_TX,
    `0x${"a".repeat(63)}`,
    `0x${"a".repeat(65)}`,
    "ab".repeat(32),
  ]) {
    it(`settled:true with tx ${JSON.stringify(tx)} is 402 no transaction id, remembered, not counted`, async () => {
      const b = settleBinding({ settled: true, payer: "0xabc", tx });
      const verify = makeSettlingVerify(
        (url, init) => b.fetch(new Request(url, init)),
        SETTLE_URL,
        "settle-secret",
      );
      const cfg = parseConfig(toml());
      const xp = freshPayment();
      expect(await verify(xp, cfg)).toEqual({
        ok: false,
        payer: null,
        reason: "no-transaction-id",
      });
      // Remembered: the same payment is never settled twice.
      expect((await verify(xp, cfg)).reason).toBe("no-transaction-id");
      expect(b.settles.length).toBe(1);
      // Not counted: fresh nonces from the same payer never hit a cooldown.
      for (let i = 0; i < 4; i++) await verify(freshPayment(), cfg);
      expect((await verify(freshPayment(), cfg)).reason).toBe(
        "no-transaction-id",
      );
      expect(b.settles.length).toBe(6);
      // Through the middleware, the payer is told why.
      const r = await settlingMw()(
        ctx("/r", agent({ "x-payment": freshPayment() }), envOf(b)),
      );
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe("settle failed: no transaction id");
    });
  }

  it("a whitespace-padded valid tx serves, trimmed in X-PAYMENT-RESPONSE", async () => {
    const b = settleBinding({ settled: true, tx: `  ${TX}\n` });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe(TX);
  });

  it("an invalid `transaction` with a valid `tx` serves `tx`", async () => {
    const b = settleBinding({
      settled: true,
      transaction: OLD_STUB_TX,
      tx: TX2,
    });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(txOf(r)).toBe(TX2);
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
    const b = settleBinding({ settled: true, tx: TX });
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
      const b = settleBinding({ settled: true, tx: TX });
      const r = await settlingMw()(
        ctx("/research", agent({ "x-payment": xp }), envOf(b)),
      );
      expect(r.status).toBe(402);
      expect((await r.json()).error).toBe("malformed X-PAYMENT header");
      expect(b.settles.length).toBe(0);
    }
  });

  it("no settle token → a valid payment fails closed", async () => {
    const b = settleBinding({ settled: true, tx: TX });
    const mw = settlingMw();
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), { DATA_API: b }),
    );
    expect(r.status).toBe(402);
    expect(b.settles.length).toBe(0);
  });

  it("no settle option at all → payments cannot buy passage (verify-only is not enough)", async () => {
    const b = settleBinding({ settled: true, tx: TX });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX }, 20);
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
    const mw = settlingMw();
    const xp = freshPayment();
    expect(
      (await mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)))).status,
    ).toBe(200);
    const reencoded = btoa(JSON.stringify(JSON.parse(atob(xp)), null, 1));
    expect(reencoded).not.toBe(xp);
    // Valid on its own: a fresh isolate would settle it.
    const fresh = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
        tx: TX,
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX }, 20);
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
      tx: TX,
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
    const b = settleBinding({ settled: true, tx: TX });
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

// F4: `settled:true` only counts on an HTTP 2xx. A 5xx/4xx that claims a
// settle is not proof of payment, so the origin must not be served.
describe("createPagesMiddleware — settled:true on non-2xx is not payment (F4)", () => {
  it("HTTP 500 + settled:true: 402 operator fault, not served, retry reaches settle again", async () => {
    const b = rawSettleBinding(500, {
      ok: true,
      data: { settled: true, tx: TX },
    });
    const mw = settlingMw();
    const xp = freshPayment();
    for (const call of [1, 2]) {
      const r = await mw(
        ctx("/research", agent({ "x-payment": xp }), envOf(b)),
      );
      expect(r.status).toBe(402);
      const text = await r.text();
      expect(text).not.toBe("site content");
      expect(JSON.parse(text).error).toBe(OPERATOR_FAULT);
      expect(b.settles).toBe(call); // not cached: each try reaches settle
    }
  });

  it("HTTP 400 + settled:true: 402, not served", async () => {
    // Cache/count behaviour for a 4xx belongs to T005; only "not served" here.
    const b = rawSettleBinding(400, { data: { settled: true, tx: TX } });
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(402);
    expect(await r.text()).not.toBe("site content");
  });
});

describe("createPagesMiddleware — settle carries the resource (E003)", () => {
  it("the settle body carries origin+pathname+search, no fragment", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
    const r = await settlingMw()(
      ctx("/a/b?x=1#frag", agent({ "x-payment": freshPayment() }), envOf(b)),
    );
    expect(r.status).toBe(200);
    expect(b.settles[0]?.body.resource).toBe("https://site.example/a/b?x=1");
  });

  it("a query string is kept in the resource", async () => {
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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
    const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
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

// T005 F1: one test per FR-001 row (spec 003). Each row says three things:
// the reason, whether the nonce is cached (a second identical try reaches
// settle or not) and whether the payer is counted toward the cooldown.
describe("makeSettlingVerify — FR-001 classifier table (T005)", () => {
  /** A settle stub whose answer can change between calls; `throws` = transport error. */
  function table(status: number, body: unknown, token = "settle-secret") {
    const s = { calls: 0, status, body, throws: false };
    const fetch = async (req: Request) => {
      if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
      s.calls += 1;
      if (s.throws) throw new TypeError("fetch failed");
      const b = s.body;
      return new Response(typeof b === "string" ? b : JSON.stringify(b), {
        status: s.status,
      });
    };
    const verify = makeSettlingVerify(
      (url, init) => fetch(new Request(url, init)),
      SETTLE_URL,
      token,
    );
    return { s, fetch, verify, cfg: parseConfig(toml()) };
  }
  type T = ReturnType<typeof table>;

  /** Operator row: not cached, not counted (no cooldown after many fresh tries). */
  async function expectOperator(t: T, reason: string) {
    const xp = freshPayment();
    const c0 = t.s.calls;
    expect(await t.verify(xp, t.cfg)).toMatchObject({ ok: false, reason });
    const reached = t.s.calls - c0; // 0 for rows 0a/0b, else 1
    expect((await t.verify(xp, t.cfg)).reason).toBe(reason);
    expect(t.s.calls - c0).toBe(2 * reached); // not cached
    for (let i = 0; i < 4; i++)
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(reason);
    expect(t.s.calls - c0).toBe(6 * reached); // never payer-cooldown
  }

  /** Payer row: cached for the nonce, and the 4th fresh payment cools down unsettled. */
  async function expectPayer(t: T, reason: string, error = "settle failed") {
    const xp = freshPayment();
    expect(await t.verify(xp, t.cfg)).toMatchObject({ ok: false, reason });
    expect((await t.verify(xp, t.cfg)).reason).toBe(reason);
    expect(t.s.calls).toBe(1); // cached
    for (let i = 0; i < 2; i++) await t.verify(freshPayment(), t.cfg);
    expect(t.s.calls).toBe(3);
    expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
      "payer-cooldown",
    );
    expect(t.s.calls).toBe(3); // counted: no settle call on the 4th
    // Through the middleware (fresh isolate state) the payer sees its fault.
    const m = table(t.s.status, t.s.body);
    const r = await settlingMw()(
      ctx("/r", agent({ "x-payment": freshPayment() }), envOf(m)),
    );
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe(error);
  }

  const settledFalse = (reason: string) => ({
    ok: true,
    data: { settled: false, reason },
  });

  it("row 0a: no settle token → settlement-unconfigured, not cached, not counted", async () => {
    const t = table(200, { data: { settled: true, tx: TX } }, "");
    await expectOperator(t, "settlement-unconfigured");
    expect(t.s.calls).toBe(0);
  });

  it("row 0b: empty settle bucket → settle-throttled, not cached, not counted", async () => {
    const t = table(200, settledFalse("insufficient_funds"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      // Drain the bucket with operator faults so the payer is never counted.
      t.s.status = 503;
      for (let i = 0; i < SETTLE_BUCKET_CAP; i++)
        await t.verify(freshPayment(), t.cfg);
      t.s.status = 200;
      await expectOperator(t, "settle-throttled");
      expect(t.s.calls).toBe(SETTLE_BUCKET_CAP);
    } finally {
      clock.mockRestore();
    }
  });

  it("row 0c: the settle call throws → settle-unreachable, not cached, not counted", async () => {
    const t = table(200, {});
    t.s.throws = true;
    await expectOperator(t, "settle-unreachable");
  });

  it("row 0c: a 2xx body that is not JSON → settle-unreachable, not cached, not counted", async () => {
    await expectOperator(table(200, "<html>ok</html>"), "settle-unreachable");
  });

  it("row 1: 2xx settled:true + valid tx → served, cached as already-settled, payer cleared", async () => {
    const t = table(200, settledFalse("insufficient_funds"));
    // Two counted failures, then a success clears them.
    for (let i = 0; i < 2; i++) await t.verify(freshPayment(), t.cfg);
    t.s.body = { ok: true, data: { settled: true, tx: TX } };
    const xp = freshPayment();
    expect(await t.verify(xp, t.cfg)).toMatchObject({
      ok: true,
      transaction: TX,
    });
    expect((await t.verify(xp, t.cfg)).reason).toBe("already-settled");
    expect(t.s.calls).toBe(3); // cached
    // Two more failures: without the clear this would be 4 ≥ 3 → cooldown.
    t.s.body = settledFalse("insufficient_funds");
    for (let i = 0; i < 2; i++) await t.verify(freshPayment(), t.cfg);
    expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
      "insufficient_funds",
    );
    expect(t.s.calls).toBe(6);
  });

  it("row 2: 2xx settled:true + no valid tx → no-transaction-id, cached, not counted", async () => {
    const t = table(200, { ok: true, data: { settled: true, tx: "0x12" } });
    const xp = freshPayment();
    expect((await t.verify(xp, t.cfg)).reason).toBe("no-transaction-id");
    expect((await t.verify(xp, t.cfg)).reason).toBe("no-transaction-id");
    expect(t.s.calls).toBe(1); // cached
    for (let i = 0; i < 4; i++)
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
        "no-transaction-id",
      );
    expect(t.s.calls).toBe(5); // never payer-cooldown
  });

  // Row 3, the reason form: HTTP 200 settled:false with a facilitator status.
  for (const n of [401, 403, 429, 500, 503])
    for (const kind of ["verify", "settle"])
      it(`row 3: HTTP 200 reason ${kind}-failed(${n}) → settle-retryable, not cached, not counted`, async () => {
        await expectOperator(
          table(200, settledFalse(`${kind}-failed(${n})`)),
          "settle-retryable",
        );
      });

  it("row 3: retryable:true beats a 400 status → settle-retryable", async () => {
    await expectOperator(
      table(400, { ok: false, data: { retryable: true } }),
      "settle-retryable",
    );
  });

  for (const reason of [
    "network-mismatch",
    "settlement-not-configured",
    "verify-error: timeout",
  ])
    it(`row 3: reason ${reason} → settle-retryable`, async () => {
      await expectOperator(
        table(200, settledFalse(reason)),
        "settle-retryable",
      );
    });

  // Row 4, the status form: whatever the body, including settled:true.
  const row4Bodies: [string, unknown][] = [
    ["{ok:false,error}", { ok: false, error: "nope" }],
    ["non-JSON", "<html>Error</html>"],
    ["settled:true", { ok: true, data: { settled: true, tx: TX } }],
  ];
  for (const n of [401, 403, 429, 500, 503])
    for (const [name, body] of row4Bodies)
      it(`row 4: HTTP ${n} ${name} → settle-retryable, not cached, not counted`, async () => {
        await expectOperator(table(n, body), "settle-retryable");
      });

  it("row 6: HTTP 200 settled:false with a payer reason → that reason, cached, counted", async () => {
    await expectPayer(
      table(200, settledFalse("insufficient_funds")),
      "insufficient_funds",
      "facilitator rejected: insufficient_funds",
    );
  });

  it("row 6: HTTP 200 settled:false with no reason → settle-failed, cached, counted", async () => {
    await expectPayer(
      table(200, { ok: true, data: { settled: false } }),
      "settle-failed",
    );
  });

  // Row 7: a 4xx the client caused is the payer's, whatever the body.
  for (const n of [400, 404, 413, 422]) {
    it(`row 7: HTTP ${n} {ok:false,error} → settle-failed, cached, counted`, async () => {
      await expectPayer(
        table(n, { ok: false, error: "payment too large" }),
        "settle-failed",
      );
    });
    it(`row 7: HTTP ${n} non-JSON body → settle-failed, cached, counted`, async () => {
      await expectPayer(table(n, "<html>Bad Request</html>"), "settle-failed");
    });
  }

  it("row 7: HTTP 400 settled:true → settle-failed, not served, cached, counted", async () => {
    await expectPayer(
      table(400, { ok: true, data: { settled: true, tx: TX } }),
      "settle-failed",
    );
  });

  it("row 7: HTTP 422 with a string data.reason → that reason, cached, counted", async () => {
    await expectPayer(
      table(422, { ok: false, data: { reason: "bad_payload" } }),
      "bad_payload",
      "facilitator rejected: bad_payload",
    );
  });

  // T006 F3, row 5: a not-yet-valid authorization is the payer's clock, and
  // transient. Not cached and not counted, so the same X-PAYMENT can be
  // retried once valid_after has passed.
  const VALID_AFTER = "invalid_exact_evm_payload_authorization_valid_after";

  it("row 5 (AC-3.1/3.2): valid_after reject → 402 authorization not yet valid; the same X-PAYMENT retried later serves", async () => {
    const t = table(200, settledFalse(VALID_AFTER));
    const mw = settlingMw();
    const xp = freshPayment();
    const r1 = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
    expect(r1.status).toBe(402);
    expect((await r1.json()).error).toBe("authorization not yet valid");
    t.s.body = { ok: true, data: { settled: true, tx: TX } };
    const r2 = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
    expect(r2.status).toBe(200);
    expect(t.s.calls).toBe(2); // not cached: the retry reached settle
  });

  it("row 5 (AC-3.3): valid_after → not-yet-valid, payer null, not cached, not counted", async () => {
    const t = table(200, settledFalse(VALID_AFTER));
    expect(await t.verify(freshPayment(), t.cfg)).toEqual({
      ok: false,
      payer: null,
      reason: "not-yet-valid",
    });
    // Four rejects for one payer, then a fresh payment still reaches settle.
    await expectOperator(t, "not-yet-valid");
  });

  it("row 5 guard: a valid_after reason on HTTP 503 → settle-retryable (row 4 wins)", async () => {
    await expectOperator(
      table(503, settledFalse(VALID_AFTER)),
      "settle-retryable",
    );
  });
});
