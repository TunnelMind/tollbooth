// GHSA-h7mg-cq63-vhpq: on hono <=4.13.15 a path with an encoded line
// terminator skipped wildcard middleware under RegExpRouter (a 404 before the
// toll ran). Assert the fixed behaviour: fareseal runs (an agent is tolled with
// 402) and a human reaches the catch-all origin, exactly like the control.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { toml } from "../../cloudflare/test/helpers.js";
import { dirWith, NOW } from "../../core/test/fixtures/wba.js";
import { fareseal } from "../src/index.js";

const PATHS = ["/x", "/%0A", "/%0D", "/%E2%80%A8", "/%E2%80%A9"];
const BROWSER = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const CURL = { "user-agent": "curl/8.7.1", accept: "*/*" };

describe("fareseal middleware - encoded line terminators in the path", () => {
  for (const p of PATHS) {
    it(`${p}: an agent is tolled, a human reaches the origin`, async () => {
      let origin = 0;
      const app = new Hono();
      app.use(
        fareseal({
          config: toml(),
          fetchDirectory: dirWith(),
          nowS: () => NOW,
        }),
      );
      app.all("*", (c) => {
        origin++;
        return c.text("origin");
      });

      const a = await app.request(`http://example.com${p}`, { headers: CURL });
      expect(a.status).toBe(402);
      expect(origin).toBe(0);

      const h = await app.request(`http://example.com${p}`, {
        headers: BROWSER,
      });
      expect(h.status).toBe(200);
      expect(await h.text()).toBe("origin");
      expect(origin).toBe(1);
    });
  }
});
