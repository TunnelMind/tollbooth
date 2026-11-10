// FR-003/FR-004 (spec 002): a rejected X-PAYMENT gets its reason in the 402
// `error`, from a fixed table; no header keeps the x402 v1 default text.
import {
  buildOffer,
  type TransferAuthorization,
  verifyProof,
} from "@tunnelmindai/fareseal-adapter-x402";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  makeAuth,
  NOW,
  PAY_TO,
  payment,
  signAuth,
} from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
} from "../../core/test/fixtures/wba.js";
import { fareseal, paymentError, type X402Adapter } from "../src/index.js";

const TOLL = `
mode = "toll"
[toll.x402]
pay_to = "${PAY_TO}"
`;
const curl = { "user-agent": "curl/8.7.1", accept: "*/*" };
const OPERATOR =
  "settlement unavailable (operator fault); retry the same payment";

type Verify = X402Adapter["verifyProof"];
const stub =
  (reason: string): Verify =>
  async () => ({ ok: false, payer: null, reason });

function app(
  verify: Verify = verifyProof,
  config = TOLL,
  jwks: JsonWebKey[] = [],
) {
  const a = new Hono();
  a.use(
    fareseal({
      config,
      x402: { buildOffer, verifyProof: verify },
      fetchDirectory: dirWith(...jwks),
      nowS: () => NOW,
    }),
  );
  a.get("*", (c) => c.text("content"));
  return a;
}

async function errorFor(verify: Verify, xPayment = "anything") {
  const r = await app(verify).request("http://example.com/article", {
    headers: { ...curl, "x-payment": xPayment },
  });
  expect(r.status).toBe(402);
  return (await r.json()).error as string;
}

// One row per FR-004 table entry (internal reason -> public `error`).
const TABLE: [string, string][] = [
  ["malformed", "malformed X-PAYMENT header"],
  ["network-mismatch", "wrong network"],
  ["wrong-recipient", "wrong payTo"],
  ["insufficient-value", "amount too low"],
  ["expired", "authorization expired"],
  ["not-yet-valid", "authorization not yet valid"],
  ["window-too-long", "authorization validity window too long"],
  ["bad-signature", "invalid signature (wrong signer or wrong asset)"],
  ["signer-mismatch", "invalid signature (wrong signer or wrong asset)"],
  ["already-settled", "nonce already used"],
  ["payer-cooldown", "payer cooling down after repeated failures; retry later"],
  ["no-transaction-id", "settle failed: no transaction id"],
  ["settle-failed", "settle failed"],
  ["settle-failed(400)", "settle failed"],
  ["verify-failed(402)", "settle failed"],
  ["settle-throttled", OPERATOR],
  ["settlement-unconfigured", OPERATOR],
  ["settle-unreachable", OPERATOR],
  ["settle-retryable", OPERATOR],
  ["settle-failed(503)", OPERATOR],
  ["verify-error: fetch failed https://x", OPERATOR],
  ["insufficient_funds", "facilitator rejected: insufficient_funds"],
  ["Something Else!", "payment rejected"],
  [`${"a".repeat(65)}`, "payment rejected"],
];

describe("402 error carries the rejection reason (FR-004)", () => {
  for (const [reason, want] of TABLE)
    it(`${JSON.stringify(reason)} -> ${JSON.stringify(want)}`, async () => {
      expect(await errorFor(stub(reason))).toBe(want);
    });

  it("internal text never leaks into the 402", async () => {
    for (const reason of [
      "verify-error: fetch failed https://x",
      "boom: fetch failed https://x",
    ]) {
      const error = await errorFor(stub(reason));
      expect(error).not.toMatch(/fetch|https/);
      expect([OPERATOR, "payment rejected"]).toContain(error);
    }
  });

  it("no X-PAYMENT header keeps the x402 v1 default text", async () => {
    const r = await app(stub("expired")).request("http://example.com/a", {
      headers: curl,
    });
    expect((await r.json()).error).toBe("X-PAYMENT header is required");
  });

  it("only `error` differs from the no-header 402", async () => {
    const plain = await app().request("http://example.com/a", {
      headers: curl,
    });
    const bad = await app().request("http://example.com/a", {
      headers: { ...curl, "x-payment": btoa("{}") },
    });
    expect(bad.status).toBe(402);
    expect([...bad.headers]).toEqual([...plain.headers]);
    const { error: e1, ...rest1 } = await plain.json();
    const { error: e2, ...rest2 } = await bad.json();
    expect(rest2).toEqual(rest1);
    expect([e1, e2]).toEqual([
      "X-PAYMENT header is required",
      "malformed X-PAYMENT header",
    ]);
  });

  it("paymentError with no reason is the generic text", () => {
    expect(paymentError()).toBe("payment rejected");
    expect(paymentError("constructor")).toBe(
      "facilitator rejected: constructor",
    );
    expect(paymentError("toString")).toBe("payment rejected");
  });
});

describe("402 error through the real adapter", () => {
  const signed = (o: Partial<TransferAuthorization>, network?: string) => {
    const auth = makeAuth(o);
    return payment(auth, signAuth(auth, network), network);
  };
  const cases: [string, string, string][] = [
    ["malformed", btoa("{}"), "malformed X-PAYMENT header"],
    ["wrong network", signed({}, "base"), "wrong network"],
    [
      "wrong payTo",
      signed({ to: "0x2222222222222222222222222222222222222222" }),
      "wrong payTo",
    ],
    ["amount too low", signed({ value: "1" }), "amount too low"],
    [
      "expired",
      signed({ validBefore: String(NOW - 1) }),
      "authorization expired",
    ],
    [
      "not yet valid",
      signed({ validAfter: String(NOW + 120) }),
      "authorization not yet valid",
    ],
    [
      "bad signature",
      payment(makeAuth(), `0x${"00".repeat(65)}`),
      "invalid signature (wrong signer or wrong asset)",
    ],
  ];
  for (const [name, xp, want] of cases)
    it(name, async () => {
      expect(await errorFor(verifyProof, xp)).toBe(want);
    });
});

describe("the no-maze consequence fallback 402 carries the reason too", () => {
  it("a toll-ignored agent presenting a bad payment", async () => {
    // maze.enabled defaults on, but no maze is wired: the consequence for an
    // agent past its grace offers falls back to the 402 offer.
    const agent = await makeAgent();
    const a = app(stub("expired"), `${TOLL}\n[toll]\noffer_grace = 0\n`, [
      agent.jwk,
    ]);
    const headers = async (extra: Record<string, string> = {}) => {
      const wba = await signedRequest(agent, { expires: NOW + 300 });
      return {
        ...curl,
        signature: wba.signature,
        "signature-input": wba.signatureInput,
        "signature-agent": wba.signatureAgent,
        ...extra,
      };
    };
    let r = new Response();
    for (let i = 0; i < 3; i++)
      r = await a.request("http://example.com/article", {
        headers: await headers({ "x-payment": "anything" }),
      });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("authorization expired");
  });
});
