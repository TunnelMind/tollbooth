// Spec 006 FR-008 (T008): the money-safety, budget and bounds suite.
//
// Budget: how many settle calls one payer can cause (SC-003, head column),
// through `createPagesMiddleware` with a recording facilitator stub and a
// mocked clock. Money safety (US5) is checked after EVERY test in this file,
// over every settle call and every response the test produced. Bounds: the
// per-isolate maps stay capped and release what they reserve.
//
// The SC-003 numbers are the contract. If one differs, the assertion stays
// and the difference goes to GATE F; do not loosen it here.

import { buildOffer } from "@tunnelmindai/fareseal-adapter-x402";
import { parseConfig } from "@tunnelmindai/fareseal-core";
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
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
  type TestAgent,
} from "../../core/test/fixtures/wba.js";
import { createPagesMiddleware, makeSettlingVerify } from "../src/index.js";
import { agent, ctx, toml } from "./helpers.js";

const SETTLE_URL = "https://collector.example/v1/settle";
const T0 = 1_800_000_000; // epoch seconds; also the WBA fixtures' NOW
const VALID_AFTER = "invalid_exact_evm_payload_authorization_valid_after";
const VALID_TX = /^0x[0-9a-fA-F]{64}$/;
const SLOW = 30_000; // hundreds of secp256k1 signatures: slow on a loaded host

let ms = T0 * 1000;
const at = (s: number) => {
  ms = (T0 + s) * 1000;
};
const nowS = () => Math.floor(ms / 1000);
const randomNonce = () =>
  `0x${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`;

// The three payment makers below are copies of pages-settle.test.ts's
// (this task may not touch that file).

/** From the fixtures' one payer, valid now, fresh nonce unless given. */
function freshPayment(nonce = randomNonce()): string {
  const auth = makeAuth({
    value: "1000", // 0.001 USDC, the configured price
    validAfter: "0",
    validBefore: String(nowS() + 300),
    nonce,
  });
  return payment(auth, signAuth(auth));
}

/** From the one payer, valid `ahead` seconds from now (local skew is 60 s). */
function earlyPayment(ahead = 55): string {
  const auth = makeAuth({
    value: "1000",
    validAfter: String(nowS() + ahead),
    validBefore: String(nowS() + 300),
    nonce: randomNonce(),
  });
  return payment(auth, signAuth(auth));
}

/** Same payment and signature, nonce field rewritten to `nonce`. */
function respell(xp: string, nonce: string): string {
  const p = JSON.parse(atob(xp));
  p.payload.authorization.nonce = nonce;
  return btoa(JSON.stringify(p));
}

/** The EIP-3009 identity of an X-PAYMENT: payer + nonce as a number, so a
 * respelled nonce is the same payment (as on chain). */
function keyOf(xp: string): string {
  const { from, nonce } = JSON.parse(atob(xp)).payload.authorization as {
    from: string;
    nonce: string;
  };
  return `${from.toLowerCase()}:${BigInt(`0x${nonce.slice(2) || "0"}`).toString(16)}`;
}

/**
 * The recording facilitator stub, on the mocked clock. Answers valid_after
 * while a payment is early; then `settled:true` with the tx id in `funded`
 * for that payment (given as any spelling of it), else insufficient_funds.
 * It would settle a funded payment again on every call: a second call for a
 * settled nonce is the double charge `moneySafe` looks for.
 * `slow` = every answer waits at the stub until `release(n)` lets the oldest
 * `n` go; never released = a settle that never answers.
 */
