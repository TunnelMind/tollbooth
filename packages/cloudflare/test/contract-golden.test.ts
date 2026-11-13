// Spec 006 FR-001: the golden contract. The 26 response shapes a client can
// see from the Pages settle middleware, each recorded whole (status, every
// header, body) as a snapshot taken on main's source before any change.
// A later task may change only the entries its before/after row names; any
// other diff in the .snap file is a regression.
//
// Deterministic by construction: Date.now is pinned, the payer key is the
// fixtures' fixed key, nonces and tx ids are fixed. Never run with `-u`
// unless the spec row for your task names the entry that moves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeAuth,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import { publicKeyOf, toBase64Url } from "../../core/src/keys.js";
import { ed25519Thumbprint } from "../../core/src/wba.js";
import { signedRequest, type TestAgent } from "../../core/test/fixtures/wba.js";
import { createPagesMiddleware, SETTLE_BUCKET_CAP } from "../src/index.js";
import { agent, ctx, human, toml } from "./helpers.js";

const SETTLE_URL = "https://collector.example/v1/settle";
// A well-formed on-chain tx id (0x + 32-byte hex).
const TX = `0x${"ab".repeat(32)}`;
const T0 = 1_800_000_000; // epoch seconds; also the WBA fixtures' NOW
const VALID_AFTER = "invalid_exact_evm_payload_authorization_valid_after";

const SETTLED = { ok: true, data: { settled: true, payer: "0xabc", tx: TX } };
const UNFUNDED = {
  ok: true,
  data: { settled: false, reason: "insufficient_funds" },
};

/** A signed X-PAYMENT with fixed nonce number `n`; valid at T0 unless overridden. */
function pay(
  n: number,
  over: { value?: string; validAfter?: string; validBefore?: string } = {},
): string {
  const auth = makeAuth({
    value: "1000", // 0.001 USDC, the configured price
    validAfter: "0",
    validBefore: String(T0 + 300),
    nonce: `0x${n.toString(16).padStart(64, "0")}`,
    ...over,
  });
  return payment(auth, signAuth(auth));
}

/** A settle endpoint answering `status` with `body` verbatim (a string is
 * sent raw); both can be changed between calls. `throws` = transport error. */
function settleStub(status: number, body: unknown) {
  const s = {
    calls: 0,
    status,
    body,
    throws: false,
    fetch: async (req: Request) => {
      if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
      s.calls += 1;
      if (s.throws) throw new TypeError("fetch failed");
      const b = s.body;
      return new Response(typeof b === "string" ? b : JSON.stringify(b), {
        status: s.status,
      });
    },
  };
  return s;
}

const settlingMw = (extra: { corpus?: { seed: string; pages: number } } = {}) =>
  createPagesMiddleware({
    config: toml(),
    settle: { url: SETTLE_URL },
    binding: "DATA_API",
    ...extra,
  });
const envOf = (b: { fetch: (req: Request) => Promise<Response> }) => ({
  TOLLBOOTH_SETTLE_TOKEN: "settle-secret",
  DATA_API: b,
});

