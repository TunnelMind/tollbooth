import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

describe("US-1 AC-1.3 — invalid config fails startup naming the bad key", () => {
  it("rejects a bad enum value, naming `mode`", () => {
    expect(() => parseConfig(`mode = "observve"`)).toThrowError(ConfigError);
    expect(() => parseConfig(`mode = "observve"`)).toThrowError(/mode/);
  });

  it("rejects a bad nested value, naming the full dotted path", () => {
    expect(() => parseConfig("[toll]\noffer_grace = -1")).toThrowError(
      /toll\.offer_grace/,
    );
  });

  it("rejects unknown keys by name (typo detection)", () => {
    expect(() => parseConfig(`modee = "observe"`)).toThrowError(/modee/);
  });

  it("rejects a malformed duration, naming the key", () => {
    expect(() => parseConfig(`[toll]\nwindow = "10 minutes"`)).toThrowError(
      /toll\.window/,
    );
  });

  it("rejects a free_paths entry that does not start with a slash", () => {
    expect(() => parseConfig(`free_paths = ["robots.txt"]`)).toThrowError(
      /free_paths/,
    );
  });

  it("rejects TOML syntax errors as ConfigError", () => {
    expect(() => parseConfig("mode = ")).toThrowError(ConfigError);
  });

  it("reports every bad key, not just the first", () => {
    let message = "";
    try {
      parseConfig(`mode = "nope"\n[maze]\nmaze_delay_ms = -5`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("mode");
    expect(message).toContain("maze.maze_delay_ms");
  });

  // "No partial start" holds by construction: parseConfig either returns a
  // complete validated config or throws — there is no partially-built value.
});

describe("FR-10 — documented defaults for every key (plan §5)", () => {
  it("an empty config yields the full default surface", () => {
    const c = parseConfig("");
    expect(c.mode).toBe("observe");
    expect(c.site_key_path).toBe("./tollbooth.key");
    expect(c.free_paths).toEqual(["/robots.txt", "/favicon.ico"]);
    expect(c.report).toBe(false);
    expect(c.report_url).toBeUndefined();
    expect(c.report_token).toBe("");
    expect(c.wba_skew_tolerance).toBe(300_000);

    expect(c.toll.price_usd).toBe("0.001");
    expect(c.toll.offer_grace).toBe(3);
    expect(c.toll.window).toBe(600_000);
    expect(c.toll.x402.enabled).toBe(true);
    expect(c.toll.x402.network).toBe("base-sepolia");
    expect(c.toll.x402.pay_to).toBe("");
    expect(c.toll.stripe.enabled).toBe(false);
    expect(c.toll.stripe.payment_link).toBe("");
    expect(c.toll.stripe.webhook_secret).toBe("");
    expect(c.toll.stripe.credits_per_purchase).toBe(5000);
    expect(c.toll.stripe.voucher_ttl).toBe(30 * 86_400_000);
    expect(c.toll.stripe.redeem_ttl).toBe(900_000);
    expect(c.toll.stripe.bearer).toBe(false);

    expect(c.maze.enabled).toBe(true);
    expect(c.maze.prefix).toBe("/.well-known/tollbooth-maze");
    expect(c.maze.corpus_path).toBe("./maze-corpus");
    expect(c.maze.maze_delay_ms).toBe(800);
    expect(c.maze.page_bytes_max).toBe(4096);

    expect(c.limits.agent_ledger_max).toBe(50_000);
    expect(c.limits.jti_lru_max).toBe(100_000);
    expect(c.limits.replay_window).toBe(2);
  });

  it("a partial section keeps defaults for omitted siblings", () => {
    const c = parseConfig("[toll]\noffer_grace = 5");
    expect(c.toll.offer_grace).toBe(5);
    expect(c.toll.price_usd).toBe("0.001");
    expect(c.toll.x402.network).toBe("base-sepolia");
    expect(c.maze.enabled).toBe(true);
  });

  it("a full config round-trips every value", () => {
    const c = parseConfig(`
mode = "toll"
site_key_path = "./keys/site.key"
free_paths = ["/robots.txt", "/pricing"]
report = true
report_url = "https://log.example.com/ingest"
report_token = "sekrit"
wba_skew_tolerance = "120s"

[toll]
price_usd = "0.002"
offer_grace = 5
window = "5m"

[toll.x402]
enabled = true
network = "base-sepolia"
pay_to = "0xabc"

[toll.stripe]
enabled = true
payment_link = "https://buy.stripe.com/test_123"
webhook_secret = "whsec_x"
credits_per_purchase = 1000
voucher_ttl = "7d"
redeem_ttl = "10m"

[maze]
enabled = false
prefix = "/decoys"
corpus_path = "./corpus"
maze_delay_ms = 100
page_bytes_max = 2048

[limits]
agent_ledger_max = 10
jti_lru_max = 20
replay_window = 1
`);
    expect(c.mode).toBe("toll");
    expect(c.free_paths).toEqual(["/robots.txt", "/pricing"]);
    expect(c.report_url).toBe("https://log.example.com/ingest");
    expect(c.wba_skew_tolerance).toBe(120_000);
    expect(c.toll.window).toBe(300_000);
    expect(c.toll.stripe.voucher_ttl).toBe(7 * 86_400_000);
    expect(c.toll.stripe.redeem_ttl).toBe(600_000);
    expect(c.maze.prefix).toBe("/decoys");
    expect(c.limits.replay_window).toBe(1);
  });

  it("durations accept ms/s/m/h/d units", () => {
    const c = parseConfig(`wba_skew_tolerance = "1500ms"`);
    expect(c.wba_skew_tolerance).toBe(1500);
    const h = parseConfig(`[toll]\nwindow = "2h"`);
    expect(h.toll.window).toBe(7_200_000);
  });
});

it("report_domain: off by default, carried verbatim when set", () => {
  expect(parseConfig("").report_domain).toBe("");
  expect(parseConfig('report_domain = "example.org"').report_domain).toBe(
    "example.org",
  );
});
