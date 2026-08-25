// Bun example: identical middleware, Bun's server. Testnet values only.
import { buildOffer, verifyProof } from "@tollbooth/adapter-x402";
import { tollbooth } from "@tollbooth/hono";
import { Hono } from "hono";

const config = `
mode = "toll"
[toll.x402]
network = "base-sepolia"
pay_to = "0x1111111111111111111111111111111111111111"
`;

const app = new Hono();
app.use(tollbooth({ config, x402: { buildOffer, verifyProof } }));
app.get("/", (c) => c.text("welcome, human"));
app.get("/article", (c) => c.text("the article"));

export default app;