/** What the client sees, whole. */
async function shape(r: Response) {
  return {
    status: r.status,
    headers: [...r.headers.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    body: await r.text(),
  };
}

/** One request with X-PAYMENT `xp` through a fresh middleware over `s`. */
const paid = (
  mw: ReturnType<typeof settlingMw>,
  s: ReturnType<typeof settleStub>,
  xp: string,
) => mw(ctx("/research", agent({ "x-payment": xp }), envOf(s)));

describe("golden contract (spec 006 FR-001)", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(T0 * 1000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no payment", async () => {
    const s = settleStub(200, SETTLED);
    const r = await settlingMw()(ctx("/research", agent(), envOf(s)));
    expect(await shape(r)).toMatchSnapshot();
    expect(s.calls).toBe(0);
  });

  it("garbage", async () => {
    const s = settleStub(200, SETTLED);
    expect(
      await shape(await paid(settlingMw(), s, "not-a-payment")),
    ).toMatchSnapshot();
    expect(s.calls).toBe(0);
  });

  it("JSON that is not a payment", async () => {
    const s = settleStub(200, SETTLED);
    const xp = btoa(JSON.stringify({ hello: "world" }));
    expect(await shape(await paid(settlingMw(), s, xp))).toMatchSnapshot();
    expect(s.calls).toBe(0);
  });

  it("unfunded", async () => {
    const s = settleStub(200, UNFUNDED);
    expect(await shape(await paid(settlingMw(), s, pay(1)))).toMatchSnapshot();
    expect(s.calls).toBe(1);
  });

  it("replay", async () => {
    // The same failed payment again: answered from the nonce cache.
    const s = settleStub(200, UNFUNDED);
    const mw = settlingMw();
    await paid(mw, s, pay(1));
    expect(await shape(await paid(mw, s, pay(1)))).toMatchSnapshot();
    expect(s.calls).toBe(1);
  });

  // Valid 55 s from now: inside the 60 s local skew, so it reaches the
  // facilitator, which says not yet.
  const early = () => pay(1, { validAfter: String(T0 + 55) });
  const NOT_YET = { ok: true, data: { settled: false, reason: VALID_AFTER } };

  it("early", async () => {
    const s = settleStub(200, NOT_YET);
    expect(await shape(await paid(settlingMw(), s, early()))).toMatchSnapshot();
    expect(s.calls).toBe(1);
  });

  it("held", async () => {
    // The same early payment again before its validAfter: answered locally.
    const s = settleStub(200, NOT_YET);
    const mw = settlingMw();
    await paid(mw, s, early());
    expect(await shape(await paid(mw, s, early()))).toMatchSnapshot();
    expect(s.calls).toBe(1);
  });

  it("cooldown", async () => {
    // Three fresh failures from one payer; the fourth payment is refused
    // without a settle call.
    const s = settleStub(200, UNFUNDED);
    const mw = settlingMw();
    for (const n of [1, 2, 3]) await paid(mw, s, pay(n));
    expect(await shape(await paid(mw, s, pay(4)))).toMatchSnapshot();
    expect(s.calls).toBe(3);
  });

  it("throttled", async () => {
    // Drain the per-isolate settle bucket with operator faults (never counted
    // against the payer), then one more payment on the same frozen clock.
    const s = settleStub(503, { ok: false, error: "down" });
    const mw = settlingMw();
    for (let n = 1; n <= SETTLE_BUCKET_CAP; n++) await paid(mw, s, pay(n));
    s.status = 200;
    s.body = SETTLED;
    expect(
      await shape(await paid(mw, s, pay(SETTLE_BUCKET_CAP + 1))),
    ).toMatchSnapshot();
    expect(s.calls).toBe(SETTLE_BUCKET_CAP);
  });

  it("unreachable", async () => {
    const s = settleStub(200, SETTLED);
    s.throws = true;
    expect(await shape(await paid(settlingMw(), s, pay(1)))).toMatchSnapshot();
    expect(s.calls).toBe(1);
  });

  // One settle answer, one fresh payment, one response.
  const answers: [string, number, unknown][] = [
    ["500", 500, { ok: false, error: "down" }],
    ["no tx id", 200, { ok: true, data: { settled: true, payer: "0xabc" } }],
    ["unconfirmed", 500, { ok: true, data: { settled: true, tx: TX } }],
    ["400", 400, { ok: false, error: "bad" }],
    ["404", 404, { ok: false, error: "not found" }],
    ["2xx HTML", 200, "<html>ok</html>"],
    ["retryable", 200, { ok: true, data: { settled: false, retryable: true } }],
    ["success", 200, SETTLED],
  ];
  for (const [name, status, body] of answers)
    it(name, async () => {
      const s = settleStub(status, body);
      expect(
        await shape(await paid(settlingMw(), s, pay(1))),
      ).toMatchSnapshot();
      expect(s.calls).toBe(1);
    });

  it("replay after success", async () => {
    const s = settleStub(200, SETTLED);
    const mw = settlingMw();
    expect((await paid(mw, s, pay(1))).status).toBe(200);
    expect(await shape(await paid(mw, s, pay(1)))).toMatchSnapshot();
    expect(s.calls).toBe(1);
  });

  // Refused by the local check: none of these reaches the settle endpoint.
  const local: [string, Parameters<typeof pay>[1]][] = [
    ["expired", { validBefore: String(T0 - 1) }],
    ["amount too low", { value: "999" }],
    // 120 s ahead: past the 60 s local skew.
    ["too early", { validAfter: String(T0 + 120) }],
  ];
  for (const [name, over] of local)
    it(name, async () => {
      const s = settleStub(200, SETTLED);
      expect(
        await shape(await paid(settlingMw(), s, pay(1, over))),
      ).toMatchSnapshot();
      expect(s.calls).toBe(0);
    });

  it("no token", async () => {
    const s = settleStub(200, SETTLED);
    const r = await settlingMw()(
      ctx("/research", agent({ "x-payment": pay(1) }), { DATA_API: s }),
    );
    expect(await shape(r)).toMatchSnapshot();
    expect(s.calls).toBe(0);
  });

  it("three concurrent failures", async () => {
    // All three pass the cooldown check before any settle answers.
    const s = settleStub(200, UNFUNDED);
    const mw = settlingMw();
    // Warm the isolate state first: a cold burst builds one state per request.
    await mw(ctx("/research", agent(), envOf(s)));
    const rs = await Promise.all([1, 2, 3].map((n) => paid(mw, s, pay(n))));
    expect(await Promise.all(rs.map(shape))).toMatchSnapshot();
    expect(s.calls).toBe(3);
  });

  it("fourth concurrent payment (A1)", async () => {
    // Spec 006 row A1: three settles from one payer are still in flight, so
    // the fourth payment is refused without a settle call. Same bytes as
    // "cooldown".
    const s = settleStub(200, SETTLED);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Count the call on arrival, hold the answer until released.
    const answer = s.fetch;
    s.fetch = async (req) => {
      const r = await answer(req);
      if (req.url === SETTLE_URL) await gate;
      return r;
    };
    const mw = settlingMw();
    // Warm the isolate state first: a cold burst builds one state per request.
    await mw(ctx("/research", agent(), envOf(s)));
    const three = [1, 2, 3].map((n) => paid(mw, s, pay(n)));
    await vi.waitFor(() => expect(s.calls).toBe(3));
    expect(await shape(await paid(mw, s, pay(4)))).toMatchSnapshot();
    expect(s.calls).toBe(3);
    release();
    for (const r of await Promise.all(three)) expect(r.status).toBe(200);
  });

  it("mazed agent (302)", async () => {
    // Only a verified (Web Bot Auth) agent is mazed. Fixed Ed25519 key, so
    // the agent key and the signature are the same bytes every run.
    const secretKey = new Uint8Array(32).fill(7);
    const jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: toBase64Url(await publicKeyOf(secretKey)),
    } as const;
    const bot: TestAgent = {
      secretKey,
      jwk,
      keyid: await ed25519Thumbprint(jwk),
    };
    // The middleware fetches the agent's key directory itself. Answer it
    // from a stub, and present as the Workers runtime, where the Node-only
    // resolve-then-connect DNS check does not run (there is no network here).
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ keys: [jwk] })),
    );
    const wba = await signedRequest(bot, {
      authority: "site.example",
      expires: T0 + 300,
    });
    const headers = agent({
      signature: wba.signature,
      "signature-input": wba.signatureInput,
      "signature-agent": wba.signatureAgent,
    });
    const s = settleStub(200, SETTLED);
    const mw = settlingMw({ corpus: { seed: "golden", pages: 8 } });
    // offer_grace = 3: three offers ignored, the fourth request is mazed.
    for (let i = 0; i < 3; i++)
      expect((await mw(ctx("/research", headers, envOf(s)))).status).toBe(402);
    const r = await mw(ctx("/research", headers, envOf(s)));
    expect(r.status).toBe(302);
    expect(await shape(r)).toMatchSnapshot();
    expect(s.calls).toBe(0);
  });

  it("human pass (200)", async () => {
    const s = settleStub(200, SETTLED);
    const r = await settlingMw()(ctx("/research", human(), envOf(s)));
    expect(r.status).toBe(200);
    expect(await shape(r)).toMatchSnapshot();
    expect(s.calls).toBe(0);
  });
});