function makeWorld() {
  const w = {
    calls: 0,
    slow: false,
    waiting: [] as (() => void)[],
    release: (n: number) => {
      for (const go of w.waiting.splice(0, n)) go();
    },
    /** Requests sent with a payment (answered or not). */
    sent: 0,
    funded: new Map<string, string>(),
    fund: (xp: string, tx = `0x${"ab".repeat(32)}`) =>
      w.funded.set(keyOf(xp), tx),
    /** Every settle call, in order, with the answer it got. */
    settles: [] as { key: string; atMs: number; settledTx: string | null }[],
    /** Every answered request that carried a payment. */
    responses: [] as { key: string; status: number; receipt: string | null }[],
    fetch: async (req: Request): Promise<Response> => {
      if (req.url !== SETTLE_URL) return new Response("{}", { status: 200 });
      w.calls += 1;
      const xp = ((await req.json()) as { payment: string }).payment;
      const key = keyOf(xp);
      const call = { key, atMs: Date.now(), settledTx: null as string | null };
      w.settles.push(call);
      if (w.slow) await new Promise<void>((go) => w.waiting.push(go));
      const { validAfter } = JSON.parse(atob(xp)).payload.authorization;
      const tx = w.funded.get(key);
      if (Number(validAfter) <= Date.now() / 1000 && tx !== undefined)
        call.settledTx = tx;
      const data =
        Number(validAfter) > Date.now() / 1000
          ? { settled: false, reason: VALID_AFTER }
          : tx !== undefined
            ? { settled: true, tx }
            : { settled: false, reason: "insufficient_funds" };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    },
    note: (xp: string, r: Response) => {
      w.responses.push({
        key: keyOf(xp),
        status: r.status,
        receipt: r.headers.get("x-payment-response"),
      });
      return r;
    },
  };
  return w;
}
type World = ReturnType<typeof makeWorld>;
/** Every world a test made; `moneySafe` runs over each in afterEach. */
const worlds: World[] = [];
function world(): World {
  const w = makeWorld();
  worlds.push(w);
  return w;
}

/** US5, the acceptance bar, over everything one world saw. */
function moneySafe(w: World): void {
  const settledTx = new Map<string, string>();
  for (const c of w.settles) {
    // No settle call after a settled answer for that nonce.
    expect(settledTx.has(c.key), `settle call after settled: ${c.key}`).toBe(
      false,
    );
    if (c.settledTx !== null) settledTx.set(c.key, c.settledTx);
  }
  const served = w.responses.filter((r) => r.status === 200);
  // No nonce served (so: settled) twice.
  expect(new Set(served.map((r) => r.key)).size).toBe(served.length);
  for (const r of served) {
    // No 200 without a settled:true answer with a valid tx for that payment…
    const tx = settledTx.get(r.key);
    expect(tx, `200 without a settled answer: ${r.key}`).toMatch(VALID_TX);
    // …and every 200 carries the receipt, naming that transaction.
    expect(r.receipt, `200 without x-payment-response: ${r.key}`).not.toBe(
      null,
    );
    expect(JSON.parse(atob(r.receipt ?? ""))).toMatchObject({
      success: true,
      transaction: tx,
    });
  }
}

/** A warmed Pages middleware over a fresh world. */
async function pages() {
  const w = world();
  const mw = createPagesMiddleware({
    config: toml(),
    settle: { url: SETTLE_URL },
    binding: "DATA_API",
  });
  const env = { TOLLBOOTH_SETTLE_TOKEN: "settle-secret", DATA_API: w };
  // Warm the isolate state first (a cold burst is covered by the R004 tests).
  await mw(ctx("/r", agent(), env));
  const send = async (xp: string) => {
    w.sent += 1;
    return w.note(xp, await mw(ctx("/r", agent({ "x-payment": xp }), env)));
  };
  const burst = (xps: string[]) => Promise.all(xps.map(send));
  /** Every request sent so far is answered or waiting at the slow stub. */
  const idle = () =>
    vi.waitFor(
      () => expect(w.responses.length + w.waiting.length).toBe(w.sent),
      { interval: 1, timeout: 10_000 },
    );
  /**
   * `steps` bursts of `n` fresh unfunded payments, `everyS` apart, against a
   * settle that takes 3 steps to answer: the answers to one burst land just
   * before the burst 3 steps later. That overlap is the second review's
   * scenario: on main three bursts are in flight before the first failure
   * is counted (9 and 60 calls).
   */
  const slowBursts = async (n: number, everyS: number, steps: number) => {
    w.slow = true;
    const callsAfter: number[] = [];
    let released = 0;
    const all: Promise<Response[]>[] = [];
    for (let i = 0; i < steps; i++) {
      at(i * everyS);
      const due = callsAfter[i - 3] ?? 0;
      w.release(due - released);
      released = due;
      await idle();
      all.push(burst(many(n, () => freshPayment())));
      await idle();
      callsAfter.push(w.calls);
    }
    w.release(w.waiting.length);
    return (await Promise.all(all)).flat();
  };
  return { w, send, burst, idle, slowBursts };
}

const many = <T>(n: number, make: () => T): T[] =>
  Array.from({ length: n }, make);
