// Shared test scaffolding for the @tollbooth/cloudflare acceptance suites.
import { PAY_TO } from "../../adapter-x402/test/fixtures/payment.js";

export const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const toml = (reportToken = "", price = "0.001") =>
  [
    `mode = "toll"`,
    `report = true`,
    `report_url = "https://collector.example/v1/receipts"`,
    `report_token = "${reportToken}"`,
    `free_paths = ["/free", "/docs/"]`,
    ``,
    `[toll]`,
    `price_usd = "${price}"`,
    `offer_grace = 3`,
    `window = "10m"`,
    ``,
    `[toll.x402]`,
    `network = "base-sepolia"`,
    `pay_to = "${PAY_TO}"`,
    ``,
    `[maze]`,
    `enabled = true`,
    `prefix = "/.well-known/tollbooth-maze"`,
  ].join("\n");

export function ctx(
  path: string,
  headers: Record<string, string>,
  env: Record<string, unknown>,
  waitUntil?: (p: Promise<unknown>) => void,
) {
  return {
    request: new Request(`https://site.example${path}`, { headers }),
    env,
    next: async () => new Response("site content", { status: 200 }),
    ...(waitUntil ? { waitUntil } : {}),
  };
}

export const agent = (extra: Record<string, string> = {}) => ({
  "user-agent": "curl/8.7.1",
  accept: "*/*",
  ...extra,
});

export const human = () => ({
  "user-agent": HUMAN_UA,
  accept: "text/html,*/*;q=0.8",
});
