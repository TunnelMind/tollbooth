// B003: the Signature-Agent directory fetcher's network hardening. A fake
// fetchImpl and clock stand in for the network; nothing here leaves the box.
// R101: the Node default resolver is on, so dns.promises.lookup is stubbed to
// a public address for every test; no real DNS query is made.
import dns from "node:dns";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDirectoryFetcher } from "../src/index.js";

const JWKS = { keys: [] };

type Lookup = (h: string, o: object) => Promise<dns.LookupAddress[]>;
const lookup = vi.spyOn(dns.promises, "lookup") as unknown as ReturnType<
  typeof vi.fn<Lookup>
>;
beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

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

  it("fetches with redirect: manual and caches the result", async () => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl });
    expect(await fd("https://agent.example/keys")).toEqual(JWKS);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
    await fd("https://agent.example/keys");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a 3xx instead of following it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/keys" },
        }),
    );
    const fd = makeDirectoryFetcher({ fetchImpl });
    await expect(fd("https://agent.example/keys")).rejects.toThrow(/302/);
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

// T101: SSRF host vetting, ahead of the origin budget.
describe("makeDirectoryFetcher host vetting", () => {
  it.each([
    "https://10.0.0.1:8443/x",
    "https://169.254.169.254/x",
    "https://0x7f.1/x",
    "https://localhost:9200/x",
    "https://LocalHost./x",
    "https://[::1]/x",
    "https://foo.local/x",
    "https://a.b.localhost/x",
    "https://svc.internal/x",
    "https://example.com:8443/x",
  ])("refuses %s without fetching", async (url) => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl });
    await expect(fd(url)).rejects.toThrow(/not allowed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows an explicit :443", async () => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl });
    expect(await fd("https://example.com:443/x")).toEqual(JWKS);
  });

  it("refused URLs do not spend the new-origin budget", async () => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl, originsPerMin: 1 });
    for (const u of ["https://10.0.0.1/x", "https://svc.internal/x"])
      await expect(fd(u)).rejects.toThrow(/not allowed/);
    expect(await fd("https://example.com/x")).toEqual(JWKS);
  });

  it.each([
    ["10.1.2.3"],
    ["93.184.216.34", "127.0.0.1"],
    ["172.31.0.1"],
    ["192.168.1.1"],
    ["100.64.0.1"],
    ["0.0.0.0"],
    ["::1"],
    ["::"],
    ["fd00::1"],
    ["fe80::1%eth0"],
    ["::ffff:10.0.0.1"],
    ["::ffff:7f00:1"],
    ["not-an-ip"],
    [],
  ])("resolveHost %j refuses before fetching", async (...addrs) => {
    const fetchImpl = okFetch();
    const resolveHost = vi.fn(async () => addrs);
    const fd = makeDirectoryFetcher({ fetchImpl, resolveHost });
    await expect(fd("https://public-looking.example/keys")).rejects.toThrow(
      /not allowed/,
    );
    expect(resolveHost).toHaveBeenCalledWith("public-looking.example");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["93.184.216.34"],
    ["2606:2800:220:1:248:1893:25c8:1946"],
    ["::ffff:93.184.216.34"],
  ])("resolveHost %j lets the fetch proceed", async (...addrs) => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({
      fetchImpl,
      resolveHost: async () => addrs,
    });
    expect(await fd("https://public-looking.example/keys")).toEqual(JWKS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// R101: resolve-then-connect is default-on under Node.
describe("makeDirectoryFetcher default resolver (Node)", () => {
  it.each(["127.0.0.1", "10.0.0.5"])(
    "refuses a name resolving to %s with no resolveHost",
    async (address) => {
      lookup.mockResolvedValue([{ address, family: 4 }]);
      const fetchImpl = okFetch();
      const fd = makeDirectoryFetcher({ fetchImpl });
      await expect(fd("https://public-looking.example/keys")).rejects.toThrow(
        "directory host not allowed",
      );
      expect(lookup).toHaveBeenCalledWith("public-looking.example", {
        all: true,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("fetches when the lookup is public", async () => {
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({ fetchImpl });
    expect(await fd("https://public-looking.example/keys")).toEqual(JWKS);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an explicit resolveHost overrides the default", async () => {
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchImpl = okFetch();
    const fd = makeDirectoryFetcher({
      fetchImpl,
      resolveHost: async () => ["93.184.216.34"],
    });
    expect(await fd("https://public-looking.example/keys")).toEqual(JWKS);
    expect(lookup).not.toHaveBeenCalled();
  });
});
