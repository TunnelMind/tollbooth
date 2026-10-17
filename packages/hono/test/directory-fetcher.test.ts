// B003: the Signature-Agent directory fetcher's network hardening. A fake
// fetchImpl and clock stand in for the network; nothing here leaves the box.
import { describe, expect, it, vi } from "vitest";
import { makeDirectoryFetcher } from "../src/index.js";

const JWKS = { keys: [] };

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(JWKS),
  );
}

describe("makeDirectoryFetcher", () => {
  it("rejects non-https URLs without fetching", async () => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl });
    await expect(fd("http://agent.example/keys")).rejects.toThrow(/https/);
    await expect(fd("not a url")).rejects.toThrow(/invalid/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches with redirect: error and caches the result", async () => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl });
    expect(await fd("https://agent.example/keys")).toEqual(JWKS);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    await fd("https://agent.example/keys");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels an oversized streamed body before reading it all", async () => {
    const chunk = new Uint8Array(16384).fill(0x20);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        if (pulled > 100) ctrl.close();
        else ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    // No content-length: only the streaming cap can catch it.
    const fetchImpl = vi.fn(async () => new Response(body));
    const fd = makeDirectoryFetcher({ fetchImpl });
    await expect(fd("https://big.example/keys")).rejects.toThrow(/64KB/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("rejects a declared content-length over the cap", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{}", { headers: { "content-length": "65537" } }),
    );
    const fd = makeDirectoryFetcher({ fetchImpl });
    await expect(fd("https://big.example/keys")).rejects.toThrow(/64KB/);
  });

  it("negative-caches a failure for 5 minutes per URL", async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const fd = makeDirectoryFetcher({ fetchImpl, now: () => t });
    await expect(fd("https://down.example/keys")).rejects.toThrow(/500/);
    t += 299_999;
    await expect(fd("https://down.example/keys")).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 1;
    await expect(fd("https://down.example/keys")).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("budgets new origins per minute; cached origins stay free", async () => {
    let t = 1_000_000;
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({
      fetchImpl,
      originsPerMin: 2,
      now: () => t,
    });
    await fd("https://a.example/keys");
    await fd("https://b.example/keys");
    await expect(fd("https://c.example/keys")).rejects.toThrow(/budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // A cached URL, and a new URL on an origin already seen, still work.
    expect(await fd("https://a.example/keys")).toEqual(JWKS);
    await fd("https://a.example/other");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    t += 60_000;
    expect(await fd("https://c.example/keys")).toEqual(JWKS);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
