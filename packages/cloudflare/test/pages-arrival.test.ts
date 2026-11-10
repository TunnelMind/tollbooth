// Spec 123 A003: GET /_tollbooth/arrival through the Pages middleware. The
// route lives in the hono layer (A002) that createPagesMiddleware wraps, so
// cf-connecting-ip is the only edge-supplied input and request.cf is never read.
import { readFileSync } from "node:fs";
import { generateSecretKey, toBase64Url } from "@tunnelmindai/fareseal-core";
import { describe, expect, it } from "vitest";
import { createPagesMiddleware } from "../src/index.js";
import { agent, ctx, human, toml } from "./helpers.js";

type Row = { name: string; value: string | null };
type Body = {
  rows: Row[];
  identity: { kind: string | null };
  never_read: string[];
};

const PATH = "/_tollbooth/arrival";
const ipRow = (b: Body) => b.rows.find((r) => r.name === "client_ip");

describe("GET /_tollbooth/arrival on Pages", () => {
  it("a human gets a 200 no-store JSON reading, and next() is never called", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    let nextCalled = false;
    const c = {
      ...ctx(PATH, human(), {}),
      next: async () => {
        nextCalled = true;
        return new Response("site content");
      },
    };
    const resp = await mw(c);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(resp.headers.get("vary")).toBe("*");
    const text = await resp.text();
    expect(text).not.toBe("site content");
    expect(nextCalled).toBe(false);
    expect((JSON.parse(text) as Body).identity.kind).toBe("human");
  });

  it("an agent's client_ip row carries cf-connecting-ip", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    const resp = await mw(
      ctx(PATH, agent({ "cf-connecting-ip": "203.0.113.7" }), {}),
    );
    const body = (await resp.json()) as Body;
    expect(body.identity.kind).toBe("anonymous-agent");
    expect(ipRow(body)?.value).toBe("203.0.113.7");
  });

  it("without cf-connecting-ip the client_ip row is null", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    const body = (await (await mw(ctx(PATH, agent(), {}))).json()) as Body;
    expect(ipRow(body)).toBeDefined();
    expect(ipRow(body)?.value).toBeNull();
  });

  it("request.cf is never read: country and asn stay out of the reading", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    const c = ctx(PATH, agent(), {});
    Object.defineProperty(c.request, "cf", {
      value: { country: "US", asn: 64500 },
    });
    const body = (await (await mw(c)).json()) as Body;
    expect(body.never_read).toEqual(
      expect.arrayContaining(["country", "asn", "request.cf"]),
    );
    expect(JSON.stringify(body)).not.toContain("64500");
    expect(body.rows.some((r) => r.value === "US")).toBe(false);
  });

  it("is never tolled: an agent past offer_grace still gets 200", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    for (let i = 0; i < 5; i++) {
      const resp = await mw(
        ctx(PATH, agent({ "cf-connecting-ip": "203.0.113.7" }), {}),
      );
      expect(resp.status).toBe(200);
    }
  });

  it("A008: an agent's HEAD is answered here, not tolled, next() never called", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    let nextCalled = false;
    const c = {
      ...ctx(PATH, agent(), {}),
      next: async () => {
        nextCalled = true;
        return new Response("site content");
      },
    };
    c.request = new Request(c.request, { method: "HEAD" });
    // Past offer_grace: a HEAD that fell through to the pipeline would 402.
    for (let i = 0; i < 5; i++) {
      const resp = await mw(c);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("cache-control")).toBe("no-store");
      expect(resp.headers.get("vary")).toBe("*");
      expect(await resp.text()).toBe("");
    }
    expect(nextCalled).toBe(false);
  });

  it("carries none of the report-path x-tollbooth-* headers", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    const resp = await mw(ctx(PATH, agent(), {}));
    for (const h of [
      "x-tollbooth-mode",
      "x-tollbooth-reporting",
      "x-tollbooth-settling",
      "x-tollbooth-env",
    ])
      expect(resp.headers.get(h)).toBeNull();
  });
});

describe("T006 /_fareseal prefix on Pages", () => {
  it("/_fareseal/arrival answers like /_tollbooth/arrival", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    const a = await mw(ctx("/_fareseal/arrival", human(), {}));
    const b = await mw(ctx(PATH, human(), {}));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(((await a.json()) as Body).identity.kind).toBe(
      ((await b.json()) as Body).identity.kind,
    );
  });

  it("neither prefix triggers a snapshot flush; an ordinary path does", async () => {
    const posts: string[] = [];
    const flush = async (path: string) => {
      const before = posts.length;
      const pending: Promise<unknown>[] = [];
      const mw = createPagesMiddleware({
        config: toml("rt"),
        snapshots: {
          url: "https://collector.example/v1/report",
          intervalMs: 0,
        },
        fetch: async (url: string) => {
          posts.push(url);
          return new Response("{}", { status: 200 });
        },
      });
      await mw(
        ctx(
          path,
          human(),
          { FARESEAL_SITE_KEY: toBase64Url(generateSecretKey()) },
          (p) => pending.push(p),
        ),
      );
      await Promise.all(pending);
      return posts.length - before;
    };
    expect(await flush("/_fareseal/arrival")).toBe(0);
    expect(await flush("/_tollbooth/arrival")).toBe(0);
    expect(await flush("/research")).toBeGreaterThan(0);
  });

  it("the internal flush request targets https://fareseal.internal/_fareseal/report", () => {
    const src = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("`https://fareseal.internal${REPORT_PATH}`");
    expect(src).toContain('REPORT_PATH = "/_fareseal/report"');
    expect(src).not.toContain("tollbooth.internal");
  });
});
