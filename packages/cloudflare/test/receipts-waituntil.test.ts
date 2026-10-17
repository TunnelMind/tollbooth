// B006: receipts survive the response on Workers. The reporter has no sleep
// loop here (autoFlush: false); each request signs, queues and POSTs inside
// the runtime's waitUntil. With no waitUntil the receipt cannot survive the
// isolate, so it is counted in receipts_dropped instead of vanishing.
import { generateSecretKey, toBase64Url } from "@tollbooth/core";
import { describe, expect, it } from "vitest";
import {
  makeAuth,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import { createPagesMiddleware } from "../src/index.js";
import { agent, ctx, toml } from "./helpers.js";

const SETTLE_URL = "https://collector.example/v1/settle";
const RECEIPTS_URL = "https://collector.example/v1/receipts";

function fakeFetch() {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url === SETTLE_URL)
      return new Response(
        JSON.stringify({ ok: true, data: { settled: true, payer: "0xabc" } }),
      );
    return new Response("{}");
  };
  return { calls, fetch };
}

function freshPayment(): string {
  const nowS = Math.floor(Date.now() / 1000);
  const auth = makeAuth({
    value: "1000", // toml()'s default price, 0.001 USD
    validAfter: "0",
    validBefore: String(nowS + 300),
    nonce: `0x${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")}`,
  });
  return payment(auth, signAuth(auth));
}

// A paid pass emits PASS_PAID (an unsigned agent's offer emits nothing).
const env = () => ({
  TOLLBOOTH_SITE_KEY: toBase64Url(generateSecretKey()),
  TOLLBOOTH_SETTLE_TOKEN: "settle-secret",
});

async function report(mw: ReturnType<typeof createPagesMiddleware>, e: object) {
  const r = await mw(
    ctx("/_tollbooth/report", { authorization: "Bearer rt" }, { ...e }),
  );
  return (await r.json()) as {
    receipts_queued: number;
    receipts_dropped: number;
  };
}

describe("receipts on Workers ride waitUntil", () => {
  it("the receipt is POSTed only through the collected promises", async () => {
    const f = fakeFetch();
    const mw = createPagesMiddleware({
      config: toml("rt"),
      settle: { url: SETTLE_URL },
      fetch: f.fetch,
    });
    const e = env();
    const pending: Promise<unknown>[] = [];
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), e, (p) =>
        pending.push(p),
      ),
    );
    expect(r.status).toBe(200);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(f.calls).not.toContain(RECEIPTS_URL); // nothing posted yet
    await Promise.all(pending);
    expect(f.calls).toContain(RECEIPTS_URL);
    const rep = await report(mw, e);
    expect(rep.receipts_queued).toBe(0);
    expect(rep.receipts_dropped).toBe(0);
  });

  it("with no waitUntil the receipt is counted as dropped", async () => {
    const f = fakeFetch();
    const mw = createPagesMiddleware({
      config: toml("rt"),
      settle: { url: SETTLE_URL },
      fetch: f.fetch,
    });
    const e = env();
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), e),
    );
    expect(r.status).toBe(200); // the request itself is unaffected
    const rep = await report(mw, e);
    expect(rep.receipts_dropped).toBe(1);
    expect(rep.receipts_queued).toBe(0);
    expect(f.calls).not.toContain(RECEIPTS_URL);
  });
});
