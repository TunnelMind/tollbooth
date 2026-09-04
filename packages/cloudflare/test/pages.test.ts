// T-025 acceptance: the batteries-included Pages middleware behaves exactly
// like the hand-wired tunnelmind.ai deployment it replaces — humans pass,
// agents get a real offer, free paths are exact-or-prefix, config is rebuilt
// when its env inputs change, diagnostics ride the authed report, snapshots
// are signed by the site key, and any thrown error fails OPEN.
import {
  canonicalize,
  fromBase64Url,
  generateSecretKey,
  publicKeyOf,
  toBase64Url,
  verify,
} from "@tollbooth/core";
import { describe, expect, it } from "vitest";
import { PAY_TO } from "../../adapter-x402/test/fixtures/payment.js";
import { createPagesMiddleware } from "../src/index.js";
import { agent, ctx, human, toml } from "./helpers.js";

describe("createPagesMiddleware — core behaviors", () => {
  it("humans pass through to the site", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    const r = await mw(ctx("/research", human(), {}));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("site content");
  });

  it("agents get a 402 with the configured price and pay_to", async () => {
    const mw = createPagesMiddleware({ config: toml("", "0.002") });
    const r = await mw(ctx("/research", agent(), {}));
    expect(r.status).toBe(402);
    const body = (await r.json()) as {
      price_usd: string;
      options: { pay_to: string }[];
    };
    expect(body.price_usd).toBe("0.002");
    expect(body.options[0]?.pay_to).toBe(PAY_TO);
  });

  it("free paths: exact entries match exactly, trailing-slash entries by prefix", async () => {
    const mw = createPagesMiddleware({ config: toml() });
    expect((await mw(ctx("/free", agent(), {}))).status).toBe(200);
    expect((await mw(ctx("/freeloader", agent(), {}))).status).toBe(402);
    expect((await mw(ctx("/docs/deep/page", agent(), {}))).status).toBe(200);
  });

  it("an env-driven config builder rebuilds state when its output changes", async () => {
    const mw = createPagesMiddleware({
      config: (env) => toml("", String(env.PRICE ?? "0.001")),
    });
    const a = (await (
      await mw(ctx("/x", agent(), { PRICE: "0.003" }))
    ).json()) as {
      price_usd: string;
    };
    expect(a.price_usd).toBe("0.003");
    const b = (await (
      await mw(ctx("/x", agent(), { PRICE: "0.004" }))
    ).json()) as {
      price_usd: string;
    };
    expect(b.price_usd).toBe("0.004");
  });

  it("a throwing config builder fails OPEN — the site is served untolled", async () => {
    const mw = createPagesMiddleware({
      config: () => {
        throw new Error("bad toml source");
      },
    });
    const r = await mw(ctx("/research", agent(), {}));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("site content");
  });

  it("the authed report carries x-tollbooth diagnostics; bad auth carries none", async () => {
    const mw = createPagesMiddleware({ config: toml("report-token-1") });
    const authed = await mw(
      ctx("/_tollbooth/report", { authorization: "Bearer report-token-1" }, {}),
    );
    expect(authed.status).toBe(200);
    expect(authed.headers.get("x-tollbooth-mode")).toBe("toll");
    expect(authed.headers.get("x-tollbooth-reporting")).toBe("false");
    expect(authed.headers.get("x-tollbooth-settling")).toBe("false");
    const unauthed = await mw(ctx("/_tollbooth/report", {}, {}));
    expect(unauthed.status).toBe(401); // token IS set; 404 is only for an unset token (T-008)
    expect(unauthed.headers.get("x-tollbooth-mode")).toBeNull();
  });

  it("snapshots are signed by the site key and sent via the binding", async () => {
    const seed = generateSecretKey();
    const sitePub = await publicKeyOf(seed);
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const binding = {
      fetch: async (req: Request) => {
        posts.push({
          url: req.url,
          body: (await req.json()) as Record<string, unknown>,
        });
        return new Response("{}", { status: 200 });
      },
    };
    const flushed: Promise<unknown>[] = [];
    const mw = createPagesMiddleware({
      config: toml("report-token-2"),
      snapshots: { url: "https://collector.example/v1/report", intervalMs: 0 },
      binding: "DATA_API",
    });
    const env = { TOLLBOOTH_SITE_KEY: toBase64Url(seed), DATA_API: binding };
    await mw(ctx("/research", agent(), env, (p) => flushed.push(p)));
    await Promise.all(flushed);
    const snap = posts.find(
      (p) => p.url === "https://collector.example/v1/report",
    );
    if (!snap) throw new Error("no snapshot was posted");
    const { sig, ...unsigned } = snap.body as Record<string, unknown> & {
      sig: string;
    };
    expect(unsigned.kind).toBe("tollbooth-observe-snapshot");
    expect(unsigned.site).toBe(toBase64Url(sitePub));
    expect(
      await verify(fromBase64Url(sig), canonicalize(unsigned), sitePub),
    ).toBe(true);
  });

  it("maze consequence stays inside the configured prefix", async () => {
    const mw = createPagesMiddleware({
      config: toml(),
      corpus: { seed: "test-maze", pages: 8 },
    });
    const m = await mw(ctx("/.well-known/tollbooth-maze", agent(), {}));
    expect(m.status).toBe(200);
    expect(m.headers.get("x-robots-tag")).toContain("noindex");
  });
});
