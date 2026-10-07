// Spec 088 (TunnelMind estate hardening S2): the middleware never falls back to
// the global fetch. A named-but-absent binding throws a named error before any
// request is issued; outbound reporting with no route at all throws too; an
// explicit `fetch` option works; every outbound write carries x-tollbooth-env,
// which reads `test` under vitest and `production` when nothing says otherwise.
import { generateSecretKey, toBase64Url } from "@tollbooth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeAuth,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import {
  createPagesMiddleware,
  ENV_HEADER,
  TollboothBindingMissingError,
  testRunnerDetected,
  tollboothEnvMarker,
} from "../src/index.js";
import { agent, ctx, human, toml } from "./helpers.js";

const seedEnv = () => ({
  TOLLBOOTH_SITE_KEY: toBase64Url(generateSecretKey()),
});

describe("no global-fetch fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a named binding absent from env throws the named error before any request", async () => {
    const globalCalls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      globalCalls.push(String(u));
      return new Response("{}");
    });
    const mw = createPagesMiddleware({
      config: toml("report-token"),
      snapshots: { url: "https://collector.example/v1/report", intervalMs: 0 },
      binding: "DATA_API",
    });
    await expect(
      mw(ctx("/research", agent(), { ...seedEnv(), OTHER: 1 })),
    ).rejects.toBeInstanceOf(TollboothBindingMissingError);
    const err = await mw(ctx("/research", agent(), { ...seedEnv() })).catch(
      (e) => e,
    );
    expect(err.name).toBe("TollboothBindingMissingError");
    expect(err.binding).toBe("DATA_API");
    expect(err.message).toContain('binding "DATA_API" is not present');
    expect(globalCalls).toEqual([]); // zero network calls
  });

  it("a mis-shaped binding (no fetch function) is treated as missing", async () => {
    const mw = createPagesMiddleware({
      config: toml("t"),
      binding: "DATA_API",
    });
    await expect(
      mw(ctx("/x", human(), { DATA_API: { notFetch: true } })),
    ).rejects.toBeInstanceOf(TollboothBindingMissingError);
  });

  it("outbound reporting configured with neither binding nor fetch throws, naming the fix", async () => {
    const mw = createPagesMiddleware({
      config: toml("report-token"),
      snapshots: { url: "https://collector.example/v1/report" },
    });
    const err = await mw(ctx("/x", human(), seedEnv())).catch((e) => e);
    expect(err).toBeInstanceOf(TollboothBindingMissingError);
    expect(err.binding).toBeNull();
    expect(err.message).toContain("no implicit global fetch");
  });

  it("nothing outbound configured needs no route — humans and agents still get served", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    expect((await mw(ctx("/research", human(), {}))).status).toBe(200);
    expect((await mw(ctx("/research", agent(), {}))).status).toBe(402);
  });

  it("an explicit fetch option carries the snapshot with the environment marker", async () => {
    const posts: { url: string; env: string | null }[] = [];
    const recorder = async (url: string, init?: RequestInit) => {
      posts.push({ url, env: new Headers(init?.headers).get(ENV_HEADER) });
      return new Response("{}", { status: 200 });
    };
    const flushed: Promise<unknown>[] = [];
    const mw = createPagesMiddleware({
      config: toml("report-token-3"),
      snapshots: { url: "https://collector.example/v1/report", intervalMs: 0 },
      fetch: recorder,
    });
    await mw(ctx("/research", agent(), seedEnv(), (p) => flushed.push(p)));
    await Promise.all(flushed);
    const snap = posts.find(
      (p) => p.url === "https://collector.example/v1/report",
    );
    expect(snap?.env).toBe("test"); // vitest is detectable → test, refused by the collector
  });

  it("a binding fetch also carries the marker, and TOLLBOOTH_ENV overrides it verbatim", async () => {
    const seen: (string | null)[] = [];
    const binding = {
      fetch: async (req: Request) => {
        seen.push(req.headers.get(ENV_HEADER));
        return new Response("{}", { status: 200 });
      },
    };
    const flushed: Promise<unknown>[] = [];
    const mw = createPagesMiddleware({
      config: toml("report-token-4"),
      snapshots: { url: "https://collector.example/v1/report", intervalMs: 0 },
      binding: "DATA_API",
    });
    await mw(
      ctx(
        "/a",
        agent(),
        { ...seedEnv(), DATA_API: binding, TOLLBOOTH_ENV: "staging" },
        (p) => flushed.push(p),
      ),
    );
    await Promise.all(flushed);
    expect(seen).toContain("staging");
  });

  it("the marker is production when no test runner is detectable and TOLLBOOTH_ENV is unset", () => {
    expect(testRunnerDetected()).toBe(true); // we are under vitest
    const g = globalThis as Record<string, unknown>;
    const savedProcess = g.process;
    const savedWorker = g.__vitest_worker__;
    try {
      g.process = undefined; // what the Pages runtime looks like
      g.__vitest_worker__ = undefined;
      expect(testRunnerDetected()).toBe(false);
      expect(tollboothEnvMarker({})).toBe("production");
      expect(tollboothEnvMarker({ TOLLBOOTH_ENV: "production" })).toBe(
        "production",
      );
    } finally {
      g.process = savedProcess;
      g.__vitest_worker__ = savedWorker;
    }
    expect(tollboothEnvMarker({})).toBe("test");
  });

  it("the authed report exposes the marker as a diagnostic header", async () => {
    const mw = createPagesMiddleware({ config: toml("report-token-5") });
    const r = await mw(
      ctx("/_tollbooth/report", { authorization: "Bearer report-token-5" }, {}),
    );
    expect(r.headers.get("x-tollbooth-env")).toBe("test");
  });
});

