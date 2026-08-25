// CI check: the bun example actually serves and tolls under Bun.
import app from "./index.ts";

declare const Bun: {
  serve(options: { fetch: typeof app.fetch; port: number }): {
    port: number;
    stop(): void;
  };
};

const server = Bun.serve({ fetch: app.fetch, port: 0 });
const base = `http://localhost:${server.port}`;

const human = await fetch(`${base}/`, {
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    accept: "text/html,*/*;q=0.8",
  },
});
const agent = await fetch(`${base}/article`, {
  headers: { "user-agent": "curl/8.7.1", accept: "*/*" },
});

server.stop();
if (human.status !== 200 || agent.status !== 402) {
  console.error(`FAIL: human=${human.status} agent=${agent.status}`);
  process.exit(1);
}
console.log("bun-hono example OK: human 200, agent 402");
