// Cloudflare Workers example: the same middleware as a module worker -
// nothing in the stack imports node builtins. Testnet values only.
import { buildOffer, verifyProof } from "@tunnelmindai/fareseal-adapter-x402";
import { fareseal } from "@tunnelmindai/fareseal-hono";
import { Hono } from "hono";

const config = `
mode = "toll"
[toll.x402]
network = "base-sepolia"
pay_to = "0x1111111111111111111111111111111111111111"
`;

const app = new Hono();
// Verify-only is testnet-only: mainnet requires a settling verifier (settles: true).
app.use(fareseal({ config, x402: { buildOffer, verifyProof } }));
app.get("/", (c) => c.text("welcome, human"));
app.get("/article", (c) => c.text("the article"));

export default app;