const errorOf = async (r: Response) =>
  ((await r.json()) as { error?: string }).error;

beforeEach(() => {
  ms = T0 * 1000;
  vi.spyOn(Date, "now").mockImplementation(() => ms);
});
afterEach(() => {
  try {
    expect(worlds.length).toBeGreaterThan(0);
    for (const w of worlds) moneySafe(w);
  } finally {
    worlds.length = 0;
    vi.restoreAllMocks();
  }
});

describe("SC-003: settle calls one payer can cause (fresh unfunded nonces)", () => {
  it("100 sequential → 3", async () => {
    const { w, send } = await pages();
    for (let i = 0; i < 100; i++)
      expect((await send(freshPayment())).status).toBe(402);
    expect(w.calls).toBe(3);
  });

  it(
    "100 concurrent, one burst → 3 (main 20)",
    async () => {
      const { w, burst } = await pages();
      const rs = await burst(many(100, freshPayment));
      expect(rs.every((r) => r.status === 402)).toBe(true);
      expect(w.calls).toBe(3);
    },
    SLOW,
  );

  it("3 concurrent per second, 20 s → 3 (main 9)", async () => {
    const { w, slowBursts } = await pages();
    const rs = await slowBursts(3, 1, 20);
    expect(rs.length).toBe(60);
    expect(rs.every((r) => r.status === 402)).toBe(true);
    expect(w.calls).toBe(3);
  });

  it(
    "20 concurrent every 4 s, 60 s → 3 (main 60)",
    async () => {
      const { w, slowBursts } = await pages();
      const rs = await slowBursts(20, 4, 15);
      expect(rs.length).toBe(300);
      expect(rs.every((r) => r.status === 402)).toBe(true);
      expect(w.calls).toBe(3);
    },
    SLOW,
  );

  it(
    "10 per second, settle never answers, 30 s → 3 (main 169)",
    async () => {
      const { w, send, idle } = await pages();
      w.slow = true; // and never released
      for (let i = 0; i < 300; i++, ms += 100) {
        // Not awaited: the three that reach settle never get an answer.
        void send(freshPayment());
        await idle();
      }
      expect(w.calls).toBe(3);
      expect(w.responses.length).toBe(297);
      expect(w.responses.every((r) => r.status === 402)).toBe(true);
    },
    SLOW,
  );

  // Not one payer: a new key per payment, so only the settle bucket (20, +5/s)
  // stands in the way. "30 per second" is 30 at once each second, the reading
  // that gives main's 115 = 20 + 19 x 5.
  it(
    "many payers, 30 per second, 20 s → <= 115 (main 115)",
    async () => {
      const { w, burst } = await pages();
      for (let s = 0; s < 20; s++) {
        at(s);
        await burst(
          many(30, () =>
            freshKeyPayment({
              validBefore: String(nowS() + 300),
              nonce: randomNonce(),
            }),
          ),
        );
      }
      expect(w.calls).toBeLessThanOrEqual(115);
      expect(w.calls).toBeGreaterThan(0);
      // One payment per payer: no payer got a second call.
      expect(new Set(w.settles.map((c) => c.key)).size).toBe(w.calls);
    },
    SLOW,
  );

  // The one stated exception (OQ1): each early nonce may cost 2 calls, the
  // first attempt and the due attempt (R-O4), so a payer streaming early
  // nonces gets 3 + 3. Unfunded throughout: a payer whose payments settle
  // clears its own count, as on main.
  it(
    "OQ1: a stream of early nonces whose holds come due → <= 6 per payer in any 600 s",
    async () => {
      const { w, send } = await pages();
      const recent: string[] = [];
      // A new early nonce every 5 s for 1300 s (two cooldowns and more); each
      // one is repeated every 5 s for 70 s, so past its validAfter (55 s).
      for (let s = 0; s <= 1300; s += 5) {
        at(s);
        for (const xp of recent) await send(xp);
        const xp = earlyPayment();
        recent.push(xp);
        if (recent.length > 14) recent.shift();
        await send(xp);
      }
      const times = w.settles.map((c) => c.atMs);
      // Every 600 s window with the most calls starts at a call.
      for (const t of times)
        expect(
          times.filter((u) => u >= t && u < t + 600_000).length,
        ).toBeLessThanOrEqual(6);
      // The due attempts did happen: more than first attempts alone.
      expect(times.filter((u) => u < (T0 + 600) * 1000).length).toBeGreaterThan(
        3,
      );
      // At most 2 calls for any one nonce.
      for (const c of w.settles)
        expect(
          w.settles.filter((d) => d.key === c.key).length,
        ).toBeLessThanOrEqual(2);
    },
    SLOW,
  );
});

