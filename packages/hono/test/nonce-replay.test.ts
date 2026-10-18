// R102: in toll mode the middleware wires a NonceCache into WBA verify, so a
// replayed nonce-bearing signature must not be credited to the agent twice.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { NOW, PAY_TO } from "../../adapter-x402/test/fixtures/payment.js";
import {
  dirWith,
  makeAgent,
  signedRequest,
} from "../../core/test/fixtures/wba.js";
import { tollbooth } from "../src/index.js";

describe("R102 nonce replay through the middleware (toll mode)", () => {
  it("credits a nonce-bearing signature once; the replay is anonymous", async () => {
    const agent = await makeAgent();
    const app = new Hono();
    app.use(
      tollbooth({
        config: `mode = "toll"\nreport_token = "sekrit"\n[toll.x402]\npay_to = "${PAY_TO}"\n`,
        x402: { buildOffer, verifyProof },
        fetchDirectory: dirWith(agent.jwk),
        nowS: () => NOW,
      }),
    );
    app.get("*", (c) => c.text("content"));

    const wba = await signedRequest(agent, {
      nonce: "n-1",
      created: NOW,
      expires: NOW + 300,
    });
    const headers = {
      "user-agent": "curl/8.7.1",
      accept: "*/*",
      signature: wba.signature,
      "signature-input": wba.signatureInput,
      "signature-agent": wba.signatureAgent,
    };
    // The identical request twice: same signature, same nonce.
    await app.request("http://example.com/article", { headers });
    await app.request("http://example.com/article", { headers });

    const resp = await app.request("http://example.com/_tollbooth/report", {
      headers: { authorization: "Bearer sekrit" },
    });
    expect(resp.status).toBe(200);
    const { agents } = (await resp.json()) as {
      agents: Array<{ key: string; kind: string; requests: number }>;
    };
    expect(agents.find((a) => a.kind === "agent")).toMatchObject({
      key: agent.jwk.x,
      requests: 1,
    });
    expect(agents.find((a) => a.kind === "anonymous-agent")).toMatchObject({
      requests: 1,
    });
  });
});
