// Node example: the tollbooth on @hono/node-server (ADR 002). Testnet
// values only - the operator sets real ones (Constitution V.15).
import { serve } from "@hono/node-server";
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { tollbooth } from "@tollbooth/hono";
import { Hono } from "hono";

const config = `
mode = "toll"
[toll.x402]
network = "base-sepolia"
pay_to = "0x1111111111111111111111111111111111111111"
`;

export const app = new Hono();
app.use(tollbooth({ config, x402: { buildOffer, verifyProof } }));
app.get("/", (c) => c.text("welcome, human"));
app.get("/article", (c) => c.text("the article"));

if (process.env.TOLLBOOTH_EXAMPLE_SERVE) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) =>
    console.log(`tollbooth node example listening on :${info.port}`),
  );
}