describe("US5: money safety with funded payments", () => {
  it("20 concurrent copies of one funded payment, nonce respelled → 1 settle call, served once", async () => {
    const { w, send, burst } = await pages();
    // Leading zero byte + letters, so the nonce has other spellings that
    // sign the same bytes32.
    const hex = `00ab${crypto.randomUUID().replaceAll("-", "")}`.padEnd(
      64,
      "c",
    );
    const xp = freshPayment(`0x${hex}`);
    w.fund(xp);
    const spellings = [
      xp,
      respell(xp, `0x${hex.toUpperCase()}`),
      respell(xp, `0x${hex.slice(2)}`),
    ];
    const rs = await burst(
      many(20, () => "").map((_, i) => spellings[i % 3] ?? xp),
    );
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 402).length).toBe(19);
    expect(w.calls).toBe(1);
    // Replays later, any spelling: refused from cache, no call.
    for (const s of spellings) expect((await send(s)).status).toBe(402);
    expect(w.calls).toBe(1);
  });

  it("a due hold sent as 20 concurrent copies → 1 more settle call, served once", async () => {
    const { w, send, burst } = await pages();
    const xp = earlyPayment();
    w.fund(xp);
    expect((await send(xp)).status).toBe(402); // early: held
    at(54);
    expect((await send(xp)).status).toBe(402); // still held, no call
    expect(w.calls).toBe(1);
    at(55);
    const rs = await burst(many(20, () => xp));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 402).length).toBe(19);
    expect(w.calls).toBe(2);
    expect((await send(xp)).status).toBe(402);
    expect(w.calls).toBe(2);
  });

  it("3 early payments at once from a funded payer, each repeated when due → 3 served, 2 calls per nonce", async () => {
    const { w, burst } = await pages();
    const xps = many(3, earlyPayment);
    for (const xp of xps) w.fund(xp);
    expect((await burst(xps)).map((r) => r.status)).toEqual([402, 402, 402]);
    at(55);
    expect((await burst(xps)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(w.calls).toBe(6);
  });

  it("settled:true without a valid tx id is never a 200, and is not settled again", async () => {
    const { w, send, burst } = await pages();
    const xp = freshPayment();
    w.fund(xp, "0xTX");
    const rs = await burst(many(5, () => xp));
    expect(rs.map((r) => r.status)).toEqual([402, 402, 402, 402, 402]);
    expect((await send(xp)).status).toBe(402);
    expect(w.calls).toBe(1);
    // moneySafe (afterEach) would also fail on a second call for this nonce.
  });

  it("funded and unfunded payments mixed in one burst: only the funded are served", async () => {
    const { w, burst } = await pages();
    // 2 funded + 1 unfunded reach settle (3 in flight is the payer's limit).
    const xps = many(3, freshPayment);
    w.fund(xps[0] ?? "");
    w.fund(xps[2] ?? "");
    const rs = await burst(xps);
    expect(rs.map((r) => r.status)).toEqual([200, 402, 200]);
    expect(await errorOf(rs[1] as Response)).toBeTypeOf("string");
    expect(w.calls).toBe(3);
  });
});

