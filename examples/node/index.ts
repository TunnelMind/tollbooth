// Node example: the Fareseal door on @hono/node-server (ADR 002). Testnet
// values only - the operator sets real ones (Constitution V.15).
import { serve } from "@hono/node-server";
import { buildOffer, verifyProof } from "@tunnelmindai/fareseal-adapter-x402";
import { readEnv } from "@tunnelmindai/fareseal-core";
import { fareseal } from "@tunnelmindai/fareseal-hono";
import { Hono } from "hono";

const config = `
mode = "toll"
[toll.x402]
network = "base-sepolia"
pay_to = "0x1111111111111111111111111111111111111111"
`;

export const app = new Hono();
// Verify-only is testnet-only: mainnet requires a settling verifier (settles: true).
// On Node the default directory fetcher resolves Signature-Agent hosts and
// refuses private addresses; nothing to wire.
app.use(fareseal({ config, x402: { buildOffer, verifyProof } }));
app.get("/", (c) => c.text("welcome, human"));
app.get("/article", (c) => c.text("the article"));

if (readEnv(process.env, "EXAMPLE_SERVE")) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) =>
    console.log(`fareseal node example listening on :${info.port}`),
  );
}
