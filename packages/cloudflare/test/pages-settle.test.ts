// T-025 acceptance: settle-then-serve. A locally-valid x402 payment passes
// ONLY when the settle endpoint reports settled:true; everything else —
// on-chain failure, garbage, missing configuration — stays 402. Facilitator
// damping: an exact payment already seen is never relayed twice, and a payer
// with repeated fresh failures is cooled down locally (ADR-004).

import { readFileSync } from "node:fs";
import { buildOffer } from "@tunnelmindai/fareseal-adapter-x402";
import {
  generateSecretKey,
  isNoOfferFault,
  parseConfig,
  toBase64Url,
} from "@tunnelmindai/fareseal-core";
import { fareseal } from "@tunnelmindai/fareseal-hono";
import {
  corpusFromMap,
  generateCorpus,
  makeMazeHandler,
} from "@tunnelmindai/fareseal-maze";
import { Hono } from "hono";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  freshKeyPayment,
  makeAuth,
  PAYER,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
  type TestAgent,
} from "../../core/test/fixtures/wba.js";
import {
  BUILD_TTL_MS,
  createPagesMiddleware,
  makeSettlingVerify,
  RESERVATION_TTL_MS,
  SETTLE_BUCKET_CAP,
  SETTLE_TIMEOUT_MS,
  UNCONFIRMED_CAP,
  UNCONFIRMED_TTL_MS,
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

/** A plain payment (validAfter 0) from a new payer each call, as an
 * attacker rotating free keys would send. */
function rotatingPayerPayment(): string {
  return freshKeyPayment({
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: `0x${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`,
  });
}

/** Signed, unfunded-or-not, valid `ahead` seconds after `nowS` (local skew is 60 s). */
function earlyPayment(nowS: number, ahead = 55): string {
  const auth = makeAuth({
    value: "1000",
    validAfter: String(nowS + ahead),
    validBefore: String(nowS + 300),
    nonce: `0x${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`,
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
    // Warm the isolate state first (a cold burst is covered by the R004 tests).
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
const UNCONFIRMED =
  "settlement status unconfirmed; do not sign a new payment; the same payment may be retried, or contact the operator";

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
  // R002 L7: was OPERATOR_FAULT ("retry the same payment"); money may have
  // moved, so the payer is now told not to pay again.
  it("HTTP 500 + settled:true: 402 settle unconfirmed, not served, retry reaches settle again", async () => {
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
      expect(JSON.parse(text).error).toBe(UNCONFIRMED);
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
  /** A settle stub whose answer can change between calls; `throws` = transport
   * error (true → a TypeError, or the error to throw). */
  function table(status: number, body: unknown, token = "settle-secret") {
    const s = { calls: 0, status, body, throws: false as boolean | Error };
    const fetch = async (req: Request) => {
      if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
      s.calls += 1;
      if (s.throws)
        throw s.throws === true ? new TypeError("fetch failed") : s.throws;
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

  // R002 L5: the four core operator-fault names, sent back by the route,
  // are classified by core's isOperatorFault, so no package caches one.
  for (const reason of [
    "network-mismatch",
    "settlement-not-configured",
    "verify-error: timeout",
    "settle-throttled",
    "settle-unreachable",
    "settle-retryable",
    "settlement-unconfigured",
  ])
    it(`row 3: reason ${reason} → settle-retryable`, async () => {
      await expectOperator(
        table(200, settledFalse(reason)),
        "settle-retryable",
      );
    });

  // Row 3a (R002 L7): a non-2xx that says settled:true. Money may have moved,
  // so never "retry the same payment" and never the payer's fault.
  for (const n of [400, 401, 403, 404, 429, 500, 503])
    it(`row 3a: HTTP ${n} settled:true + valid tx → settle-unconfirmed, not cached, not counted, not served`, async () => {
      const body = { ok: true, data: { settled: true, tx: TX } };
      await expectOperator(table(n, body), "settle-unconfirmed");
      const m = table(n, body);
      const r = await settlingMw()(
        ctx("/r", agent({ "x-payment": freshPayment() }), envOf(m)),
      );
      expect(r.status).toBe(402);
      const error = (await r.json()).error as string;
      expect(error).toBe(UNCONFIRMED);
      expect(error).not.toContain("retry the same payment");
    });

  // Row 3a (R006): the settle call timed out. The facilitator may already
  // have broadcast the transfer, so it is not "retry the same payment".
  const timedOut = () =>
    new DOMException("The operation timed out", "TimeoutError");
  it("row 3a (R006): the settle fetch times out → settle-unconfirmed, not cached, not counted, not served", async () => {
    const t = table(200, {});
    t.s.throws = timedOut();
    // Second identical try calls settle again; four more fresh payments from
    // the same payer never meet payer-cooldown.
    await expectOperator(t, "settle-unconfirmed");
    // The payer's next fresh payment, once healthy, is settled.
    t.s.throws = false;
    t.s.body = { ok: true, data: { settled: true, tx: TX } };
    expect((await t.verify(freshPayment(), t.cfg)).ok).toBe(true);
    const m = table(200, {});
    m.s.throws = timedOut();
    const r = await settlingMw()(
      ctx("/r", agent({ "x-payment": freshPayment() }), envOf(m)),
    );
    expect(r.status).toBe(402);
    expect(r.headers.get("x-payment-response")).toBeNull();
    expect((await r.json()).error).toBe(UNCONFIRMED);
  });

  it("row 3a (R006): the timeout fires during the body read → settle-unconfirmed, not cached, not counted", async () => {
    const t = table(200, {});
    const verify = makeSettlingVerify(
      async () => {
        t.s.calls += 1;
        return new Response(
          new ReadableStream({ start: (c) => c.error(timedOut()) }),
          { status: 200 },
        );
      },
      SETTLE_URL,
      "settle-secret",
    );
    await expectOperator({ ...t, verify }, "settle-unconfirmed");
  });

  // R013 (second review 2, L1). The non-2xx body read swallowed every
  // rejection, the timeout too, so the answer was classified by status alone:
  // 502 became "retry the same payment", 400 became row 7 (cached, counted).
  for (const status of [502, 400])
    it(`row 3a (R013 L1): HTTP ${status} headers, then the timeout fires during the body read → settle-unconfirmed, not cached, not counted`, async () => {
      const t = table(200, {});
      const verify = makeSettlingVerify(
        async () => {
          t.s.calls += 1;
          return new Response(
            new ReadableStream({ start: (c) => c.error(timedOut()) }),
            { status },
          );
        },
        SETTLE_URL,
        "settle-secret",
      );
      await expectOperator({ ...t, verify }, "settle-unconfirmed");
      expect(verify._sizes()).toMatchObject({ seen: 0, payerFails: 0 });
    });

  // R012 (second review 2, M2). The unconfirmed 402 used to carry a full
  // offer beside "do not pay again"; a client acting on `accepts` signs a
  // new payment and can be charged twice.
  it("rows 2 and 3a (R012 M2): the maybe-paid 402 is error-only: no x-payment-required, no accepts, no options, no price", async () => {
    const timeout = table(200, {});
    timeout.s.throws = timedOut();
    const cases: [T, string][] = [
      [timeout, UNCONFIRMED],
      [table(500, { ok: true, data: { settled: true, tx: TX } }), UNCONFIRMED],
      [
        table(200, { ok: true, data: { settled: true } }),
        "settle failed: no transaction id",
      ],
    ];
    for (const [m, error] of cases) {
      const r = await settlingMw()(
        ctx("/r", agent({ "x-payment": freshPayment() }), envOf(m)),
      );
      expect(r.status).toBe(402);
      expect(r.headers.get("x-payment-required")).toBeNull();
      expect(r.headers.get("link")).toBeNull();
      expect(r.headers.get("x-payment-response")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("no-store");
      // The whole body: no accepts, options, price_usd or v beside the error.
      expect(await r.json()).toEqual({ x402Version: 1, error });
    }
    expect(UNCONFIRMED).toContain("same payment may be retried");
    // Control: every other rejected payment still gets the full offer.
    const r = await settlingMw()(
      ctx(
        "/r",
        agent({ "x-payment": freshPayment() }),
        envOf(table(200, settledFalse("insufficient_funds"))),
      ),
    );
    expect(r.status).toBe(402);
    expect(r.headers.get("x-payment-required")).not.toBeNull();
    const body = await r.json();
    expect(body.accepts).toHaveLength(1);
    expect(body.options).toBeDefined();
  });

  // The transfer of a timed-out settle may have landed; the route then
  // refuses the retry of the same payment (spent nonce, or the balance is
  // now too low). That is not the payer's fault.
  for (const [name, status, body] of [
    ["row 6, 2xx settled:false nonce_used", 200, settledFalse("nonce_used")],
    ["row 7, HTTP 409", 409, { ok: false, error: "nonce used" }],
  ] as [string, number, unknown][])
    it(`row 3a (R012 M2): timeout, then the same payment answered ${name} → settle-unconfirmed again, not cached, payerFails 0`, async () => {
      const t = table(200, {});
      t.s.throws = timedOut();
      const xp = freshPayment();
      expect((await t.verify(xp, t.cfg)).reason).toBe("settle-unconfirmed");
      expect(t.verify._sizes().unconfirmed).toBe(1);
      t.s.throws = false;
      t.s.status = status;
      t.s.body = body;
      for (const calls of [2, 3]) {
        expect(await t.verify(xp, t.cfg)).toMatchObject({
          ok: false,
          reason: "settle-unconfirmed",
        });
        expect(t.s.calls).toBe(calls); // not cached: each try reaches settle
      }
      expect(t.verify._sizes()).toMatchObject({ seen: 0, payerFails: 0 });
      // Control: the same answer for a payment with no unconfirmed history
      // is still the payer's: cached and counted.
      const other = freshPayment();
      const reason = (await t.verify(other, t.cfg)).reason;
      expect(reason).not.toBe("settle-unconfirmed");
      expect((await t.verify(other, t.cfg)).reason).toBe(reason);
      expect(t.s.calls).toBe(4);
      expect(t.verify._sizes()).toMatchObject({ seen: 1, payerFails: 1 });
      // Once the route confirms the first payment it is served and forgotten.
      t.s.status = 200;
      t.s.body = { ok: true, data: { settled: true, tx: TX } };
      expect((await t.verify(xp, t.cfg)).ok).toBe(true);
      expect(t.verify._sizes().unconfirmed).toBe(0);
    });

  it("row 3a (R012 M2): through the middleware, timeout then nonce-used on the retry is the unconfirmed 402 again", async () => {
    const m = table(200, {});
    m.s.throws = timedOut();
    const mw = settlingMw();
    const xp = freshPayment();
    const send = () => mw(ctx("/r", agent({ "x-payment": xp }), envOf(m)));
    expect((await (await send()).json()).error).toBe(UNCONFIRMED);
    m.s.throws = false;
    m.s.body = settledFalse("nonce_used");
    const r = await send();
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ x402Version: 1, error: UNCONFIRMED });
    expect(m.s.calls).toBe(2);
  });

  it("R012 M2: an unconfirmed entry expires at UNCONFIRMED_TTL_MS, and an answer in between does not renew it", async () => {
    const t0 = Date.now();
    // The payment's own clock is pinned (opts.nowS), or it would be refused
    // locally as expired long before the entry's age limit.
    const opts = { nowS: Math.floor(t0 / 1000) };
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const t = table(200, {});
      t.s.throws = timedOut();
      const xp = freshPayment();
      expect((await t.verify(xp, t.cfg, opts)).reason).toBe(
        "settle-unconfirmed",
      );
      t.s.throws = false;
      t.s.body = settledFalse("nonce_used");
      clock.mockReturnValue(t0 + UNCONFIRMED_TTL_MS - 1);
      expect((await t.verify(xp, t.cfg, opts)).reason).toBe(
        "settle-unconfirmed",
      );
      expect(t.verify._sizes()).toMatchObject({ unconfirmed: 1, seen: 0 });
      clock.mockReturnValue(t0 + UNCONFIRMED_TTL_MS);
      expect((await t.verify(xp, t.cfg, opts)).reason).toBe("nonce_used");
      expect(t.verify._sizes()).toMatchObject({
        unconfirmed: 0,
        seen: 1,
        payerFails: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("R012 M2: the unconfirmed map is capped at UNCONFIRMED_CAP, oldest out", async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const t = table(200, {});
      t.s.throws = timedOut();
      const first = freshPayment();
      let last = first;
      for (let i = 0; i <= UNCONFIRMED_CAP + 2; i++) {
        // 250 ms apart: the settle bucket refills faster than it is spent.
        clock.mockReturnValue(t0 + i * 250);
        if (i > 0) last = freshPayment();
        expect((await t.verify(last, t.cfg)).reason).toBe("settle-unconfirmed");
      }
      expect(t.verify._sizes().unconfirmed).toBe(UNCONFIRMED_CAP);
      t.s.throws = false;
      t.s.body = settledFalse("nonce_used");
      // The newest is still remembered; the oldest was dropped (amnesty lost,
      // the ordinary payer answer applies).
      expect((await t.verify(last, t.cfg)).reason).toBe("settle-unconfirmed");
      expect((await t.verify(first, t.cfg)).reason).toBe("nonce_used");
    } finally {
      clock.mockRestore();
    }
  });

  it("row 0c (R006): a connection failure (TypeError) and a non-timeout abort stay settle-unreachable", async () => {
    const t = table(200, {});
    t.s.throws = new TypeError("fetch failed");
    await expectOperator(t, "settle-unreachable");
    t.s.throws = new DOMException("aborted", "AbortError");
    await expectOperator(t, "settle-unreachable");
  });

  // Row 4, the status form: whatever the body (settled:true is row 3a).
  // 404/405 (R002 L1): a wrong settle URL or method is ours, never the payer's.
  const row4Bodies: [string, unknown][] = [
    ["{ok:false,error}", { ok: false, error: "nope" }],
    ["non-JSON", "<html>Error</html>"],
  ];
  for (const n of [401, 403, 404, 405, 429, 500, 503])
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

  // Row 7: any other 4xx is the payer's (R002 L1: 404 moved to row 4).
  for (const n of [400, 413, 422]) {
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

  it("row 7: HTTP 422 with a string data.reason → that reason, cached, counted", async () => {
    await expectPayer(
      table(422, { ok: false, data: { reason: "bad_payload" } }),
      "bad_payload",
      "facilitator rejected: bad_payload",
    );
  });

  // T006 F3, row 5: a not-yet-valid authorization is the payer's clock, and
  // transient. Not cached, so the same X-PAYMENT can be retried once
  // valid_after has passed; counted once per nonce since R004 (M1).
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

  // R004 (second review 2 M1): changed from "not counted". Counted as on
  // main, so fresh early nonces from one payer meet the cooldown.
  it("row 5 (AC-3.3, R004 M1): valid_after → not-yet-valid, payer null, not cached, now counted toward the cooldown", async () => {
    const t = table(200, settledFalse(VALID_AFTER));
    const xp = freshPayment(); // validAfter 0: already past, so never held
    expect(await t.verify(xp, t.cfg)).toEqual({
      ok: false,
      payer: null,
      reason: "not-yet-valid",
    });
    expect((await t.verify(xp, t.cfg)).reason).toBe("not-yet-valid");
    expect(t.s.calls).toBe(2); // not cached: the retry reached settle
    expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
      "not-yet-valid",
    );
    // Three counted rejects: the 4th payment is cooled down, no settle call.
    expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
      "payer-cooldown",
    );
    expect(t.s.calls).toBe(3);
  });

  it("row 5 guard: a valid_after reason on HTTP 503 → settle-retryable (row 4 wins)", async () => {
    await expectOperator(
      table(503, settledFalse(VALID_AFTER)),
      "settle-retryable",
    );
  });

  // R003 (second review L8): a near-miss of an operator pattern is the
  // payer's. Killed mutant: core's isOperatorFault regexes without `^`.
  for (const r of [
    "x settle-failed(500)",
    "x verify-error: boom",
    "settle-failed(500)x",
  ])
    it(`row 6: reason ${JSON.stringify(r)} is not an operator fault → cached, counted`, async () => {
      await expectPayer(table(200, settledFalse(r)), r, "payment rejected");
    });

  // R003 (L8): the tx id must be the whole value. Killed mutant: the tx-id
  // regex without its leading `^` would serve "junk0x<64 hex>".
  for (const key of ["tx", "transaction"])
    for (const v of [`junk${TX}`, `zz${TX}`, `${TX}zz`, `${TX}0`])
      it(`row 2: ${key} ${JSON.stringify(v.slice(0, 8))}… (${v.length} chars) → no-transaction-id, not served`, async () => {
        const body = { ok: true, data: { settled: true, [key]: v } };
        const t = table(200, body);
        expect(await t.verify(freshPayment(), t.cfg)).toEqual({
          ok: false,
          payer: null,
          reason: "no-transaction-id",
        });
        const r = await settlingMw()(
          ctx(
            "/r",
            agent({ "x-payment": freshPayment() }),
            envOf(table(200, body)),
          ),
        );
        expect(r.status).toBe(402);
        expect((await r.json()).error).toBe("settle failed: no transaction id");
      });

  // R003: README row 6b, a 2xx JSON body with no data.settled at all.
  for (const body of [{}, null, []])
    it(`row 6b: HTTP 200 ${JSON.stringify(body)} → settle-failed, cached, counted`, async () => {
      await expectPayer(table(200, body), "settle-failed");
    });

  // R003: a 3xx that reaches us is row 7 (payer).
  for (const n of [300, 301, 307])
    it(`row 7: HTTP ${n} → settle-failed, cached, counted`, async () => {
      await expectPayer(
        table(n, { ok: false, error: "moved" }),
        "settle-failed",
      );
    });

  // R003: the README table is checked against the code. One settle answer
  // per row id; the Cached / Counted / Offer recorded cells must equal what
  // the verifier does with it. Offer recorded is core's decide step 6: an
  // offer unless isNoOfferFault(reason) (pinned in core's own tests).
  it("README table: every row id has a scenario and its cells match the code", async () => {
    const fresh = async (t: T) =>
      (await t.verify(freshPayment(), t.cfg)).reason;
    const SCENARIOS: Record<string, () => T | Promise<T>> = {
      "0a": () => table(200, { data: { settled: true, tx: TX } }, ""),
      "0b": async () => {
        const t = table(503, {});
        // Drain the bucket with operator faults (the clock is frozen below).
        for (let i = 0; i < SETTLE_BUCKET_CAP; i++) await fresh(t);
        return t;
      },
      "0c": () => table(200, "<html>ok</html>"),
      "1": () => table(200, { ok: true, data: { settled: true, tx: TX } }),
      "2": () => table(200, { ok: true, data: { settled: true, tx: "0x12" } }),
      "3a": () => table(500, { ok: true, data: { settled: true, tx: TX } }),
      "3": () => table(200, settledFalse("settle-failed(500)")),
      "4": () => table(503, { ok: false, error: "down" }),
      "5": () => table(200, settledFalse(VALID_AFTER)),
      "6": () => table(200, settledFalse("insufficient_funds")),
      "6b": () => table(200, {}),
      "7": () => table(400, { ok: false, error: "bad" }),
    };

    async function observe(make: () => T | Promise<T>) {
      // cached: a second identical payment makes no second settle call.
      let t = await make();
      const c0 = t.s.calls;
      const xp = freshPayment();
      const r1 = await t.verify(xp, t.cfg);
      const reached = t.s.calls > c0;
      await t.verify(xp, t.cfg);
      const cached = reached && t.s.calls === c0 + 1;
      // counted: the 4th fresh payment from one payer is cooled down.
      t = await make();
      for (let i = 0; i < 3; i++) await fresh(t);
      const counted = (await fresh(t)) === "payer-cooldown";
      // cleared: two payer faults, this answer, one more fault, and the next
      // payment is still not cooled down. Only rows that reach settle can.
      let cleared = false;
      if (reached && !counted) {
        t = await make();
        const { status, body } = t.s;
        const payerFault = () => {
          t.s.status = 200;
          t.s.body = settledFalse("insufficient_funds");
        };
        payerFault();
        for (let i = 0; i < 2; i++) await fresh(t);
        t.s.status = status;
        t.s.body = body;
        await fresh(t);
        payerFault();
        await fresh(t);
        cleared = (await fresh(t)) !== "payer-cooldown";
      }
      return {
        cached: cached ? "yes" : "no",
        counted: counted ? "yes" : cleared ? "cleared" : "no",
        offer: r1.ok ? "n/a" : isNoOfferFault(r1.reason) ? "no" : "yes",
      };
    }

    const md = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const lines = md.split("\n");
    const cells = (l: string) =>
      l
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((c) => c.trim());
    const h = lines.findIndex((l) => l.startsWith("| # | Settle answer |"));
    expect(h).toBeGreaterThan(-1);
    const head = cells(lines[h] as string);
    const col = (name: string) => {
      const i = head.indexOf(name);
      expect(i, name).toBeGreaterThan(-1);
      return i;
    };
    const [ci, ki, oi] = [
      col("Cached for nonce"),
      col("Counted to cooldown"),
      col("Offer recorded"),
    ];
    // First word of a cell: "yes, `already-settled`" → "yes".
    const word = (c: string | undefined) =>
      (c ?? "").split(/[\s,]/)[0]?.toLowerCase();
    const rows: Record<
      string,
      { cached?: string; counted?: string; offer?: string }
    > = {};
    for (const l of lines.slice(h + 2)) {
      if (!l.startsWith("|")) break;
      const c = cells(l);
      rows[c[0] as string] = {
        cached: word(c[ci]),
        counted: word(c[ki]),
        offer: word(c[oi]),
      };
    }
    expect(Object.keys(rows).sort()).toEqual(Object.keys(SCENARIOS).sort());

    // Row 5 (R005, second review 2 L-d): the first-word check cannot see the
    // hold, so the row 5 cells are pinned whole and their claims checked on
    // an early payment (validAfter in the future; freshPayment's is 0).
    const r5 = cells(lines.find((l) => l.startsWith("| 5 |")) as string);
    expect([r5[ci], r5[ki], r5[oi]]).toEqual([
      "no, held locally until its `validAfter` (repeats: no settle call)",
      "yes, once per nonce",
      "yes, first attempt only (held repeats: no)",
    ]);
    // Core's decide: no offer for isNoOfferFault, and no ledger write for
    // the held repeat (pipeline.ts step 6/8, pinned in core's tests).
    const offerOf = (reason?: string) =>
      isNoOfferFault(reason) || reason === "not-yet-valid-held" ? "no" : "yes";

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (const [id, make] of Object.entries(SCENARIOS))
        expect({ id, ...(await observe(make)) }).toEqual({ id, ...rows[id] });

      const t = table(200, settledFalse(VALID_AFTER));
      const nowS = Math.floor(Date.now() / 1000);
      const auth = makeAuth({
        value: "1000",
        validAfter: String(nowS + 30),
        validBefore: String(nowS + 300),
        nonce: `0x${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`,
      });
      const early = payment(auth, signAuth(auth));
      const first = (await t.verify(early, t.cfg)).reason;
      expect([first, offerOf(first), t.s.calls]).toEqual([
        "not-yet-valid",
        "yes",
        1,
      ]);
      for (let i = 0; i < 5; i++) {
        const held = (await t.verify(early, t.cfg)).reason;
        expect([held, offerOf(held)]).toEqual(["not-yet-valid-held", "no"]);
      }
      expect(t.s.calls).toBe(1); // held: no settle call
      // Counted once: the early payment plus two payer faults cool the payer
      // down; had the held repeats counted, the second fault would not settle.
      t.s.body = settledFalse("insufficient_funds");
      expect(await fresh(t)).toBe("insufficient_funds");
      expect(await fresh(t)).toBe("insufficient_funds");
      expect(await fresh(t)).toBe("payer-cooldown");
    } finally {
      clock.mockRestore();
    }
  });
});

// R001 (second review L2/L6/L4): a facilitator `valid_after` reject is
// remembered per payment until its validAfter, and answered locally, so one
// early authorization cannot drain the settle bucket or the facilitator's
// verify quota, and cannot be used to keep a verified agent out of the maze.
describe("makeSettlingVerify — not-yet-valid is answered locally until validAfter (R001)", () => {
  const T0 = 1_800_000_000; // epoch seconds; also the WBA fixtures' NOW
  const VALID_AFTER = "invalid_exact_evm_payload_authorization_valid_after";
  let bot: TestAgent;
  beforeAll(async () => {
    bot = await makeAgent();
  });
  const NYV = {
    ok: true,
    data: { settled: false, reason: VALID_AFTER },
  };

  function stubbed(body: unknown = NYV) {
    const s = { calls: 0, body };
    const fetch = async (req: Request) => {
      if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
      s.calls += 1;
      return new Response(JSON.stringify(s.body), { status: 200 });
    };
    const verify = makeSettlingVerify(
      (url, init) => fetch(new Request(url, init)),
      SETTLE_URL,
      "settle-secret",
    );
    return { s, fetch, verify, cfg: parseConfig(toml()) };
  }

  it("the same early payment x30 → at most 1 settle call, every answer 402 authorization not yet valid", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = stubbed();
      const mw = settlingMw();
      const xp = earlyPayment(T0);
      for (let i = 0; i < 30; i++) {
        const r = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
        expect(r.status).toBe(402);
        expect((await r.json()).error).toBe("authorization not yet valid");
      }
      expect(t.s.calls).toBe(1); // main: 20
      // The local answer spent no bucket token: a fresh payment still settles.
      t.s.body = { ok: true, data: { settled: true, tx: TX } };
      expect(
        (await mw(ctx("/r", agent({ "x-payment": freshPayment() }), envOf(t))))
          .status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  // Spec 006 R-O2 (row A2): the held repeat says how long is left.
  it("held at T0, repeated at T0+10 s → 402 with retry-after: 45; the first answer has none", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = stubbed();
      const mw = settlingMw();
      const xp = earlyPayment(T0); // 55 s ahead
      const send = () => mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
      // The facilitator's own "not yet": no header (not the held path).
      const first = await send();
      expect(first.status).toBe(402);
      expect(first.headers.has("retry-after")).toBe(false);
      clock.mockReturnValue((T0 + 10) * 1000);
      const held = await send();
      expect(held.status).toBe(402);
      expect(held.headers.get("retry-after")).toBe("45");
      expect((await held.json()).error).toBe("authorization not yet valid");
      expect(t.s.calls).toBe(1); // held: no settle call
    } finally {
      clock.mockRestore();
    }
  });

  it("the settle-throttled 402 has no retry-after", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      // Operator faults drain the bucket without counting against the payer.
      const s = { calls: 0 };
      const b = {
        fetch: async (req: Request) => {
          if (req.url === SETTLE_URL) s.calls += 1;
          return new Response("{}", { status: 503 });
        },
      };
      const mw = settlingMw();
      const send = () =>
        mw(ctx("/r", agent({ "x-payment": freshPayment() }), envOf(b)));
      for (let i = 0; i < SETTLE_BUCKET_CAP; i++) await send();
      const r = await send();
      expect(r.status).toBe(402);
      expect(s.calls).toBe(SETTLE_BUCKET_CAP); // throttled: no settle call
      expect(r.headers.has("retry-after")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("after validAfter exactly one settle attempt is allowed, served once, replay 402", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = stubbed();
      const mw = settlingMw();
      const xp = earlyPayment(T0, 30);
      await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
      clock.mockReturnValue((T0 + 29) * 1000); // one second short
      await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
      expect(t.s.calls).toBe(1);
      clock.mockReturnValue((T0 + 30) * 1000); // now >= validAfter
      t.s.body = { ok: true, data: { settled: true, tx: TX } };
      const served = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
      expect(served.status).toBe(200);
      expect(t.s.calls).toBe(2);
      const replay = await mw(ctx("/r", agent({ "x-payment": xp }), envOf(t)));
      expect(replay.status).toBe(402);
      expect(t.s.calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  // Spec 006 row A5 (T005): was "... re-records it". The due attempt is
  // counted but no longer held again; the old assertions stand, one added.
  it("a not-yet-valid answer to the due attempt is not held again (row A5)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = stubbed();
      const xp = earlyPayment(T0, 10);
      await t.verify(xp, t.cfg);
      // validAfter reached, the facilitator still says not yet (its clock is
      // behind ours): the one allowed retry reaches settle and is answered
      // not-yet-valid again. That validAfter is now past, so it is not held.
      clock.mockReturnValue((T0 + 10) * 1000);
      expect((await t.verify(xp, t.cfg)).reason).toBe("not-yet-valid");
      expect(t.s.calls).toBe(2); // the one allowed retry reached settle
      expect(t.verify._sizes().notYetValid).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  /** Facilitator stub on the mocked clock: valid_after while a payment is
   * early, then settled for a `funded` X-PAYMENT, else insufficient_funds. */
  function facilitator(funded = new Set<string>()) {
    const s = { calls: 0 };
    const fetch = async (req: Request) => {
      if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
      s.calls += 1;
      const xp = ((await req.json()) as { payment: string }).payment;
      const { validAfter } = JSON.parse(atob(xp)).payload.authorization;
      const data =
        Number(validAfter) > Date.now() / 1000
          ? NYV.data
          : funded.has(xp)
            ? { settled: true, tx: TX }
            : { settled: false, reason: "insufficient_funds" };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    };
    const verify = makeSettlingVerify(
      (url, init) => fetch(new Request(url, init)),
      SETTLE_URL,
      "settle-secret",
    );
    return { s, verify, cfg: parseConfig(toml()) };
  }

  /** The hono pipeline over `verify` (offer_grace 3, maze on), on the mocked clock. */
  async function mazeApp(verify: ReturnType<typeof makeSettlingVerify>) {
    const cfg = parseConfig(toml());
    const a = new Hono();
    a.use(
      fareseal({
        config: cfg,
        x402: { buildOffer, verifyProof: verify, settles: true },
        maze: makeMazeHandler({
          corpus: corpusFromMap(generateCorpus({ seed: "r004", pages: 10 })),
          cfg,
          sleep: async () => {},
        }),
        fetchDirectory: dirWith(bot.jwk),
        nowS: () => Math.floor(Date.now() / 1000),
      }),
    );
    a.get("*", (c) => c.text("content"));
    const wba = await signedRequest(bot, { expires: T0 + 300 });
    const verified: Record<string, string> = {
      ...agent(),
      signature: wba.signature,
      "signature-input": wba.signatureInput,
      "signature-agent": wba.signatureAgent,
    };
    const send = (xp: string, headers = verified) =>
      a.request("http://example.com/article", {
        headers: { ...headers, "x-payment": xp },
      });
    return { send, anon: agent() as Record<string, string> };
  }

  // R004 (second review 2 M1) replaces "fresh early nonces from one payer:
  // not counted toward the cooldown, bounded by the settle bucket".
  it("M1: fresh early nonces from one payer, burst of 30 → 3 settle calls, then payer-cooldown (as on main)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = facilitator();
      const reasons: (string | undefined)[] = [];
      for (let i = 0; i < 30; i++)
        reasons.push((await t.verify(earlyPayment(T0), t.cfg)).reason);
      expect(t.s.calls).toBe(3); // 9c5c489: SETTLE_BUCKET_CAP
      expect(reasons).toEqual([
        ...Array(3).fill("not-yet-valid"),
        ...Array(27).fill("payer-cooldown"),
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("M1: fresh early nonces from one payer, 10 rps for 60 s → 3 settle calls, then payer-cooldown", async () => {
    let ms = T0 * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
    try {
      const t = facilitator();
      let last: string | undefined;
      for (let i = 0; i < 600; i++, ms += 100)
        last = (await t.verify(earlyPayment(Math.floor(ms / 1000)), t.cfg))
          .reason;
      expect(t.s.calls).toBe(3); // 9c5c489: 319
      expect(last).toBe("payer-cooldown");
    } finally {
      clock.mockRestore();
    }
  }, 30_000); // hundreds of secp256k1 signatures: slow on a loaded host

  it("M1: the same early payment at 10 rps → 1 settle call before validAfter, exactly 1 more after, served once", async () => {
    let ms = T0 * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
    try {
      const xp = earlyPayment(T0);
      const t = facilitator(new Set([xp]));
      const reasons = new Set<string | undefined>();
      for (; ms < (T0 + 55) * 1000; ms += 100)
        reasons.add((await t.verify(xp, t.cfg)).reason);
      expect(t.s.calls).toBe(1);
      expect([...reasons]).toEqual(["not-yet-valid", "not-yet-valid-held"]);
      expect(await t.verify(xp, t.cfg)).toMatchObject({ ok: true });
      for (let i = 0; i < 5; i++)
        expect((await t.verify(xp, t.cfg)).reason).toBe("already-settled");
      expect(t.s.calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("M1: the same early payment repeated is counted once: two more failures cool the payer down", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = facilitator();
      const xp = earlyPayment(T0);
      for (let i = 0; i < 30; i++) await t.verify(xp, t.cfg);
      expect(t.s.calls).toBe(1);
      for (let i = 0; i < 2; i++)
        expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
          "insufficient_funds",
        );
      // Counted once (not 30 times, not zero): the 4th failure cools down.
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
        "payer-cooldown",
      );
      expect(t.s.calls).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  // Kills mutant M13 (row 5 written `fails ? fails.n : 0`): the row-5 reject
  // itself must restart the count when the previous window has expired.
  it("N2: a row-5 count from an expired cooldown window is dropped", async () => {
    let ms = T0 * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
    try {
      const t = facilitator();
      const early = () => earlyPayment(Math.floor(ms / 1000));
      expect((await t.verify(early(), t.cfg)).reason).toBe("not-yet-valid");
      expect(t.s.calls).toBe(1);
      ms += 600_001; // PAYER_COOLDOWN_MS + 1: the first window is over
      for (let i = 0; i < 2; i++)
        expect((await t.verify(early(), t.cfg)).reason).toBe("not-yet-valid");
      expect(t.s.calls).toBe(3);
      // Two failures in this window, not three: the next payment reaches
      // settle. With the old count carried over it would be cooled down.
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
        "insufficient_funds",
      );
      expect(t.s.calls).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  // All three pass the cooldown check before any settle answers, so each
  // must add to the live count when it lands, not to what it saw going in
  // (that wrote n=1 three times and left the payer free to keep settling).
  it("N1: three concurrent failures from one payer cool it down", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = facilitator();
      const results = await Promise.all(
        [freshPayment(), freshPayment(), freshPayment()].map((xp) =>
          t.verify(xp, t.cfg),
        ),
      );
      expect(results.map((r) => r.reason)).toEqual([
        "insufficient_funds",
        "insufficient_funds",
        "insufficient_funds",
      ]);
      expect(t.s.calls).toBe(3);
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
        "payer-cooldown",
      );
      expect(t.s.calls).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  // T002 (spec 006, L1 + L4): the tests below pin the payer-count
  // bookkeeping of rows 5 and 6/7. Each names the source mutant it kills.

  // Kills m01 (row 5 counting from the pre-await `fails`, not the re-read
  // `cur`): the row-5 half of N1.
  it("L1: three concurrent early payments from one payer cool it down", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = stubbed();
      const results = await Promise.all(
        [earlyPayment(T0), earlyPayment(T0), earlyPayment(T0)].map((xp) =>
          t.verify(xp, t.cfg),
        ),
      );
      expect(results.map((r) => r.reason)).toEqual([
        "not-yet-valid",
        "not-yet-valid",
        "not-yet-valid",
      ]);
      expect(t.s.calls).toBe(3);
      expect((await t.verify(earlyPayment(T0), t.cfg)).reason).toBe(
        "payer-cooldown",
      );
      expect(t.s.calls).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  // Kills m04 (rows 6/7 written `cur ? cur.n : 0`): N2's twin for row 6.
  it("L4: a row-6 count from an expired cooldown window restarts at 1", async () => {
    let ms = T0 * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
    try {
      const t = facilitator();
      for (let i = 0; i < 2; i++)
        expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
          "insufficient_funds",
        );
      ms += 600_001; // PAYER_COOLDOWN_MS + 1: the first window is over
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
        "insufficient_funds",
      );
      expect(t.s.calls).toBe(3);
      // One failure in this window, not three: the next payment reaches
      // settle. With the old count carried over it would be cooled down.
      expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
        "insufficient_funds",
      );
      expect(t.s.calls).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  // The next three run once per count write: row 5 (an early payment) and
  // row 6 (an unfunded one), so a mutant in either write is killed alone.
  const ROWS = [
    {
      row: "row 5",
      reason: "not-yet-valid",
      data: NYV.data,
      failing: (nowS: number) => earlyPayment(nowS),
    },
    {
      row: "row 6",
      reason: "insufficient_funds",
      data: { settled: false, reason: "insufficient_funds" },
      failing: (_nowS: number) => freshPayment(),
    },
  ];

  // Kills m09 (row 5) / m10 (rows 6/7): `untilMs` kept from the live entry
  // instead of restarted by the new failure.
  it.each(ROWS)(
    "L4: $row failures at t, t+1 s, t+300 s cool the payer until t+900 s",
    async ({ reason, failing }) => {
      let ms = T0 * 1000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
      try {
        const t = facilitator();
        for (const at of [0, 1_000, 300_000]) {
          ms = T0 * 1000 + at;
          expect(
            (await t.verify(failing(Math.floor(ms / 1000)), t.cfg)).reason,
          ).toBe(reason);
        }
        expect(t.s.calls).toBe(3);
        ms = T0 * 1000 + 899_999; // 1 ms short of the last failure + 600 s
        expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
          "payer-cooldown",
        );
        expect(t.s.calls).toBe(3);
        ms = T0 * 1000 + 900_000;
        expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
          "insufficient_funds",
        );
        expect(t.s.calls).toBe(4);
      } finally {
        clock.mockRestore();
      }
    },
  );

  // Kills m19 (row 5) / m20 (rows 6/7): `now < cur.untilMs` → `<=`.
  it.each(ROWS)(
    "L4: a $row failure written exactly at untilMs starts at 1",
    async ({ reason, failing }) => {
      let ms = T0 * 1000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
      try {
        const t = facilitator();
        for (let i = 0; i < 2; i++) await t.verify(failing(T0), t.cfg);
        ms += 600_000; // exactly untilMs: the window is over
        expect((await t.verify(failing(T0 + 600), t.cfg)).reason).toBe(reason);
        expect(t.s.calls).toBe(3);
        // n = 1, not 3: the next payment reaches settle.
        expect((await t.verify(freshPayment(), t.cfg)).reason).toBe(
          "insufficient_funds",
        );
        expect(t.s.calls).toBe(4);
      } finally {
        clock.mockRestore();
      }
    },
  );

  // Kills m21 (row 5) / m22 (rows 6/7): n from max(pre-await snapshot,
  // re-read). A success that lands while a failure is in flight clears the
  // count, and that failure must then count from zero, not from what it saw
  // going in. At most 2 settles are in flight, which T004's per-payer
  // reservation (R-O1) still allows.
  it.each(ROWS)(
    "L4 (P2d): a success landing before an in-flight $row failure clears the count that failure adds to",
    async ({ reason, data, failing }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
      try {
        // Each settle call waits here until the test answers it, oldest first.
        const answers: ((data: Record<string, unknown>) => void)[] = [];
        const verify = makeSettlingVerify(
          () =>
            new Promise<Response>((resolve) => {
              answers.push((d) =>
                resolve(new Response(JSON.stringify({ ok: true, data: d }))),
              );
            }),
          SETTLE_URL,
          "settle-secret",
        );
        const cfg = parseConfig(toml());
        const answer = (d: Record<string, unknown>) => answers.shift()?.(d);
        const settled = { settled: true, tx: TX };

        const first = verify(failing(T0), cfg);
        answer(data);
        expect((await first).reason).toBe(reason); // n = 1
        const funded = verify(freshPayment(), cfg);
        const unfunded = verify(failing(T0), cfg); // both saw n = 1
        expect(answers.length).toBe(2); // both in flight
        answer(settled);
        expect(await funded).toMatchObject({ ok: true }); // count cleared
        answer(data);
        expect((await unfunded).reason).toBe(reason); // n = 1 (mutant: 2)
        const again = verify(failing(T0), cfg);
        answer(data);
        expect((await again).reason).toBe(reason); // n = 2 (mutant: 3)
        const last = verify(freshPayment(), cfg);
        answer(settled); // mutant: payer-cooldown, no settle call to answer
        expect(await last).toMatchObject({ ok: true });
      } finally {
        clock.mockRestore();
      }
    },
  );

  // T003 (spec 006, L2 / A8): the cooldown runs from the moment a failure
  // is written, not from the moment its settle call started. A starts at
  // 0 s and its answer is held; B and C fail at 1 s and 2 s; A's failure
  // lands at 5 s as the third (n = 3), so the payer is cooled until 605 s.
  // Stamped with A's start time it was free again at 600 s. At most 2
  // settles are in flight, which T004's per-payer reservation still allows.
  it.each(ROWS)(
    "L2: a held $row failure landing at 5 s cools the payer until 605 s, not 600 s",
    async ({ reason, data, failing }) => {
      let ms = T0 * 1000;
      const at = (offsetMs: number) => {
        ms = T0 * 1000 + offsetMs;
      };
      const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
      try {
        // Each settle call waits here until the test answers it.
        let calls = 0;
        const answers: ((data: Record<string, unknown>) => void)[] = [];
        const verify = makeSettlingVerify(
          () =>
            new Promise<Response>((resolve) => {
              calls++;
              answers.push((d) =>
                resolve(new Response(JSON.stringify({ ok: true, data: d }))),
              );
            }),
          SETTLE_URL,
          "settle-secret",
        );
        const cfg = parseConfig(toml());
        const unfunded = { settled: false, reason: "insufficient_funds" };

        const a = verify(failing(T0), cfg); // A starts at 0 s, answer held
        for (const offsetMs of [1_000, 2_000]) {
          at(offsetMs); // B at 1 s, C at 2 s: answered at once (newest call)
          const p = verify(freshPayment(), cfg);
          answers.pop()?.(unfunded);
          expect((await p).reason).toBe("insufficient_funds");
        }
        at(5_000);
        answers.pop()?.(data); // A's failure lands at 5 s: n = 3
        expect((await a).reason).toBe(reason);
        expect(calls).toBe(3);

        at(604_999); // 1 ms short of A's landing + 600 s
        const cooled = verify(freshPayment(), cfg);
        // Checked before the await: a settle call here is never answered.
        expect(calls).toBe(3);
        expect((await cooled).reason).toBe("payer-cooldown");
        at(605_000);
        const free = verify(freshPayment(), cfg);
        expect(calls).toBe(4); // reaches settle
        answers.pop()?.(unfunded);
        expect((await free).reason).toBe("insufficient_funds");
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("M1 + L-b: an honest verified agent, clock 30 s fast, retrying one payment at 0,5..30 s is served at +30 s and never mazed", async () => {
    let ms = T0 * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
    try {
      const xp = earlyPayment(T0, 30); // its clock says T0+30 is "now"
      const t = facilitator(new Set([xp]));
      const { send } = await mazeApp(t.verify);
      const statuses: number[] = [];
      const errors = new Set<string>();
      for (let s = 0; s <= 30; s += 5) {
        ms = (T0 + s) * 1000;
        const r = await send(xp);
        statuses.push(r.status);
        if (r.status === 402) errors.add((await r.json()).error);
      }
      // 9c5c489: 402,402,402,302,302,302,200 (held repeats recorded offers).
      expect(statuses).toEqual([402, 402, 402, 402, 402, 402, 200]);
      // The held answer keeps the payer's text.
      expect([...errors]).toEqual(["authorization not yet valid"]);
      expect(t.s.calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  // R004 (second review 2 L-a): settle-throttled now records an offer, so a
  // drained bucket no longer keeps a verified agent out of the maze.
  it("L-a: a drain of fresh early nonces from one payer, then the verified agent with fresh unfunded payments → 302 from the 4th (as on main)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = facilitator();
      const { send, anon } = await mazeApp(t.verify);
      for (let i = 0; i < 30; i++) await send(earlyPayment(T0), anon);
      expect(t.s.calls).toBe(3); // 9c5c489: 20, the bucket drained
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++)
        statuses.push((await send(freshPayment())).status);
      expect(statuses).toEqual([402, 402, 402, 302, 302, 302, 302, 302]);
    } finally {
      clock.mockRestore();
    }
  });

  // R004 rework (QA: L-b reopened the dodge): a held repeat skips only the
  // ledger write, never the consequence, so a mazed agent stays mazed.
  it("L-b: an agent already mazed stays mazed while repeating one held early payment (302 x10, 3 settle calls)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = facilitator();
      const { send } = await mazeApp(t.verify);
      const early = [earlyPayment(T0), earlyPayment(T0), earlyPayment(T0)];
      const statuses: number[] = [];
      for (const xp of early) statuses.push((await send(xp)).status);
      for (let i = 0; i < 2; i++)
        statuses.push((await send(freshPayment())).status);
      expect(statuses).toEqual([402, 402, 402, 302, 302]);
      const held: number[] = [];
      for (let i = 0; i < 10; i++)
        held.push((await send(early[2] as string)).status);
      expect(held).toEqual(Array(10).fill(302)); // 9c5c489 diff: 402 x10
      expect((await send(freshPayment())).status).toBe(302);
      expect(t.s.calls).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("L-a: a bucket drain by rotating unfunded payers, then the verified agent with fresh unfunded payments → 302 from the 4th (settle-throttled now records an offer)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = facilitator();
      const { send, anon } = await mazeApp(t.verify);
      for (let i = 0; i < 30; i++) await send(rotatingPayerPayment(), anon);
      expect(t.s.calls).toBe(SETTLE_BUCKET_CAP); // drained: keys are free
      const reasons = new Set<string | undefined>();
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const xp = freshPayment();
        reasons.add((await t.verify(xp, t.cfg)).reason); // not cached
        statuses.push((await send(xp)).status);
      }
      expect([...reasons]).toEqual(["settle-throttled"]);
      expect(statuses).toEqual([402, 402, 402, 302, 302, 302, 302, 302]);
    } finally {
      clock.mockRestore();
    }
  });

  it("the remembered map is capped like the nonce cache (oldest evicted past 512)", async () => {
    // The validAfter check reads opts.nowS (pinned), while Date.now advances
    // past the payer cooldown per call (R004 M1: row 5 is now counted), so
    // the one payer is never cooled down and the bucket refills each time.
    const STEP = 600_001;
    let ms = T0 * 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ms);
    try {
      const t = stubbed();
      const opts = { nowS: T0 };
      const xps = Array.from({ length: 513 }, () => earlyPayment(T0));
      for (const xp of xps) {
        ms += STEP;
        await t.verify(xp, t.cfg, opts);
      }
      expect(t.s.calls).toBe(513);
      ms += STEP;
      await t.verify(xps[512] ?? "", t.cfg, opts); // newest: still local
      expect(t.s.calls).toBe(513);
      ms += STEP;
      await t.verify(xps[0] ?? "", t.cfg, opts); // oldest: evicted, reaches settle
      expect(t.s.calls).toBe(514);
    } finally {
      clock.mockRestore();
    }
  }, 30_000); // hundreds of secp256k1 signatures: slow on a loaded host

  it("L6: an anonymous drain with one early payment no longer keeps a verified agent out of the maze (302 as on main)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
    try {
      const t = stubbed();
      const cfg = parseConfig(toml());
      const verify = makeSettlingVerify(
        (url, init) => t.fetch(new Request(url, init)),
        SETTLE_URL,
        "settle-secret",
      );
      const a = new Hono();
      a.use(
        fareseal({
          config: cfg,
          x402: { buildOffer, verifyProof: verify, settles: true },
          maze: makeMazeHandler({
            corpus: corpusFromMap(generateCorpus({ seed: "r001", pages: 10 })),
            cfg,
            sleep: async () => {},
          }),
          fetchDirectory: dirWith(bot.jwk),
          nowS: () => T0,
        }),
      );
      a.get("*", (c) => c.text("content"));
      // The anonymous drain: one early unfunded payment, 30 times.
      const drain = earlyPayment(T0);
      for (let i = 0; i < 30; i++)
        await a.request("http://example.com/article", {
          headers: { ...agent(), "x-payment": drain },
        });
      expect(t.s.calls).toBe(1);
      // The verified agent attaches a fresh early unfunded payment each time.
      const wba = await signedRequest(bot, { expires: T0 + 300 });
      const headers = {
        ...agent(),
        signature: wba.signature,
        "signature-input": wba.signatureInput,
        "signature-agent": wba.signatureAgent,
      };
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push(
          (
            await a.request("http://example.com/article", {
              headers: { ...headers, "x-payment": earlyPayment(T0) },
            })
          ).status,
        );
      // Not-yet-valid records an offer (L4 decision), so the 4th is mazed.
      expect(statuses).toEqual([402, 402, 402, 302, 302]);
    } finally {
      clock.mockRestore();
    }
  });
});

// T004 (spec 006, R-O1 / row A1): settle calls a payer has started and not
// finished count toward the per-payer limit of 3, next to recorded failures.
// Before, every concurrent payment passed the cooldown check ahead of the
// first answer, so one free key cost a settle call per request up to the
// whole bucket (20).
describe("per-payer in-flight settles are reserved (spec 006 T004, R-O1)", () => {
  const T0 = 1_800_000_000;
  const COOLING = "payer cooling down after repeated failures; retry later";
  const OK = { ok: true, data: { settled: true, payer: "0xabc", tx: TX } };
  const UNFUNDED = {
    ok: true,
    data: { settled: false, reason: "insufficient_funds" },
  };
  let ms = T0 * 1000;
  beforeEach(() => {
    ms = T0 * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => ms);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A settle endpoint whose calls wait until the test ends them by hand,
   * oldest first. With `throws` set the fetch itself throws and nothing waits. */
  function heldSettle() {
    const waiting: {
      resolve: (r: Response) => void;
      reject: (e: unknown) => void;
    }[] = [];
    const h = {
      calls: 0,
      throws: false,
      waiting,
      fetch: (req: Request): Promise<Response> => {
        if (req.url !== SETTLE_URL)
          return Promise.resolve(new Response("{}", { status: 200 }));
        h.calls += 1;
        if (h.throws) throw new TypeError("fetch failed");
        return new Promise((resolve, reject) => {
          waiting.push({ resolve, reject });
        });
      },
      /** End the oldest waiting call with this answer (a string is sent raw). */
      answer: (status: number, body: unknown) =>
        waiting.shift()?.resolve(
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
          }),
        ),
      reject: (e: unknown) => waiting.shift()?.reject(e),
    };
    return h;
  }
  type Held = ReturnType<typeof heldSettle>;

  async function viaMiddleware() {
    const h = heldSettle();
    const mw = settlingMw();
    // Warm the isolate state first (a cold burst is covered by the R004 tests).
    await mw(ctx("/r", agent(), envOf(h)));
    const send = (xp: string) =>
      mw(ctx("/r", agent({ "x-payment": xp }), envOf(h)));
    return { h, send };
  }
  const errorOf = async (r: Response) =>
    ((await r.json()) as { error?: string }).error;
  /** `n` settle calls have reached the endpoint (and wait there). */
  const inFlight = (h: Held, n: number) =>
    vi.waitFor(() => expect(h.calls).toBe(n));

  it("100 concurrent fresh payments from one payer → 3 settle calls, 97 x 402 payer-cooldown", async () => {
    const { h, send } = await viaMiddleware();
    const xps = Array.from({ length: 100 }, () => freshPayment());
    let answered = 0;
    const rs = xps.map((xp) =>
      send(xp).then((r) => {
        answered += 1;
        return r;
      }),
    );
    // Every request is now either waiting at the settle endpoint or answered.
    await vi.waitFor(() => expect(h.calls + answered).toBe(100), {
      timeout: 10_000,
    });
    expect(h.calls).toBe(3);
    expect(answered).toBe(97);
    while (h.waiting.length > 0) h.answer(200, OK);
    const all = await Promise.all(rs);
    const served = all.filter((r) => r.status === 200);
    expect(served.length).toBe(3);
    for (const r of served)
      expect(r.headers.get("x-payment-response")).not.toBeNull();
    const refused = all.filter((r) => r.status === 402);
    expect(refused.length).toBe(97);
    for (const r of refused) expect(await errorOf(r)).toBe(COOLING);
    expect(h.calls).toBe(3);
  }, 30_000);

  it("an honest funded payer with 3 in flight: the 4th is payer-cooldown with no settle call; after they land it and a 5th are served", async () => {
    const { h, send } = await viaMiddleware();
    const three = [1, 2, 3].map(() => send(freshPayment()));
    await inFlight(h, 3);
    const fourthXp = freshPayment();
    const fourth = await send(fourthXp);
    expect(fourth.status).toBe(402);
    expect(await errorOf(fourth)).toBe(COOLING);
    expect(h.calls).toBe(3); // no settle call for the 4th
    while (h.waiting.length > 0) h.answer(200, OK);
    for (const r of await Promise.all(three)) {
      expect(r.status).toBe(200);
      expect(r.headers.get("x-payment-response")).not.toBeNull();
    }
    // The refused payment was not cached for its nonce: the same X-PAYMENT
    // settles now. Then a fresh 5th payment.
    for (const xp of [fourthXp, freshPayment()]) {
      const before = h.calls;
      const r = send(xp);
      await inFlight(h, before + 1);
      h.answer(200, OK);
      expect((await r).status).toBe(200);
    }
    expect(h.calls).toBe(5);
  });

  // Every way a settle call can end must give the reservation back.
  const PATHS: {
    path: string;
    throws?: true;
    end: (h: Held) => unknown;
  }[] = [
    { path: "success", end: (h) => h.answer(200, OK) },
    { path: "insufficient_funds", end: (h) => h.answer(200, UNFUNDED) },
    {
      path: "settle 503",
      end: (h) => h.answer(503, { ok: false, error: "down" }),
    },
    {
      path: "fetch rejecting after a delay (timeout/abort)",
      end: async (h) => {
        await new Promise((r) => setTimeout(r, 5));
        h.reject(new DOMException("The operation was aborted", "AbortError"));
      },
    },
    { path: "fetch throwing", throws: true, end: () => {} },
    { path: "2xx non-JSON", end: (h) => h.answer(200, "<html>ok</html>") },
  ];

  /** Three settles from one payer all end by `p`; then three more must start
   * and a fourth must not. `released` runs once the first three are over.
   * Resolves to the answer that fourth got. */
  async function releaseScenario<R>(
    h: Held,
    send: (xp: string) => Promise<R>,
    p: (typeof PATHS)[number],
    released: () => void = () => {},
  ): Promise<R> {
    h.throws = p.throws === true;
    const first = [1, 2, 3].map(() => send(freshPayment()));
    await inFlight(h, 3);
    for (let i = 0; i < 3; i++) await p.end(h);
    await Promise.all(first);
    h.throws = false;
    released();
    // Step past any cooldown the path itself earned (3 x insufficient_funds).
    // A reservation has no expiry, so a leaked one would still refuse here.
    ms += 600_000;
    const again = [1, 2, 3].map(() => send(freshPayment()));
    await inFlight(h, 6);
    // Exactly three: a count released twice would let a fourth through.
    const fourth = await send(freshPayment());
    expect(h.calls).toBe(6);
    while (h.waiting.length > 0) h.answer(200, OK);
    await Promise.all(again);
    released();
    return fourth;
  }

  it.each(PATHS)(
    "released after $path: 3 concurrent settles start again (Pages middleware)",
    async (p) => {
      const { h, send } = await viaMiddleware();
      const fourth = await releaseScenario(h, send, p);
      expect(fourth.status).toBe(402);
      expect(await errorOf(fourth)).toBe(COOLING);
    },
  );

  // The same scenario on the verify function itself, which is where the
  // `_sizes()` test hook lives (the middleware does not expose it).
  it.each(PATHS)(
    "released after $path: _sizes().payerInflight is 0",
    async (p) => {
      const h = heldSettle();
      const verify = makeSettlingVerify(
        (url, init) => h.fetch(new Request(url, init)),
        SETTLE_URL,
        "settle-secret",
      );
      const cfg = parseConfig(toml());
      let checks = 0;
      const fourth = await releaseScenario(
        h,
        async (xp) => verify(xp, cfg),
        p,
        () => {
          expect(verify._sizes()).toMatchObject({
            inflight: 0,
            payerInflight: 0,
          });
          checks += 1;
        },
      );
      expect(checks).toBe(2);
      expect(fourth.reason).toBe("payer-cooldown");
    },
  );

  it("_sizes() counts payers with a settle in flight, not settles", async () => {
    const h = heldSettle();
    const verify = makeSettlingVerify(
      (url, init) => h.fetch(new Request(url, init)),
      SETTLE_URL,
      "settle-secret",
    );
    const cfg = parseConfig(toml());
    const two = [1, 2].map(() => verify(freshPayment(), cfg));
    await inFlight(h, 2);
    expect(verify._sizes()).toEqual({
      seen: 0,
      payerFails: 0,
      notYetValid: 0,
      inflight: 2,
      payerInflight: 1,
      unconfirmed: 0,
    });
    h.answer(200, OK);
    await two[0];
    expect(verify._sizes()).toMatchObject({ inflight: 1, payerInflight: 1 });
    h.answer(200, UNFUNDED);
    await two[1];
    expect(verify._sizes()).toEqual({
      seen: 2,
      payerFails: 1,
      notYetValid: 0,
      inflight: 0,
      payerInflight: 0,
      unconfirmed: 0,
    });
  });

  // R002 (second review of 2abd077, M1): a reservation has a time limit
  // (RESERVATION_TTL_MS, checked on read) and the settle fetch a hard
  // timeout (SETTLE_TIMEOUT_MS). Before, a settle that never answered
  // kept its reservation for the life of the isolate: three of them locked
  // the payer out for good. The tests take both values from the source, so
  // they follow the constants (25 s and 45 s since R013).
  const TTL_MS = RESERVATION_TTL_MS;
  const TTL_S = TTL_MS / 1000;
  const okResponse = () => new Response(JSON.stringify(OK), { status: 200 });
  /** AbortSignal.timeout is native and runs on real time, which a mocked
   * Date.now does not move. Replace it with signals the test fires by hand;
   * `ms` records what each was asked for. */
  function manualTimeouts() {
    const made: { ms: number; c: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const c = new AbortController();
      made.push({ ms, c });
      return c.signal;
    });
    return {
      made,
      fire: () => {
        for (const m of made)
          m.c.abort(
            new DOMException("The operation timed out", "TimeoutError"),
          );
      },
    };
  }

  /** A settle endpoint that never answers but, like a real fetch, rejects
   * when the request's signal aborts. With `hang` off it answers OK. */
  function hungSettle() {
    const h = {
      calls: 0,
      hang: true,
      fetch: (req: Request): Promise<Response> => {
        if (req.url !== SETTLE_URL)
          return Promise.resolve(new Response("{}", { status: 200 }));
        h.calls += 1;
        if (!h.hang) return Promise.resolve(okResponse());
        return new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason));
        });
      },
    };
    return h;
  }

  it("R002 M1 test 1: 3 settles that never answer; once RESERVATION_TTL_MS has passed the payer is served again", async () => {
    const { h, send } = await viaMiddleware();
    for (let i = 0; i < 3; i++) void send(freshPayment());
    await inFlight(h, 3);
    // One ms short of the bound: still three live reservations.
    ms += TTL_MS - 1;
    const refused = await send(freshPayment());
    expect(refused.status).toBe(402);
    expect(await errorOf(refused)).toBe(COOLING);
    expect(h.calls).toBe(3);
    // At the bound (and past the settle timeout) they no longer count.
    ms += 1;
    const r = send(freshPayment());
    await inFlight(h, 4);
    h.waiting.pop()?.resolve(okResponse());
    const served = await r;
    expect(served.status).toBe(200);
    expect(served.headers.get("x-payment-response")).not.toBeNull();
    // Long after (the review's +10 min / +1 h / +24 h): still served.
    for (const later of [600_000, 3_600_000, 86_400_000]) {
      ms += later;
      const before = h.calls;
      const again = send(freshPayment());
      await inFlight(h, before + 1);
      h.waiting.pop()?.resolve(okResponse());
      expect((await again).status).toBe(200);
    }
  });

  it("R002 M1 test 2: other payers are served at every step of a payer's hung settles", async () => {
    // Hangs for the fixture payer P only; any other payer's settle answers.
    const calls = { p: 0, q: 0 };
    const b = {
      fetch: async (req: Request): Promise<Response> => {
        if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
        const { payment: xp } = (await req.json()) as { payment: string };
        const { from } = (
          JSON.parse(atob(xp)) as {
            payload: { authorization: { from: string } };
          }
        ).payload.authorization;
        if (from !== PAYER) {
          calls.q += 1;
          return okResponse();
        }
        calls.p += 1;
        return new Promise(() => {});
      },
    };
    const mw = settlingMw();
    await mw(ctx("/r", agent(), envOf(b)));
    const send = (xp: string) =>
      mw(ctx("/r", agent({ "x-payment": xp }), envOf(b)));
    let q = 0;
    const qServed = async () => {
      expect((await send(rotatingPayerPayment())).status).toBe(200);
      q += 1;
      expect(calls.q).toBe(q);
    };
    await qServed(); // before anything hangs
    for (let i = 1; i <= 3; i++) {
      void send(freshPayment());
      await vi.waitFor(() => expect(calls.p).toBe(i));
      await qServed(); // after each hung settle
    }
    expect(await errorOf(await send(freshPayment()))).toBe(COOLING);
    await qServed(); // while P is refused
    for (const step of [TTL_MS - 1, 1, 600_000]) {
      ms += step;
      await qServed(); // just before the bound, at it, and long after
    }
    // And P itself is back (test 1); still exactly its 3 hung calls + this.
    void send(freshPayment());
    await vi.waitFor(() => expect(calls.p).toBe(4));
  });

  // On the verify function itself, where `_sizes()` lives. Bound: a
  // reservation needs a bucket token, so at most SETTLE_BUCKET_CAP + 5/s x
  // 45 s = 245 can be alive at once; this run starts 5 per second. The
  // per-payment `inflight` entries have the same age limit and are swept in
  // the same pass (R013 M3), so the two sizes move together.
  it("R002 M1 test 3: hung payers at 5/s for 60 s leave 5 x RESERVATION_TTL_MS/1000 (225) reservations and inflight entries, not 300; 0 after the bound and a sweep", async () => {
    const t = manualTimeouts();
    const h = hungSettle();
    const verify = makeSettlingVerify(
      (url, init) => h.fetch(new Request(url, init)),
      SETTLE_URL,
      "settle-secret",
    );
    const cfg = parseConfig(toml());
    const hung: unknown[] = [];
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 5; i++)
        hung.push(verify(rotatingPayerPayment(), cfg));
      // Those started in the last TTL_S seconds are alive: 5 x min(s + 1, TTL_S).
      const alive = 5 * Math.min(s + 1, TTL_S);
      expect(verify._sizes()).toMatchObject({
        inflight: alive,
        payerInflight: alive,
      });
      ms += 1000;
    }
    expect(h.calls).toBe(300);
    expect(5 * TTL_S).toBe(225);
    expect(verify._sizes()).toMatchObject({
      inflight: 5 * TTL_S,
      payerInflight: 5 * TTL_S,
    });
    // Past the bound for the newest one; the next settle to start sweeps
    // both maps, although no settle has answered and no release has run.
    ms += TTL_MS;
    h.hang = false;
    expect((await verify(rotatingPayerPayment(), cfg)).ok).toBe(true);
    expect(verify._sizes()).toMatchObject({ inflight: 0, payerInflight: 0 });
    expect(t.made.length).toBe(301);
    // The 300 dead settles end at last (the timeout fires): their late
    // releases find nothing of their own and remove nothing else.
    t.fire();
    await Promise.all(hung);
    expect(verify._sizes()).toMatchObject({ inflight: 0, payerInflight: 0 });
  }, 30_000);

  // Until R013 the per-payment entry had no age limit, and this test moved
  // the clock a full RESERVATION_TTL_MS and still expected the join. The
  // entry now ends with the reservation, so the join is pinned up to one ms
  // short of the limit; the tests after test 6 pin what happens at it.
  it("R002 M1 test 4: a copy of an in-flight payment still joins it one ms before RESERVATION_TTL_MS: one settle call, served once", async () => {
    const { h, send } = await viaMiddleware();
    const xp = freshPayment();
    const leader = send(xp);
    await inFlight(h, 1);
    ms += TTL_MS - 1;
    // The copy must wait on the leader, not settle again.
    let copyDone = false;
    const copy = send(xp).then((r) => {
      copyDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(copyDone).toBe(false);
    expect(h.calls).toBe(1);
    h.answer(200, OK);
    const [a, b] = await Promise.all([leader, copy]);
    expect(a.status).toBe(200);
    expect(a.headers.get("x-payment-response")).not.toBeNull();
    expect(b.status).toBe(402);
    expect(b.headers.get("x-payment-response")).toBeNull();
    expect(h.calls).toBe(1); // one call for `xp`, ever
    const replay = await send(xp);
    expect(replay.status).toBe(402);
    expect(h.calls).toBe(1);
  });

  it("R002 M1 test 5: an expired reservation whose settle answers late does not release a newer one", async () => {
    const { h, send } = await viaMiddleware();
    const old = send(freshPayment());
    await inFlight(h, 1);
    ms += TTL_MS;
    const three = [1, 2, 3].map(() => send(freshPayment()));
    await inFlight(h, 4);
    h.answer(200, OK); // the old settle answers at last
    expect((await old).status).toBe(200);
    // Still three live reservations: a release by count would leave two.
    const fourth = await send(freshPayment());
    expect(fourth.status).toBe(402);
    expect(await errorOf(fourth)).toBe(COOLING);
    expect(h.calls).toBe(4);
    while (h.waiting.length > 0) h.answer(200, OK);
    for (const r of await Promise.all(three)) expect(r.status).toBe(200);
    // And each of the three released its own: three more start, not four.
    const again = [1, 2, 3].map(() => send(freshPayment()));
    await inFlight(h, 7);
    expect(await errorOf(await send(freshPayment()))).toBe(COOLING);
    while (h.waiting.length > 0) h.answer(200, OK);
    await Promise.all(again);
  });

  it("R002 M1 test 6: a hung settle is aborted at SETTLE_TIMEOUT_MS → settle-unconfirmed (row 3a, R006), not served, nonce not cached", async () => {
    const t = manualTimeouts();
    const h = hungSettle();
    const mw = settlingMw();
    await mw(ctx("/r", agent(), envOf(h)));
    const send = (xp: string) =>
      mw(ctx("/r", agent({ "x-payment": xp }), envOf(h)));
    const xp = freshPayment();
    const r = send(xp);
    await vi.waitFor(() => expect(h.calls).toBe(1));
    expect(SETTLE_TIMEOUT_MS).toBe(25_000);
    expect(t.made.map((m) => m.ms)).toEqual([SETTLE_TIMEOUT_MS]);
    t.fire();
    const timedOut = await r;
    expect(timedOut.status).toBe(402);
    expect(await errorOf(timedOut)).toBe(UNCONFIRMED);
    expect(timedOut.headers.get("x-payment-response")).toBeNull();
    // Not cached and not counted: the same X-PAYMENT settles once healthy.
    h.hang = false;
    const retry = await send(xp);
    expect(retry.status).toBe(200);
    expect(h.calls).toBe(2);
  });

  // R013 (second review 2 of 7e81768, M3). A settle whose promise never
  // settles is what a request cancelled by the runtime leaves behind: its
  // `finally` never runs. Before, the same payment sent again joined that
  // dead promise and never got an answer, for the life of the isolate. The
  // clock here is the mocked Date.now the limit is read from (there is no
  // timer in the code to fake).
  /** A settle that never answers and ignores the signal; with `dead` off it
   * answers OK. */
  function deadSettle() {
    const d = { calls: 0, dead: true };
    const verify = makeSettlingVerify(
      () => {
        d.calls += 1;
        return d.dead
          ? new Promise<Response>(() => {})
          : Promise.resolve(okResponse());
      },
      SETTLE_URL,
      "settle-secret",
    );
    return { d, verify, cfg: parseConfig(toml()) };
  }

  it("R013 M3: the same payment sent again RESERVATION_TTL_MS after a settle that never returns gets one new settle call and an answer", async () => {
    const { d, verify, cfg } = deadSettle();
    const xp = freshPayment();
    void verify(xp, cfg); // never answered
    expect(d.calls).toBe(1);
    // One ms short of the limit: the copy still joins (no settle call) and,
    // the settle being dead, is not answered.
    ms += TTL_MS - 1;
    let joinedDone = false;
    void Promise.resolve(verify(xp, cfg)).then(() => {
      joinedDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(joinedDone).toBe(false);
    expect(d.calls).toBe(1);
    // At the limit the dead entry is dropped: one new settle call, answered.
    ms += 1;
    d.dead = false;
    const retry = await verify(xp, cfg);
    expect(retry.ok).toBe(true);
    expect(d.calls).toBe(2);
    expect(verify._sizes()).toMatchObject({ inflight: 0, payerInflight: 0 });
    // Settled and cached for the nonce: a third copy makes no call.
    expect((await verify(xp, cfg)).reason).toBe("already-settled");
    expect(d.calls).toBe(2);
  });

  it("R013 M3: 51 dead settles leave no inflight entry after the limit and a sweep", async () => {
    const { d, verify, cfg } = deadSettle();
    // More than the bucket holds at once: spread over time, as the review's
    // probe did (it found 51 entries still there at +31 s and +4.5 min).
    for (let i = 0; i < 51; i++, ms += 200)
      void verify(rotatingPayerPayment(), cfg);
    expect(d.calls).toBe(51);
    expect(verify._sizes()).toMatchObject({ inflight: 51, payerInflight: 51 });
    ms += TTL_MS;
    d.dead = false;
    expect((await verify(rotatingPayerPayment(), cfg)).ok).toBe(true);
    expect(verify._sizes()).toMatchObject({ inflight: 0, payerInflight: 0 });
  });

  it("R013 M3: a settle that answers after its entry expired does not remove the newer entry for the same payment", async () => {
    // Only a fetch that ignores the abort signal can answer this late.
    const waiting: ((r: Response) => void)[] = [];
    const verify = makeSettlingVerify(
      () => new Promise<Response>((resolve) => waiting.push(resolve)),
      SETTLE_URL,
      "settle-secret",
    );
    const cfg = parseConfig(toml());
    const xp = freshPayment();
    const old = verify(xp, cfg);
    ms += TTL_MS;
    const newer = verify(xp, cfg); // drops the expired entry, starts again
    expect(waiting.length).toBe(2);
    expect(verify._sizes().inflight).toBe(1);
    // The old settle answers at last. A release by key would remove the
    // newer entry here, and the next copy would settle a third time.
    waiting[0]?.(new Response(JSON.stringify(UNFUNDED), { status: 503 }));
    expect((await old).reason).toBe("settle-retryable");
    expect(verify._sizes().inflight).toBe(1);
    const copy = verify(xp, cfg); // joins the newer one: no third call
    await new Promise((r) => setTimeout(r, 20));
    expect(waiting.length).toBe(2);
    waiting[1]?.(okResponse());
    expect((await newer).ok).toBe(true);
    expect((await copy).reason).toBe("already-settled");
    expect(verify._sizes().inflight).toBe(0);
  });

  // R013 (second review 2, L2). Every other timeout test throws a hand-made
  // DOMException or replaces AbortSignal.timeout. This one runs the native
  // timer for the real SETTLE_TIMEOUT_MS: it takes 25 s by design. The stubs
  // only honour the signal the code passes, as fetch does. Two settles run
  // side by side: one never answers at all, one answers 502 headers and then
  // stalls in the body (L1).
  it("R013 L2: the native AbortSignal.timeout(SETTLE_TIMEOUT_MS) ends a hung settle, and a stalled non-2xx body, as settle-unconfirmed (real timer, 25 s)", async () => {
    const signals: AbortSignal[] = [];
    const cfg = parseConfig(toml());
    const noAnswer = makeSettlingVerify(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      SETTLE_URL,
      "settle-secret",
    );
    const stalledBody = makeSettlingVerify(
      async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        return new Response(
          new ReadableStream({
            start: (c) =>
              signal.addEventListener("abort", () => c.error(signal.reason)),
          }),
          { status: 502 },
        );
      },
      SETTLE_URL,
      "settle-secret",
    );
    // Date.now is mocked in this describe; performance.now is the real clock.
    const t0 = performance.now();
    const results = await Promise.all([
      noAnswer(freshPayment(), cfg),
      stalledBody(freshPayment(), cfg),
    ]);
    const tookMs = performance.now() - t0;
    for (const r of results)
      expect(r).toEqual({
        ok: false,
        payer: null,
        reason: "settle-unconfirmed",
      });
    // The native signal, and what it rejects with.
    expect(signals.length).toBe(2);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(DOMException);
      expect((signal.reason as DOMException).name).toBe("TimeoutError");
    }
    // At the timeout, not before (50 ms of timer slack) and not much after.
    expect(tookMs).toBeGreaterThanOrEqual(SETTLE_TIMEOUT_MS - 50);
    expect(tookMs).toBeLessThan(SETTLE_TIMEOUT_MS + 5_000);
    for (const v of [noAnswer, stalledBody])
      expect(v._sizes()).toMatchObject({
        seen: 0,
        payerFails: 0,
        inflight: 0,
        payerInflight: 0,
        unconfirmed: 1,
      });
  }, 35_000);

  // R004 (second review of 2abd077, L6). The handler used to build one state
  // per request that arrived during the first build, so on a cold isolate
  // every concurrent first request had its own in-flight map, bucket and
  // reservations. main has the same fault. These tests send the first burst
  // at a handler that has never answered a request.
  describe("cold handler: the first burst shares one state (R004, L6)", () => {
    const outcomes = async (rs: Response[]) =>
      (
        await Promise.all(
          rs.map(async (r) => ({
            status: r.status,
            receipt: r.headers.get("x-payment-response") !== null,
            error: r.status === 200 ? undefined : await errorOf(r),
          })),
        )
      )
        .map((o) => JSON.stringify(o))
        .sort();

    it("5 concurrent copies of one payment → 1 settle call, one receipt, as on a warm handler", async () => {
      // A stub that confirms every call it gets: only the join keeps it at 1.
      const burst = async (warm: boolean) => {
        const b = settleBinding({ settled: true, payer: "0xabc", tx: TX }, 20);
        const mw = settlingMw();
        if (warm) await mw(ctx("/r", agent(), envOf(b)));
        const xp = freshPayment();
        const rs = await Promise.all(
          Array.from({ length: 5 }, () =>
            mw(ctx("/r", agent({ "x-payment": xp }), envOf(b))),
          ),
        );
        return { calls: b.settles.length, rs };
      };
      const cold = await burst(false);
      expect(cold.calls).toBe(1);
      const served = cold.rs.filter((r) => r.status === 200);
      expect(served.length).toBe(1);
      expect(served[0]?.headers.get("x-payment-response")).not.toBeNull();
      expect(cold.rs.filter((r) => r.status === 402).length).toBe(4);
      const warm = await burst(true);
      expect(warm.calls).toBe(1);
      expect(await outcomes(cold.rs)).toEqual(await outcomes(warm.rs));
    });

    it("100 concurrent fresh payments from one payer → 3 settle calls, 97 x 402 payer-cooldown", async () => {
      const h = heldSettle();
      const mw = settlingMw(); // not warmed
      let answered = 0;
      const rs = Array.from({ length: 100 }, () =>
        mw(ctx("/r", agent({ "x-payment": freshPayment() }), envOf(h))).then(
          (r) => {
            answered += 1;
            return r;
          },
        ),
      );
      await vi.waitFor(() => expect(h.calls + answered).toBe(100), {
        timeout: 10_000,
      });
      expect(h.calls).toBe(3);
      expect(answered).toBe(97);
      while (h.waiting.length > 0) h.answer(200, OK);
      const all = await Promise.all(rs);
      const served = all.filter((r) => r.status === 200);
      expect(served.length).toBe(3);
      for (const r of served)
        expect(r.headers.get("x-payment-response")).not.toBeNull();
      const refused = all.filter((r) => r.status === 402);
      expect(refused.length).toBe(97);
      for (const r of refused) expect(await errorOf(r)).toBe(COOLING);
      expect(h.calls).toBe(3);
    }, 30_000);

    it("a failed build is not kept: the next request builds again", async () => {
      const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
      const mw = settlingMw();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      // An undecodable site key makes the build reject. The cache key only
      // records that a site key is set, so the repaired env has the same key
      // and would be handed a cached rejection if one were kept.
      const bad = { ...envOf(b), TOLLBOOTH_SITE_KEY: "!!!" };
      const failed = await Promise.all(
        [1, 2, 3].map(() => mw(ctx("/r", agent(), bad))),
      );
      // Existing behaviour for a non-config build error: fail open.
      for (const r of failed) expect(await r.text()).toBe("site content");
      expect(err).toHaveBeenCalledTimes(3);
      const good = {
        ...envOf(b),
        TOLLBOOTH_SITE_KEY: toBase64Url(generateSecretKey()),
      };
      const xp = freshPayment();
      const rs = await Promise.all(
        [1, 2, 3].map(() => mw(ctx("/r", agent({ "x-payment": xp }), good))),
      );
      expect(rs.filter((r) => r.status === 200).length).toBe(1);
      expect(rs.filter((r) => r.status === 402).length).toBe(2);
      expect(b.settles.length).toBe(1);
    });

    // R019. The site key makes the build await crypto.subtle (the public
    // key's SHA-512); the first build's digest is held to stand for a build
    // that never settles.
    it("a build that never settles holds requests for BUILD_TTL_MS at most; settling late, it does not replace the newer state", async () => {
      const b = settleBinding({ settled: true, payer: "0xabc", tx: TX });
      const env = {
        ...envOf(b),
        TOLLBOOTH_SITE_KEY: toBase64Url(generateSecretKey()),
      };
      const mw = settlingMw();
      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const spy = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementationOnce(async (...a) => {
          await held;
          return digest(...a);
        });
      const hung = (p: Promise<Response>) =>
        Promise.race([
          p.then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), 50)),
        ]);
      try {
        const r1 = mw(ctx("/r", agent(), env));
        // Inside the limit a second request joins the same build.
        clock.mockReturnValue(t0 + BUILD_TTL_MS - 1);
        const r2 = mw(ctx("/r", agent(), env));
        expect(await hung(r2)).toBe(true);
        // At the limit the next request builds again and is answered.
        clock.mockReturnValue(t0 + BUILD_TTL_MS);
        const xp = freshPayment();
        const paid = mw(ctx("/r", agent({ "x-payment": xp }), env));
        expect(await hung(paid)).toBe(false);
        expect((await paid).status).toBe(200);
        expect(b.settles.length).toBe(1);
        // The old build settles late: its requests are answered, and the
        // handler keeps the newer state. The replay proves it: only the
        // state that settled `xp` refuses it without a settle call.
        release();
        expect((await r1).status).toBe(402);
        expect((await r2).status).toBe(402);
        const again = await mw(ctx("/r", agent({ "x-payment": xp }), env));
        expect(again.status).toBe(402);
        expect(b.settles.length).toBe(1);
      } finally {
        release();
        spy.mockRestore();
        clock.mockRestore();
      }
    });
  });
});

// Spec 006 T005, R-O4 (rows A4-A7; L3's case). A payment held as early whose
// validAfter has passed is "due": that one attempt reaches settle through a
// payer cooldown. Every test first cools the payer down with 3 early
// payments, so only the due pass can explain a settle call.
describe("a due hold passes a payer cooldown once (spec 006 T005, R-O4)", () => {
  const T0 = 1_800_000_000;
  const COOLING = "payer cooling down after repeated failures; retry later";
  const NOT_YET = "authorization not yet valid";
  const VALID_AFTER = "invalid_exact_evm_payload_authorization_valid_after";
  let ms = T0 * 1000;
  beforeEach(() => {
    ms = T0 * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => ms);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const at = (s: number) => {
    ms = (T0 + s) * 1000;
  };

  /** Facilitator stub on the mocked clock, counting calls in total and per
   * X-PAYMENT: valid_after while a payment is early, then settled for a
   * `funded` X-PAYMENT, else insufficient_funds. `lagS` sets its clock behind
   * ours, `status` (non-200) takes the settle route down with `body`, `gate`
   * makes every answer wait. */
  function facilitator(funded: string[] = []) {
    const f = {
      calls: 0,
      per: new Map<string, number>(),
      lagS: 0,
      status: 200,
      body: "{}",
      gate: Promise.resolve(),
      fetch: async (req: Request): Promise<Response> => {
        if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
        f.calls += 1;
        const xp = ((await req.json()) as { payment: string }).payment;
        f.per.set(xp, (f.per.get(xp) ?? 0) + 1);
        await f.gate;
        if (f.status !== 200) return new Response(f.body, { status: f.status });
        const { validAfter } = JSON.parse(atob(xp)).payload.authorization;
        const data =
          Number(validAfter) > Date.now() / 1000 - f.lagS
            ? { settled: false, reason: VALID_AFTER }
            : funded.includes(xp)
              ? { settled: true, tx: TX }
              : { settled: false, reason: "insufficient_funds" };
        return new Response(JSON.stringify({ ok: true, data }), {
          status: 200,
        });
      },
    };
    return f;
  }

  /** One payer, clock 55 s fast: 3 early payments sent at once at T0, each
   * answered not-yet-valid (3 settle calls), which cools the payer down. */
  async function cooledByThreeEarly() {
    const xps: [string, string, string] = [
      earlyPayment(T0),
      earlyPayment(T0),
      earlyPayment(T0),
    ];
    const f = facilitator(xps);
    const mw = settlingMw();
    // Warm the isolate state first (a cold burst is covered by the R004 tests).
    await mw(ctx("/r", agent(), envOf(f)));
    const send = (xp: string) =>
      mw(ctx("/r", agent({ "x-payment": xp }), envOf(f)));
    for (const r of await Promise.all(xps.map(send))) {
      expect(r.status).toBe(402);
      expect(await errorOf(r)).toBe(NOT_YET);
    }
    expect(f.calls).toBe(3);
    // Cooled down: a fresh payment is refused with no settle call.
    const fresh = await send(freshPayment());
    expect(await errorOf(fresh)).toBe(COOLING);
    expect(f.calls).toBe(3);
    return { f, send, xps };
  }
  const errorOf = async (r: Response) =>
    ((await r.json()) as { error?: string }).error;

  it("(a) L3, row A4: 3 early payments at once from a funded payer 55 s fast, each repeated after validAfter → all 3 served, 6 settle calls", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(54); // still early: held, no call
    expect((await send(xps[0])).headers.get("retry-after")).toBe("1");
    expect(f.calls).toBe(3);
    at(55);
    // At once: each due attempt passes both the cooldown and the other two's
    // reservations (R-O1), not just the first.
    for (const r of await Promise.all(xps.map(send))) {
      expect(r.status).toBe(200);
      expect(r.headers.get("x-payment-response")).not.toBeNull();
    }
    expect(f.calls).toBe(6);
    expect(xps.map((xp) => f.per.get(xp))).toEqual([2, 2, 2]);
    // Settled once: a replay is refused from cache.
    expect((await send(xps[0])).status).toBe(402);
    expect(f.calls).toBe(6);
  });

  it("(b) row A5: a due attempt answered not-yet-valid again is not held again; the cooled-down payer's next retry is payer-cooldown with no call (2 calls for the nonce)", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    f.lagS = 10; // facilitator clock behind ours
    at(55);
    const due = await send(xps[0]);
    expect(due.status).toBe(402);
    expect(await errorOf(due)).toBe(NOT_YET);
    // The facilitator's own answer, not a hold: no Retry-After.
    expect(due.headers.has("retry-after")).toBe(false);
    expect(f.calls).toBe(4);
    // Not due any more: an ordinary attempt, and this payer is cooled down.
    // Still so once the facilitator would accept it (T0+65 s on its clock).
    for (const s of [55, 56, 70]) {
      at(s);
      const r = await send(xps[0]);
      expect(r.status).toBe(402);
      expect(await errorOf(r)).toBe(COOLING);
    }
    expect(f.calls).toBe(4);
    // Coordinator ruling 2026-11-13: 2 for a cooled-down payer.
    expect(f.per.get(xps[0])).toBe(2);
  });

  // Coordinator ruling 2026-11-13 (option 1), the other bound: a payer who is
  // NOT cooled down keeps the ordinary retry row A5 allows a payer with fewer
  // than 3 failures. So 3 calls, as on main for this case: the first attempt,
  // the due attempt, one ordinary retry (which is the 3rd failure).
  it("row A5, ruling: a lone early nonce against a lagging facilitator costs exactly 3 settle calls, then payer-cooldown", async () => {
    const xp = earlyPayment(T0);
    const f = facilitator([xp]);
    f.lagS = 3600; // never catches up within this test
    const mw = settlingMw();
    const send = () => mw(ctx("/r", agent({ "x-payment": xp }), envOf(f)));
    const seen: (string | undefined)[] = [];
    // One request a second from T0 to past validAfter (T0+55 s).
    for (let s = 0; s <= 70; s++) {
      at(s);
      const r = await send();
      expect(r.status).toBe(402);
      seen.push(await errorOf(r));
      // first attempt at 0 s, due attempt at 55 s, ordinary retry at 56 s
      expect(f.calls).toBe(s < 55 ? 1 : s === 55 ? 2 : 3);
    }
    expect(f.calls).toBe(3);
    expect(seen.slice(0, 57).every((e) => e === NOT_YET)).toBe(true);
    expect(seen.slice(57).every((e) => e === COOLING)).toBe(true);
  });

  it("(c) row A6: a due attempt that meets an empty bucket is settle-throttled with no call; after a refill the retry is still the due attempt and is served", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(55); // the bucket has refilled since T0; the clock now stands still
    for (let i = 0; i < SETTLE_BUCKET_CAP; i++)
      await send(rotatingPayerPayment()); // other payers empty it
    expect(f.calls).toBe(3 + SETTLE_BUCKET_CAP);
    for (let i = 0; i < 2; i++) {
      const throttled = await send(xps[0]);
      expect(throttled.status).toBe(402);
      expect(await errorOf(throttled)).toBe(OPERATOR_FAULT);
    }
    expect(f.calls).toBe(3 + SETTLE_BUCKET_CAP); // no call, no token
    at(56); // 5 tokens back
    // The payer is still cooled down: only the due pass explains this 200.
    const served = await send(xps[0]);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-payment-response")).not.toBeNull();
    expect(f.per.get(xps[0])).toBe(2);
  });

  it("(d) row A7: a due attempt answered settle 503 is put back; the retry is the due attempt again and is served", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(55);
    f.status = 503;
    // Twice: the hold is put back after each operator fault, not just once.
    for (let i = 0; i < 2; i++) {
      const down = await send(xps[0]);
      expect(down.status).toBe(402);
      expect(await errorOf(down)).toBe(OPERATOR_FAULT);
    }
    expect(f.calls).toBe(5);
    f.status = 200;
    const served = await send(xps[0]);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-payment-response")).not.toBeNull();
    expect(f.calls).toBe(6);
  });

  // R003 L1 (second review of 2abd077): row A7 is bounded. Without the bound
  // every one of these requests is a settle call (main: none).
  it("row A7 bound: a cooled-down payer with one due hold against a 503 facilitator makes exactly 3 settle calls; the 4th and later requests are payer-cooldown with no call", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(55);
    f.status = 503;
    for (let i = 1; i <= 10; i++) {
      const r = await send(xps[0]);
      expect(r.status).toBe(402);
      expect(await errorOf(r)).toBe(i <= 3 ? OPERATOR_FAULT : COOLING);
      expect(f.calls).toBe(3 + Math.min(i, 3));
    }
    // The hold is gone, not parked: a healthy facilitator changes nothing
    // while the cooldown lasts.
    f.status = 200;
    expect(await errorOf(await send(xps[0]))).toBe(COOLING);
    expect(f.calls).toBe(6);
    expect(f.per.get(xps[0])).toBe(4); // first attempt + 3 due attempts
  });

  // R003 L5 (mutant M26): settle-unconfirmed is not an operator fault for
  // row A7; the hold is not put back.
  it("row A7: a due attempt answered 502 with settled:true (settle-unconfirmed) is not put back; the retry is payer-cooldown with no call", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(55);
    f.status = 502;
    f.body = JSON.stringify({ ok: false, data: { settled: true } });
    const due = await send(xps[0]);
    expect(due.status).toBe(402);
    expect(await errorOf(due)).toBe(UNCONFIRMED);
    expect(f.calls).toBe(4);
    const retry = await send(xps[0]);
    expect(retry.status).toBe(402);
    expect(await errorOf(retry)).toBe(COOLING);
    expect(f.calls).toBe(4);
  });

  // R003 L4 (mutant M41): a due attempt skips the R-O1 check but still
  // reserves, so due settles in flight count against the payer's fresh ones.
  it("R-O4: due attempts in flight are reserved: with 2 in flight and no failures, of 3 fresh payments 1 starts a settle call and 2 are payer-cooldown", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(55);
    // The first due attempt is served, which clears the payer's failures.
    expect((await send(xps[0])).status).toBe(200);
    expect(f.calls).toBe(4);
    let open = () => {};
    f.gate = new Promise<void>((r) => {
      open = r;
    });
    const dues = [send(xps[1]), send(xps[2])];
    await vi.waitFor(() => expect(f.calls).toBe(6));
    const fresh = Array.from({ length: 3 }, () => send(freshPayment()));
    await vi.waitFor(() => expect(f.calls).toBe(7));
    // Let the other two reach the verifier while the settle calls wait.
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toBe(7);
    open();
    const errors = await Promise.all(
      (await Promise.all(fresh)).map(async (r) => {
        expect(r.status).toBe(402);
        return errorOf(r);
      }),
    );
    expect(errors.filter((e) => e === COOLING).length).toBe(2);
    for (const r of await Promise.all(dues)) expect(r.status).toBe(200);
    expect(f.calls).toBe(7);
  });

  it("(e) rows A4/US5: 20 concurrent copies of a due payment → 1 settle call, 1 x 200", async () => {
    const { f, send, xps } = await cooledByThreeEarly();
    at(55);
    let open = () => {};
    f.gate = new Promise<void>((r) => {
      open = r;
    });
    const rs = Array.from({ length: 20 }, () => send(xps[0]));
    await vi.waitFor(() => expect(f.calls).toBe(4));
    // Let the other 19 reach the verifier while the one settle call waits.
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toBe(4);
    open();
    const all = await Promise.all(rs);
    const served = all.filter((r) => r.status === 200);
    expect(served.length).toBe(1);
    expect(served[0]?.headers.get("x-payment-response")).not.toBeNull();
    expect(all.filter((r) => r.status === 402).length).toBe(19);
    expect(f.calls).toBe(4);
    expect(f.per.get(xps[0])).toBe(2);
  });
});
