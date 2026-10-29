// Spec 119 E002: `exists: "assets"` HEADs the Pages static asset binding
// before a toll-mode offer, so a missing page answers a plain 404 instead of
// being sold. Answers are cached per state in a bounded map.
import { describe, expect, it } from "vitest";
import {
  createPagesMiddleware,
  TollboothBindingMissingError,
} from "../src/index.js";
import { agent, ctx, toml } from "./helpers.js";

// A recording ASSETS stub: 404 for paths in `missing`, 200 otherwise.
function assetsStub(missing: string[] = [], throws = false) {
  const calls: { method: string; path: string }[] = [];
  return {
    calls,
    fetch: async (req: Request) => {
      calls.push({ method: req.method, path: new URL(req.url).pathname });
      if (throws) throw new Error("assets down");
      return new Response(null, {
        status: missing.includes(new URL(req.url).pathname) ? 404 : 200,
      });
    },
  };
}

describe('exists: "assets"', () => {
  it("an existing asset gets the usual 402 offer after one HEAD", async () => {
    const ASSETS = assetsStub();
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    const resp = await mw(ctx("/research", agent(), { ASSETS }));
    expect(resp.status).toBe(402);
    expect(ASSETS.calls).toEqual([{ method: "HEAD", path: "/research" }]);
  });

  it("a missing asset gets a plain 404 with no offer", async () => {
    const ASSETS = assetsStub(["/gone"]);
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    const resp = await mw(ctx("/gone", agent(), { ASSETS }));
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
    expect(resp.headers.get("payment-required")).toBeNull();
    expect(resp.headers.get("www-authenticate")).toBeNull();
  });

  it("a repeat request for the same path hits the cache", async () => {
    const ASSETS = assetsStub(["/gone"]);
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    expect((await mw(ctx("/gone", agent(), { ASSETS }))).status).toBe(404);
    expect((await mw(ctx("/gone", agent(), { ASSETS }))).status).toBe(404);
    expect(ASSETS.calls).toHaveLength(1);
  });

  it("the cache is bounded at 1024 paths, oldest out", async () => {
    const ASSETS = assetsStub();
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    for (let i = 0; i <= 1024; i++)
      await mw(ctx(`/p${i}`, agent(), { ASSETS }));
    expect(ASSETS.calls).toHaveLength(1025);
    await mw(ctx("/p1024", agent(), { ASSETS })); // newest: still cached
    expect(ASSETS.calls).toHaveLength(1025);
    await mw(ctx("/p0", agent(), { ASSETS })); // oldest: evicted, asked again
    expect(ASSETS.calls).toHaveLength(1026);
  });

  it("a throwing ASSETS.fetch yields today's 402 offer and is not cached", async () => {
    const ASSETS = assetsStub([], true);
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    expect((await mw(ctx("/research", agent(), { ASSETS }))).status).toBe(402);
    expect((await mw(ctx("/research", agent(), { ASSETS }))).status).toBe(402);
    expect(ASSETS.calls).toHaveLength(2);
  });

  it("free paths are never checked", async () => {
    const ASSETS = assetsStub(["/free"]);
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    expect((await mw(ctx("/free", agent(), { ASSETS }))).status).toBe(200);
    expect(ASSETS.calls).toEqual([]);
  });

  it("env without ASSETS.fetch throws at construction", async () => {
    const mw = createPagesMiddleware({ config: toml(), exists: "assets" });
    const err = await mw(ctx("/research", agent(), { OTHER: 1 })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TollboothBindingMissingError);
    expect(err.binding).toBe("ASSETS");
    await expect(
      mw(ctx("/research", agent(), { ASSETS: { notFetch: true } })),
    ).rejects.toBeInstanceOf(TollboothBindingMissingError);
  });

  it("without the option the binding is never called", async () => {
    const ASSETS = assetsStub(["/gone"]);
    const mw = createPagesMiddleware({ config: toml() });
    expect((await mw(ctx("/gone", agent(), { ASSETS }))).status).toBe(402);
    expect(ASSETS.calls).toEqual([]);
  });
});
