import { describe, expect, it, vi } from "vitest";
import type { Receipt } from "../src/receipt.js";
import { ReceiptReporter } from "../src/reporter.js";

const receipt = (n: number): Receipt =>
  ({
    v: 1,
    type: "PASS_PAID",
    site: "s",
    agent_key: `k${n}`,
    claimed_key: null,
    ua: "u",
    path_class: "/",
    count: 1,
    window_start: "w",
    window_end: "w",
    sig: "sig",
  }) as Receipt;

function capture(responses: Array<number | Error> = []) {
  const bodies: Receipt[][] = [];
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const next = responses.shift() ?? 200;
    if (next instanceof Error) throw next;
    bodies.push(
      (JSON.parse(init?.body as string) as { receipts: Receipt[] }).receipts,
    );
    return new Response("", { status: next });
  });
  return { bodies, fetchFn };
}

const make = (
  over: Partial<ConstructorParameters<typeof ReceiptReporter>[0]> = {},
) =>
  new ReceiptReporter({
    url: "https://log.test/ingest",
    autoFlush: false,
    ...over,
  });

describe("AC-6.3 / D-6 - batched receipt reporter", () => {
  it("drains the queue in batches", async () => {
    const { bodies, fetchFn } = capture();
    const reporter = make({ fetchFn, batchSize: 50 });
    for (let i = 0; i < 120; i++) reporter.enqueue(receipt(i));
    await reporter.flush();
    expect(bodies.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(reporter.queued).toBe(0);
  });

  it("bounded queue drops oldest and counts the drops", async () => {
    const { bodies, fetchFn } = capture();
    const reporter = make({ fetchFn, queueMax: 3 });
    for (let i = 1; i <= 5; i++) reporter.enqueue(receipt(i));
    expect(reporter.queued).toBe(3);
    expect(reporter.dropped).toBe(2);
    await reporter.flush();
    expect(bodies[0]?.map((r) => r.agent_key)).toEqual(["k3", "k4", "k5"]);
  });

  it("a failed POST requeues the batch, backs off, then recovers", async () => {
    const { bodies, fetchFn } = capture([503, 200]);
    const reporter = make({ fetchFn, backoffBaseMs: 1000 });
    reporter.enqueue(receipt(1));
    reporter.enqueue(receipt(2));

    await reporter.flush(); // 503
    expect(reporter.queued).toBe(2);
    expect(reporter.dropped).toBe(0);
    expect(reporter.backoffMs).toBe(1000);

    await reporter.flush(); // 200
    expect(reporter.queued).toBe(0);
    expect(reporter.backoffMs).toBe(0);
    expect(bodies[0]?.map((r) => r.agent_key)).toEqual(["k1", "k2"]);
  });

  it("backoff doubles up to the cap and never throws, even on sync fetch errors", async () => {
    const reporter = make({
      fetchFn: (() => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
      backoffBaseMs: 1000,
      backoffCapMs: 3000,
    });
    reporter.enqueue(receipt(1));
    await reporter.flush();
    await reporter.flush();
    await reporter.flush();
    expect(reporter.backoffMs).toBe(3000); // 1000 -> 2000 -> 3000 (capped)
    expect(reporter.queued).toBe(1); // still waiting, nothing lost
  });

  it("autoFlush drains in the background without being driven", async () => {
    const { bodies, fetchFn } = capture();
    const reporter = new ReceiptReporter({
      url: "https://log.test/ingest",
      fetchFn,
      sleep: async () => {},
    });
    reporter.enqueue(receipt(1));
    await vi.waitFor(() => expect(reporter.queued).toBe(0));
    expect(bodies).toHaveLength(1);
    reporter.stop();
  });
});

it("domain claim rides on the batch wrapper and a header, never inside a receipt", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const r = new ReceiptReporter({
    url: "https://log.example/ingest",
    domain: "example.org",
    fetchFn,
    autoFlush: false,
  });
  r.enqueue({ v: 1, sig: "x" } as unknown as Receipt);
  await r.flush();
  const body = JSON.parse(calls[0].init?.body as string) as {
    domain?: string;
    receipts: unknown[];
  };
  expect(body.domain).toBe("example.org");
  expect(
    (calls[0].init?.headers as Record<string, string>)["x-tollbooth-domain"],
  ).toBe("example.org");
  expect(JSON.stringify(body.receipts)).not.toContain("example.org");
});
