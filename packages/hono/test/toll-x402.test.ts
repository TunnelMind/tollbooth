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
import {
  dirWith,
  makeAgent,
  signedRequest,
  type TestAgent,
} from "../../core/test/fixtures/wba.js";
import { tollbooth } from "../src/index.js";

const TOLL = `
mode = "toll"
[toll.x402]
pay_to = "${PAY_TO}"
`;

const curlHeaders = { "user-agent": "curl/8.7.1", accept: "*/*" };

function app(...directoryAgents: TestAgent[]) {
  const a = new Hono();
  a.use(
    tollbooth({
      config: TOLL,
      x402: { buildOffer, verifyProof },
      fetchDirectory: dirWith(...directoryAgents.map((a) => a.jwk)),
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
    expect(requirement.resource).toBe("http://example.com/article");
  });

  it("the 402 body speaks x402 v1 and keeps the v:1 offer fields", async () => {
    const resp = await app().request("http://example.com/article?page=2", {
      headers: curlHeaders,
    });
    expect(resp.status).toBe(402);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    const body = await resp.json();
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe("X-PAYMENT header is required");
    expect(body.accepts).toHaveLength(1);
    const req = body.accepts[0];
    // Every x402 v1 PaymentRequirements key, with its type.
    expect(Object.keys(req).sort()).toEqual(
      [
        "scheme",
        "network",
        "maxAmountRequired",
        "resource",
        "description",
        "mimeType",
        "payTo",
        "maxTimeoutSeconds",
        "asset",
        "outputSchema",
        "extra",
      ].sort(),
    );
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("base-sepolia");
    expect(req.maxAmountRequired).toBe("1000");
    expect(req.resource).toBe("http://example.com/article?page=2");
    expect(req.resource.startsWith("http")).toBe(true);
    expect(typeof req.description).toBe("string");
    expect(typeof req.mimeType).toBe("string");
    expect(req.payTo).toBe(PAY_TO);
    expect(req.maxTimeoutSeconds).toBe(300);
    expect(req.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(req.outputSchema).toBeNull();
    expect(typeof req.extra.name).toBe("string");
    expect(typeof req.extra.version).toBe("string");
    // The pre-x402 tollbooth offer is unchanged alongside.
    expect(body.v).toBe(1);
    expect(body.price_usd).toBe("0.001");
    expect(body.options[0]).toEqual({
      method: "x402",
      network: "base-sepolia",
      pay_to: PAY_TO,
      price_usd: "0.001",
    });
    const header = JSON.parse(resp.headers.get("x-payment-required") ?? "");
    expect(header).toEqual(req);
  });

  it("the no-maze consequence fallback 402 is the same offer, uncached", async () => {
    // A signature replayed against another host is a spoof - a consequence;
    // with no maze configured the fallback is a 402.
    const agent = await makeAgent();
    const wba = await signedRequest(agent, { expires: NOW + 7200 });
    const resp = await app(agent).request("http://evil.example/article", {
      headers: {
        ...curlHeaders,
        host: "evil.example",
        signature: wba.signature,
        "signature-input": wba.signatureInput,
        "signature-agent": wba.signatureAgent,
      },
    });
    expect(resp.status).toBe(402);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    const body = await resp.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0].resource).toBe("http://evil.example/article");
    expect(body.v).toBe(1);
  });

  it("a paid pass returns X-PAYMENT-RESPONSE", async () => {
    const paid = await app().request("http://example.com/article", {
      headers: { ...curlHeaders, "x-payment": validPayment() },
    });
    expect(paid.status).toBe(200);
    const receipt = JSON.parse(
      atob(paid.headers.get("x-payment-response") ?? ""),
    );
    // The local verifier has no on-chain transaction: "" by design.
    expect(receipt).toEqual({
      success: true,
      transaction: "",
      network: "base-sepolia",
      payer: expect.stringMatching(/^0x[0-9a-f]{40}$/),
    });
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
