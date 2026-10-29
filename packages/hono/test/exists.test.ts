// E001: the optional `exists` check. A missing page is answered 404 before
// any offer or payment check, so nobody is charged for nothing.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  NOW,
  PAY_TO,
  validPayment,
} from "../../adapter-x402/test/fixtures/payment.js";
import { tollbooth } from "../src/index.js";

const TOLL = `
mode = "toll"
report_token = "t"
[toll.x402]
pay_to = "${PAY_TO}"
`;

const curlHeaders = { "user-agent": "curl/8.7.1", accept: "*/*" };

function app(exists: (path: string) => Promise<boolean>) {
  const verify = vi.fn(verifyProof);
  const a = new Hono();
  a.use(
    tollbooth({
      config: TOLL,
      x402: { buildOffer, verifyProof: verify },
      exists,
      nowS: () => NOW,
    }),
  );
  a.get("*", (c) => c.text("content"));
  return { a, verify };
}

const report = async (a: Hono) =>
  (
    await a.request("http://example.com/_tollbooth/report", {
      headers: { authorization: "Bearer t" },
    })
  ).json();

describe("E001 exists option", () => {
  it("exists -> offer for an unpaid agent, then a paid request passes", async () => {
    const { a } = app(async () => true);
    const unpaid = await a.request("http://example.com/article", {
      headers: curlHeaders,
    });
    expect(unpaid.status).toBe(402);
    const paid = await a.request("http://example.com/article", {
      headers: { ...curlHeaders, "x-payment": validPayment() },
    });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe("content");
    expect((await report(a)).not_found).toBe(0);
  });

  it("missing -> plain 404, verifyPayment never called, counted", async () => {
    const { a, verify } = app(async () => false);
    const resp = await a.request("http://example.com/nope", {
      headers: { ...curlHeaders, "x-payment": validPayment() },
    });
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
    expect(resp.headers.get("x-payment-response")).toBeNull();
    expect(resp.headers.get("x-payment-required")).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect((await report(a)).not_found).toBe(1);
  });

  it("exists throws or rejects -> today's 402 offer", async () => {
    for (const exists of [
      async () => {
        throw new Error("down");
      },
      (() => {
        throw new Error("sync");
      }) as () => Promise<boolean>,
    ]) {
      const { a } = app(exists);
      const resp = await a.request("http://example.com/article", {
        headers: curlHeaders,
      });
      expect(resp.status).toBe(402);
      expect((await resp.json()).x402Version).toBe(1);
    }
  });

  it("free paths are never checked", async () => {
    const exists = vi.fn(async () => false);
    const { a } = app(exists);
    const resp = await a.request("http://example.com/robots.txt", {
      headers: curlHeaders,
    });
    expect(resp.status).toBe(200);
    expect(exists).not.toHaveBeenCalled();
  });
});
