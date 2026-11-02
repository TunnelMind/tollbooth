// A002: GET /_tollbooth/arrival shows the requester their own reading. Free,
// never tolled, no bearer, and it moves no counter and emits no receipt.
import {
  ARRIVAL_KEPT_SCOPE,
  agentHeuristics,
  arrivalReading,
  botRanges,
  decide,
  generateSecretKey,
  keptFor,
  LEDGER,
  type PipelineRequest,
  parseConfig,
  publicKeyOf,
  type Receipt,
  ReceiptReporter,
} from "@tollbooth/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  dirWith,
  makeAgent,
  NOW,
  signedRequest,
} from "../../core/test/fixtures/wba.js";
import { type TollboothOptions, tollbooth } from "../src/index.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const URL_ = "http://example.com/_tollbooth/arrival";

// Toll mode with reporting on, so a stray record() or receipt would show.
const CFG = `
mode = "toll"
report = true
report_url = "https://log.test/ingest"
report_token = "sekrit"
[toll.x402]
pay_to = "0x0000000000000000000000000000000000000001"
`;

async function setup() {
  const secret = generateSecretKey();
  const batches: Receipt[][] = [];
  const reporter = new ReceiptReporter({
    url: "https://log.test/ingest",
    autoFlush: false,
    fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      batches.push(
        (JSON.parse(init?.body as string) as { receipts: Receipt[] }).receipts,
      );
      return new Response("", { status: 200 });
    }) as typeof fetch,
  });
  const app = new Hono();
  app.use(
    tollbooth({
      config: CFG,
      siteKeys: { secret, pub: await publicKeyOf(secret) },
      reporter,
      fetchDirectory: dirWith(),
      nowS: () => NOW,
    }),
  );
  app.all("*", (c) => c.text("content"));
  const report = async () =>
    (
      await app.request("http://example.com/_tollbooth/report", {
        headers: { authorization: "Bearer sekrit" },
      })
    ).json();
  return { app, reporter, batches, report };
}

