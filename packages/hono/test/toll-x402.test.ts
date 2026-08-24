// The T-010 milestone: a usable x402 tollbooth end to end. An agent with a
// valid payment passes; an unpaid one gets 402s with actionable headers.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  NOW,
  PAY_TO,
  validPayment,
} from "../../adapter-x402/test/fixtures/payment.js";
import { dirWith } from "../../core/test/fixtures/wba.js";
import { tollbooth } from "../src/index.js";

const TOLL = `
mode = "toll"
[toll.x402]
pay_to = "${PAY_TO}"
`;

const curlHeaders = { "user-agent": "curl/8.7.1", accept: "*/*" };

function app() {
  const a = new Hono();
  a.use(
    tollbooth({
      config: TOLL,
      x402: { buildOffer, verifyProof },
      fetchDirectory: dirWith(),
      nowS: () => NOW,
    }),
  );
  a.get("*", (c) => c.text("content"));
  return a;
}

describe("T-010 milestone - usable x402 tollbooth", () => {
  it("an unpaid agent gets 402 with the adapter's payment-required header", async () => {
    const resp = await app().request("http://example.com/article", {
      headers: curlHeaders,
    });
    expect(resp.status).toBe(402);
    const requirement = JSON.parse(
      resp.headers.get("x-payment-required") ?? "",
    );
    expect(requirement.payTo).toBe(PAY_TO);
    expect(requirement.maxAmountRequired).toBe("1000");
    expect(requirement.resource).toBe("/article");
  });

  it("the same agent retrying with a valid X-PAYMENT passes", async () => {
    const a = app();
    const first = await a.request("http://example.com/article", {
      headers: curlHeaders,
    });
    expect(first.status).toBe(402);

    const paid = await a.request("http://example.com/article", {
      headers: { ...curlHeaders, "x-payment": validPayment() },
    });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe("content");
  });

  it("a bad payment proof still gets the 402", async () => {
    const resp = await app().request("http://example.com/article", {
      headers: { ...curlHeaders, "x-payment": btoa("{}") },
    });
    expect(resp.status).toBe(402);
  });

  it("payment is per-request: the next unpaid request is tolled again", async () => {
    const a = app();
    const paid = await a.request("http://example.com/article", {
      headers: { ...curlHeaders, "x-payment": validPayment() },
    });
    expect(paid.status).toBe(200);
    const unpaid = await a.request("http://example.com/article", {
      headers: curlHeaders,
    });
    expect(unpaid.status).toBe(402);
  });
});