// Spec 107: in workerd a service binding's fetch is a host method that throws
// `TypeError: Illegal invocation` when called without the binding as `this`.
// A plain arrow-function stub (as above) cannot see that, so this fake checks
// the receiver the way workerd does. The flush and reporter paths catch and
// only log, so each case asserts on the calls that actually reached the
// binding, never on a thrown error.
const SETTLE_URL = "https://collector.example/v1/settle";

function strictBinding() {
  const binding = {
    calls: [] as string[],
    async fetch(this: unknown, req: Request): Promise<Response> {
      if (this !== binding) throw new TypeError("Illegal invocation");
      binding.calls.push(req.url);
      if (req.url === SETTLE_URL)
        return new Response(
          JSON.stringify({ ok: true, data: { settled: true, payer: "0xabc" } }),
          { status: 200 },
        );
      return new Response("{}", { status: 200 });
    },
  };
  return binding;
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

describe("a service binding is called with itself as `this`", () => {
  afterEach(() => vi.useRealTimers());

  it("the snapshot flush reaches the binding", async () => {
    const b = strictBinding();
    const flushed: Promise<unknown>[] = [];
    const mw = createPagesMiddleware({
      config: toml("report-token-6"),
      snapshots: { url: "https://collector.example/v1/report", intervalMs: 0 },
      binding: "DATA_API",
    });
    await mw(
      ctx("/research", agent(), { ...seedEnv(), DATA_API: b }, (p) =>
        flushed.push(p),
      ),
    );
    await Promise.all(flushed);
    expect(b.calls).toContain("https://collector.example/v1/report");
  });

  it("the receipt report reaches the binding", async () => {
    // The reporter batches on a 5 s setTimeout loop; fake only setTimeout so
    // the test advances it instead of waiting, while signing stays real.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const b = strictBinding();
    const mw = createPagesMiddleware({
      config: toml("report-token-7"),
      settle: { url: SETTLE_URL },
      binding: "DATA_API",
    });
    // An unsigned agent's offer emits no receipt; a paid pass emits
    // PASS_PAID, so this rides a settled payment (settle is covered below).
    await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), {
        ...seedEnv(),
        TOLLBOOTH_SETTLE_TOKEN: "settle-secret",
        DATA_API: b,
      }),
    );
    await vi.waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(6000);
        expect(b.calls).toContain("https://collector.example/v1/receipts");
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it("the x402 settle call reaches the binding", async () => {
    const b = strictBinding();
    const mw = createPagesMiddleware({
      config: toml(),
      settle: { url: SETTLE_URL },
      binding: "DATA_API",
    });
    const r = await mw(
      ctx("/research", agent({ "x-payment": freshPayment() }), {
        TOLLBOOTH_SETTLE_TOKEN: "settle-secret",
        DATA_API: b,
      }),
    );
    expect(b.calls).toContain(SETTLE_URL);
    expect(r.status).toBe(200);
  });
});