describe("A002 GET /_tollbooth/arrival", () => {
  it("returns the browser's own reading: human, free-path, no bearer", async () => {
    const { app } = await setup();
    const res = await app.request(URL_, {
      headers: { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("*");
    const req: PipelineRequest = {
      path: "/_tollbooth/arrival",
      authority: "example.com",
      method: "GET",
      scheme: "http",
      userAgent: BROWSER_UA,
      accept: BROWSER_ACCEPT,
      hasCookies: false,
    };
    const body = await res.json();
    expect(body).toEqual(
      arrivalReading(req, {
        action: "pass",
        reason: "free-path",
        identity: { kind: "human" },
      }),
    );
    expect(body.identity.kind).toBe("human");
    expect(body.decision).toEqual({ type: "pass", reason: "free-path" });
  });

  it("reads curl as an anonymous agent by heuristics", async () => {
    const { app } = await setup();
    const res = await app.request(URL_, {
      headers: { "user-agent": "curl/8.7.1", accept: "*/*" },
    });
    expect(res.status).toBe(200);
    const req: PipelineRequest = {
      path: "/_tollbooth/arrival",
      authority: "example.com",
      method: "GET",
      scheme: "http",
      userAgent: "curl/8.7.1",
      accept: "*/*",
      hasCookies: false,
    };
    const { matched } = agentHeuristics({
      userAgent: "curl/8.7.1",
      accept: "*/*",
      hasCookies: false,
    });
    const body = await res.json();
    expect(body).toEqual(
      arrivalReading(
        req,
        {
          action: "pass",
          reason: "free-path",
          identity: { kind: "anonymous-agent", via: matched },
        },
        // A005: kept describes an ordinary request with this identity.
        { identity: { kind: "anonymous-agent", via: matched } },
      ),
    );
    const kept = (name: string) =>
      body.rows.find((r: { name: string }) => r.name === name).kept;
    expect(kept("path")).toBe(LEDGER);
    expect(kept("user-agent")).toBe(LEDGER);
    expect(body.identity.kind).toBe("anonymous-agent");
    expect(body.identity.via).toBe("heuristics");
    expect(body.identity.matched.length).toBeGreaterThan(0);
  });

  it("50 calls move no report counter and emit no receipt", async () => {
    const { app, reporter, batches, report } = await setup();
    const before = await report();
    for (let i = 0; i < 50; i++) {
      const ua = i % 2 ? "curl/8.7.1" : BROWSER_UA;
      expect(
        (await app.request(URL_, { headers: { "user-agent": ua } })).status,
      ).toBe(200);
    }
    const after = await report();
    for (const k of [
      "humans_passed",
      "free_path_hits",
      "not_found",
      "agents",
      "receipts_queued",
      "receipts_dropped",
    ])
      expect(after[k]).toEqual(before[k]);
    expect(after.agents).toEqual([]);
    await reporter.flush();
    expect(reporter.queued).toBe(0);
    expect(batches).toEqual([]);
  });

  it("a POST is not the arrival route", async () => {
    const { app } = await setup();
    const res = await app.request(URL_, {
      method: "POST",
      headers: { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT },
    });
    expect(await res.text()).toBe("content");
  });

  it("never echoes the cookie or bearer-like proofs", async () => {
    const { app } = await setup();
    const secrets = {
      cookie: "session=COOKIE-SECRET-123",
      "x-payment": "PAYMENT-SECRET-456",
      "tollbooth-voucher": "VOUCHER-SECRET-789",
      signature: "sig1=:SIGNATURE-SECRET-abc:",
      "signature-input": "sig1=(INPUT-SECRET-def)",
    };
    const res = await app.request(URL_, {
      headers: { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT, ...secrets },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const marker of [
      "COOKIE-SECRET-123",
      "PAYMENT-SECRET-456",
      "VOUCHER-SECRET-789",
      "SIGNATURE-SECRET-abc",
      "INPUT-SECRET-def",
    ])
      expect(text).not.toContain(marker);
    const cookieRow = JSON.parse(text).rows.find(
      (r: { name: string }) => r.name === "cookie",
    );
    expect(cookieRow).toMatchObject({ value: null, read: "presence only" });
  });
});

// A005: `kept` is what record() would keep for an ordinary request like this
// one, from the one classification (core keptFor) both share.
const VERIFIED_CFG = `
mode = "toll"
report_token = "sekrit"
pass_verified = ["search", "preview"]
[toll.x402]
pay_to = "0x0000000000000000000000000000000000000001"
`;
const GOOGLE_V4 = (
  botRanges.google.find((r) => !r.includes(":")) as string
).split("/")[0] as string;
const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SLACKBOT = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";

function verifiedApp(keys: unknown[] = []) {
  const app = new Hono();
  const options: Partial<TollboothOptions> = {
    clientIp: (c) => c.req.header("x-test-ip"),
  };
  app.use(
    tollbooth({
      config: VERIFIED_CFG,
      fetchDirectory: dirWith(...keys),
      nowS: () => NOW,
      ...options,
    }),
  );
  app.get("*", (c) => c.text("content"));
  const agents = async () =>
    (
      (await (
        await app.request("http://example.com/_tollbooth/report", {
          headers: { authorization: "Bearer sekrit" },
        })
      ).json()) as { agents: unknown[] }
    ).agents.length;
  return { app, agents };
}

describe("A005 kept shares record()'s classification", () => {
  it("a verified Googlebot reads counter only on path and user-agent", async () => {
    const { app, agents } = verifiedApp();
    const res = await app.request(URL_, {
      headers: { "user-agent": GOOGLEBOT, "x-test-ip": GOOGLE_V4 },
    });
    const body = await res.json();
    const kept = (name: string) =>
      body.rows.find((r: { name: string }) => r.name === name).kept;
    expect(kept("path")).toBe("counter only");
    expect(kept("user-agent")).toBe("counter only");
    for (const r of body.rows) expect(["no", "counter only"]).toContain(r.kept);
    expect(body.kept_scope).toBe(ARRIVAL_KEPT_SCOPE);
    expect(body.decision).toEqual({ type: "pass", reason: "free-path" });
    expect(await agents()).toBe(0);
  });

  it("record() adds a ledger entry iff keptFor names the ledger", async () => {
    const agent = await makeAgent();
    const wba = await signedRequest(agent);
    const signed = {
      signature: wba.signature,
      "signature-input": wba.signatureInput,
      "signature-agent": wba.signatureAgent,
    };
    const fixtures: {
      name: string;
      path: string;
      headers: Record<string, string>;
      host?: string;
      expected: string;
    }[] = [
      {
        name: "human",
        path: "/page",
        headers: { "user-agent": BROWSER_UA, accept: BROWSER_ACCEPT },
        expected: "no",
      },
      {
        name: "anonymous-agent",
        path: "/page",
        headers: { "user-agent": "curl/8.7.1", accept: "*/*" },
        expected: LEDGER,
      },
      {
        name: "agent",
        path: "/page",
        headers: { "user-agent": "agent/1", ...signed },
        expected: LEDGER,
      },
      {
        name: "spoofer",
        path: "/page",
        host: "evil.example",
        headers: { "user-agent": "agent/1", ...signed },
        expected: LEDGER,
      },
      {
        name: "verified-search",
        path: "/page",
        headers: { "user-agent": GOOGLEBOT, "x-test-ip": GOOGLE_V4 },
        expected: "counter only",
      },
      {
        name: "verified-preview",
        path: "/page",
        headers: { "user-agent": SLACKBOT, accept: "text/html" },
        expected: "counter only",
      },
      {
        name: "free-path",
        path: "/robots.txt",
        headers: { "user-agent": "curl/8.7.1" },
        expected: "no",
      },
    ];
    const cfg = parseConfig(VERIFIED_CFG);
    for (const f of fixtures) {
      const host = f.host ?? "example.com";
      const req: PipelineRequest = {
        path: f.path,
        authority: host,
        method: "GET",
        scheme: "http",
        userAgent: f.headers["user-agent"] as string,
        ...(f.headers.accept !== undefined ? { accept: f.headers.accept } : {}),
        hasCookies: false,
        ...(f.headers.signature !== undefined
          ? {
              signature: f.headers.signature,
              signatureInput: f.headers["signature-input"] as string,
              signatureAgent: f.headers["signature-agent"] as string,
            }
          : {}),
        ...(f.headers["x-test-ip"] !== undefined
          ? { clientIp: f.headers["x-test-ip"] }
          : {}),
      };
      const decision = await decide(req, cfg, {
        fetchDirectory: dirWith(agent.jwk),
        nowS: NOW,
      });
      const kept = keptFor(decision);
      expect(kept, f.name).toBe(f.expected);

      const { app, agents } = verifiedApp([agent.jwk]);
      await app.request(`http://${host}${f.path}`, { headers: f.headers });
      expect(await agents(), f.name).toBe(kept === LEDGER ? 1 : 0);
    }
  });
});
