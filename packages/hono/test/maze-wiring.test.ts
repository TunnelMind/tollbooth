// US-4 through a real Hono app: grace offers, then the maze; spoofers
// straight to the maze; payment redeems (AC-4.1/4.2/4.4).
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { generateCorpus } from "@tollbooth/cli";
import { parseConfig } from "@tollbooth/core";
import { corpusFromMap, makeMazeHandler } from "@tollbooth/maze";
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

const CFG_TOML = `
mode = "toll"
[toll.x402]
pay_to = "${PAY_TO}"
`;
const CFG = parseConfig(CFG_TOML); // offer_grace 3, maze prefix default
const PREFIX = CFG.maze.prefix;

function makeApp(...directoryAgents: TestAgent[]) {
  const maze = makeMazeHandler({
    corpus: corpusFromMap(generateCorpus({ seed: "wiring", pages: 10 })),
    cfg: CFG,
    sleep: async () => {},
  });
  const app = new Hono();
  app.use(
    tollbooth({
      config: CFG_TOML,
      x402: { buildOffer, verifyProof },
      maze,
      fetchDirectory: dirWith(...directoryAgents.map((a) => a.jwk)),
      nowS: () => NOW,
    }),
  );
  app.get("*", (c) => c.text("content"));
  return app;
}

async function wbaHeaders(agent: TestAgent) {
  const wba = await signedRequest(agent, { expires: NOW + 7200 });
  return {
    "user-agent": "curl/8.7.1",
    accept: "*/*",
    signature: wba.signature,
    "signature-input": wba.signatureInput,
    "signature-agent": wba.signatureAgent,
  };
}

describe("US-4 - the consequence, wired", () => {
  it("AC-4.1: grace 402s, then a redirect into the maze that actually serves decoys", async () => {
    const agent = await makeAgent();
    const app = makeApp(agent);
    const headers = await wbaHeaders(agent);

    for (let i = 0; i < 3; i++)
      expect(
        (await app.request("http://example.com/article", { headers })).status,
      ).toBe(402);

    const mazed = await app.request("http://example.com/article", { headers });
    expect(mazed.status).toBe(302);
    expect(mazed.headers.get("location")).toBe(`${PREFIX}/`);

    const page = await app.request(`http://example.com${PREFIX}/`, { headers });
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await page.text()).toContain("<h1>");
  });

  it("AC-4.2: a spoofed signature goes to the maze immediately, no offers", async () => {
    const agent = await makeAgent();
    const app = makeApp(agent);
    const headers = { ...(await wbaHeaders(agent)) };
    const resp = await app.request("http://evil.example/article", {
      headers: { ...headers, host: "evil.example" },
    });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe(`${PREFIX}/`);
  });

  it("AC-4.4: a mazed key that pays passes, then has fresh grace", async () => {
    const agent = await makeAgent();
    const app = makeApp(agent);
    const headers = await wbaHeaders(agent);

    for (let i = 0; i < 3; i++)
      await app.request("http://example.com/article", { headers });
    expect(
      (await app.request("http://example.com/article", { headers })).status,
    ).toBe(302);

    const paid = await app.request("http://example.com/article", {
      headers: { ...headers, "x-payment": validPayment() },
    });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe("content");

    expect(
      (await app.request("http://example.com/article", { headers })).status,
    ).toBe(402);
  });

  it("humans never see any of it, and the maze prefix serves decoys to whoever asks", async () => {
    const app = makeApp();
    const human = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "text/html,*/*;q=0.8",
    };
    expect(
      (await app.request("http://example.com/article", { headers: human }))
        .status,
    ).toBe(200);
    const decoy = await app.request(
      `http://example.com${PREFIX}/page-0002.html`,
      { headers: human },
    );
    expect(decoy.status).toBe(200);
    expect(decoy.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
