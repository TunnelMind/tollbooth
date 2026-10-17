// B008: fail open on our own fault, never on the origin's; and a verify-only
// x402 adapter is refused at startup on mainnet.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  makeAuth,
  NOW,
  PAY_TO,
  payment,
} from "../../adapter-x402/test/fixtures/payment.js";
import { tollbooth, type X402Adapter } from "../src/index.js";

const toll = (network: string) => `
mode = "toll"
[toll.x402]
network = "${network}"
pay_to = "${PAY_TO}"
`;
const curl = { "user-agent": "curl/8.7.1", accept: "*/*" };

function app(x402: X402Adapter, origin = () => new Response("content")) {
  const a = new Hono();
  let originCalls = 0;
  a.use(tollbooth({ config: toll("base-sepolia"), x402, nowS: () => NOW }));
  a.get("*", () => {
    originCalls += 1;
    return origin();
  });
  return { a, calls: () => originCalls };
}

describe("B008 - verify-only adapter refused on mainnet", () => {
  it("throws at construction for a verify-only adapter on base", () => {
    expect(() =>
      tollbooth({ config: toll("base"), x402: { buildOffer, verifyProof } }),
    ).toThrow(/verify-only x402 adapter refused on mainnet/);
  });

  it("allows verify-only on base-sepolia, and a settling adapter on base", () => {
    expect(() =>
      tollbooth({
        config: toll("base-sepolia"),
        x402: { buildOffer, verifyProof },
      }),
    ).not.toThrow();
    expect(() =>
      tollbooth({
        config: toll("base"),
        x402: { buildOffer, verifyProof, settles: true },
      }),
    ).not.toThrow();
  });
});

describe("B008 - fail open on an internal error", () => {
  it("authorization.to: 5 is not a 500 (402 offer, adapter never throws)", async () => {
    const auth = { ...makeAuth(), to: 5 } as unknown as ReturnType<
      typeof makeAuth
    >;
    const { a } = app({ buildOffer, verifyProof });
    const r = await a.request("http://example.com/article", {
      headers: { ...curl, "x-payment": payment(auth, "0x00") },
    });
    expect(r.status).not.toBe(500);
    expect(r.status).toBe(402);
  });

  it("a throw inside tollbooth's own logic hands the request to the origin once", async () => {
    const { a, calls } = app({
      buildOffer,
      verifyProof: () => {
        throw new Error("adapter bug");
      },
    });
    const r = await a.request("http://example.com/article", {
      headers: { ...curl, "x-payment": "anything" },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("content");
    expect(calls()).toBe(1);
  });

  it("a throw from the origin still errors and the origin runs once", async () => {
    const { a, calls } = app({ buildOffer, verifyProof }, () => {
      throw new Error("origin bug");
    });
    // A human passes, so next() runs and the origin throws.
    const r = await a.request("http://example.com/article", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept: "text/html,*/*;q=0.8",
        "accept-language": "en-US",
      },
    });
    expect(r.status).toBe(500);
    expect(calls()).toBe(1);
  });
});