describe("US3: held repeats per verified agent key are capped (maze on)", () => {
  let bot: TestAgent;
  beforeAll(async () => {
    bot = await makeAgent();
  });

  /** The hono pipeline (offer_grace 3, maze on) over a settling verify on a
   * fresh world, as pages-settle.test.ts's `mazeApp`: the Pages middleware
   * has no hook for the test agent's key directory. */
  async function mazeApp() {
    const w = world();
    const cfg = parseConfig(toml());
    const a = new Hono();
    a.use(
      fareseal({
        config: cfg,
        x402: {
          buildOffer,
          verifyProof: makeSettlingVerify(
            (url, init) => w.fetch(new Request(url, init)),
            SETTLE_URL,
            "settle-secret",
          ),
          settles: true,
        },
        maze: makeMazeHandler({
          corpus: corpusFromMap(generateCorpus({ seed: "t008", pages: 10 })),
          cfg,
          sleep: async () => {},
        }),
        fetchDirectory: dirWith(bot.jwk),
        nowS: () => Math.floor(Date.now() / 1000),
      }),
    );
    a.get("*", (c) => c.text("content"));
    const wba = await signedRequest(bot, { expires: T0 + 300 });
    const send = async (xp: string) =>
      w.note(
        xp,
        await a.request("http://example.com/article", {
          headers: {
            ...agent(),
            signature: wba.signature,
            "signature-input": wba.signatureInput,
            "signature-agent": wba.signatureAgent,
            "x-payment": xp,
          },
        }),
      );
    return { w, send };
  }

  it("a verified agent at 10 req/s on one held payment → 302 by request 64", async () => {
    const { w, send } = await mazeApp();
    const xp = earlyPayment();
    const statuses: number[] = [];
    // 10 s of it; the hold itself lasts 55 s.
    for (let i = 0; i < 100; i++, ms += 100)
      statuses.push((await send(xp)).status);
    const firstMazed = statuses.indexOf(302) + 1; // 1-based request number
    expect(firstMazed).toBeGreaterThan(0);
    expect(firstMazed).toBeLessThanOrEqual(64); // 1 + 60 free + 3 grace
    // Offers until then, the maze from then on; never served.
    expect(new Set(statuses.slice(0, firstMazed - 1))).toEqual(new Set([402]));
    expect(new Set(statuses.slice(firstMazed - 1))).toEqual(new Set([302]));
    expect(w.calls).toBe(1);
  });

  it("an honest agent polling 1/s for 60 s on one held payment is never mazed, then served", async () => {
    const { w, send } = await mazeApp();
    // The longest hold there is: validAfter the full skew tolerance ahead.
    const xp = earlyPayment(60);
    w.fund(xp);
    const statuses: number[] = [];
    for (let s = 0; s <= 60; s++) {
      at(s);
      statuses.push((await send(xp)).status);
    }
    expect(statuses).not.toContain(302);
    expect(statuses).toEqual([...Array(60).fill(402), 200]);
    expect(w.calls).toBe(2); // the first attempt and the due attempt
  });
});

describe("bounds: the per-isolate maps stay capped", () => {
  // On makeSettlingVerify itself: the middleware does not expose `_sizes()`.
  it(
    "1400 one-payment payers → seen 512, payerFails 512, notYetValid <= 512, nothing in flight; the same a year later",
    async () => {
      const w = world();
      const verify = makeSettlingVerify(
        (url, init) => w.fetch(new Request(url, init)),
        SETTLE_URL,
        "settle-secret",
      );
      const cfg = parseConfig(toml());
      // The fixtures sign one payment per fresh key, so FR-008's 1400
      // payments come from 1400 payers, not 700 x 2: a payer here never has
      // two settles in flight (that release path is pinned in
      // pages-settle.test.ts, "per-payer in-flight settles are reserved").
      /** Two new payers at once: one sends an early payment (held, counted),
       * the other an unfunded one (cached, counted). */
      const pair = async () => {
        const pay = (validAfter: string) =>
          freshKeyPayment({
            validAfter,
            validBefore: String(nowS() + 300),
            nonce: randomNonce(),
          });
        const xps = [pay(String(nowS() + 55)), pay("0")];
        return Promise.all(xps.map((xp) => verify(xp, cfg)));
      };
      for (let i = 0; i < 700; i++) {
        ms += 1000; // the settle bucket refills 5: never throttled
        const rs = await pair();
        expect(rs.map((r) => r.reason)).toEqual([
          "not-yet-valid",
          "insufficient_funds",
        ]);
      }
      // 1400 payments, every one reached settle.
      expect(w.calls).toBe(1400);
      const capped = verify._sizes();
      expect(capped.seen).toBe(512);
      expect(capped.payerFails).toBe(512);
      expect(capped.notYetValid).toBeLessThanOrEqual(512);
      expect(capped.inflight).toBe(0);
      expect(capped.payerInflight).toBe(0);

      ms += 365 * 86_400_000;
      expect(verify._sizes()).toEqual(capped);
      // And still capped once traffic resumes.
      await pair();
      expect(verify._sizes()).toEqual(capped);
    },
    SLOW,
  );
});
