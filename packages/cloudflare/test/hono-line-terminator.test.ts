// GHSA-h7mg-cq63-vhpq: on hono <=4.13.15 a path with an encoded line
// terminator skipped wildcard middleware under RegExpRouter (a 404 before the
// toll ran). The Pages app is `use(fareseal)` + `all("*", NEXT)`, so we assert
// the fixed behaviour: fareseal runs (an agent is tolled with 402) and a human
// reaches NEXT, exactly like the control path.
import { describe, expect, it, vi } from "vitest";
import { createPagesMiddleware } from "../src/index.js";
import { agent, ctx, human, toml } from "./helpers.js";

const PATHS = ["/x", "/%0A", "/%0D", "/%E2%80%A8", "/%E2%80%A9"];

describe("createPagesMiddleware - encoded line terminators in the path", () => {
  for (const p of PATHS) {
    it(`${p}: an agent is tolled, a human reaches NEXT`, async () => {
      const mw = createPagesMiddleware({ config: toml() });

      const tolled = ctx(p, agent(), {});
      const nextA = vi.fn(tolled.next);
      expect((await mw({ ...tolled, next: nextA })).status).toBe(402);
      expect(nextA).not.toHaveBeenCalled();

      const person = ctx(p, human(), {});
      const nextH = vi.fn(person.next);
      expect((await mw({ ...person, next: nextH })).status).toBe(200);
      expect(nextH).toHaveBeenCalledTimes(1);
    });
  }
});
