// The worker module's fetch handler runs in-process: the whole stack is
// platform-free, so what workerd would execute executes here.
import { describe, expect, it } from "vitest";
import worker from "./worker.js";

const handler = worker as unknown as {
  fetch: (req: Request) => Response | Promise<Response>;
};

describe("cloudflare-worker example", () => {
  it("serves humans and tolls agents through the module fetch handler", async () => {
    const human = await handler.fetch(
      new Request("http://example.com/", {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          accept: "text/html,*/*;q=0.8",
        },
      }),
    );
    expect(human.status).toBe(200);

    const agent = await handler.fetch(
      new Request("http://example.com/article", {
        headers: { "user-agent": "curl/8.7.1", accept: "*/*" },
      }),
    );
    expect(agent.status).toBe(402);
    expect(
      ((await agent.json()) as { options: unknown[] }).options.length,
    ).toBeGreaterThan(0);
  });
});
