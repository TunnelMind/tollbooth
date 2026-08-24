import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * Invalid configuration. Startup must not proceed past this — parseConfig
 * either returns a complete validated config or throws, so a partial start
 * is impossible by construction (AC-1.3).
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const DURATION_RE = /^([0-9]+)(ms|s|m|h|d)$/;
const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/** Duration strings ("300s", "10m", "30d") validate as such and parse to milliseconds. */
function duration(defaultValue: string) {
  return z
    .string()
    .regex(DURATION_RE, `expected a duration like "300s", "10m" or "30d"`)
    .transform((s) => {
      const match = DURATION_RE.exec(s);
      if (!match) throw new Error("unreachable: regex-validated");
      const unit = (match[2] ?? "ms") as keyof typeof UNIT_MS;
      return Number(match[1] ?? "0") * UNIT_MS[unit];
    })
    .prefault(defaultValue);
}

const absolutePath = z.string().startsWith("/");

const x402Schema = z
  .strictObject({
    enabled: z.boolean().prefault(true),
    network: z.string().min(1).prefault("base-sepolia"),
    pay_to: z.string().prefault(""),
  })
  .prefault({});

const stripeSchema = z
  .strictObject({
    enabled: z.boolean().prefault(false),
    payment_link: z.string().prefault(""),
    webhook_secret: z.string().prefault(""),
    credits_per_purchase: z.number().int().positive().prefault(5000),
    voucher_ttl: duration("30d"),
    redeem_ttl: duration("15m"),
  })
  .prefault({});

const tollSchema = z
  .strictObject({
    price_usd: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)?$/, `expected a decimal string like "0.001"`)
      .prefault("0.001"),
    offer_grace: z.number().int().nonnegative().prefault(3),
    window: duration("10m"),
    x402: x402Schema,
    stripe: stripeSchema,
  })
  .prefault({});

const mazeSchema = z
  .strictObject({
    enabled: z.boolean().prefault(true),
    prefix: absolutePath.prefault("/.well-known/tollbooth-maze"),
    corpus_path: z.string().min(1).prefault("./maze-corpus"),
    maze_delay_ms: z.number().int().nonnegative().prefault(800),
    page_bytes_max: z.number().int().positive().prefault(4096),
  })
  .prefault({});

const limitsSchema = z
  .strictObject({
    agent_ledger_max: z.number().int().positive().prefault(50_000),
    jti_lru_max: z.number().int().positive().prefault(100_000),
    replay_window: z.number().int().positive().prefault(2),
  })
  .prefault({});

const configSchema = z.strictObject({
  mode: z.enum(["observe", "toll"]).prefault("observe"),
  site_key_path: z.string().min(1).prefault("./tollbooth.key"),
  free_paths: z.array(absolutePath).prefault(["/robots.txt", "/favicon.ico"]),
  report: z.boolean().prefault(false),
  report_url: z
    .string()
    .regex(/^https?:\/\//, "must be an http(s) URL")
    .optional(),
  report_token: z.string().prefault(""),
  wba_skew_tolerance: duration("300s"),
  toll: tollSchema,
  maze: mazeSchema,
  limits: limitsSchema,
});

/** Validated config. All duration keys hold milliseconds after parsing. */
export type TollboothConfig = z.output<typeof configSchema>;

/**
 * Parse and validate TOML config source. Throws ConfigError naming every
 * offending key (AC-1.3); returns the complete config with plan §5 defaults
 * applied for every omitted key (FR-10).
 */
export function parseConfig(source: string): TollboothConfig {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch (error) {
    throw new ConfigError(
      `invalid config: TOML parse error: ${(error as Error).message}`,
    );
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(`invalid config: ${issues.join("; ")}`);
  }
  return result.data;
}
