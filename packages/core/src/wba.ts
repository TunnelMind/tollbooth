// Web Bot Auth (draft-meunier-web-bot-auth / RFC 9421 profile) verification,
// ported from the estate's proven implementation (tunnelmind-data-api
// api/lib/agents/wba.js, wire profile verified against Cloudflare's WBA docs).
//
// Two deliberate changes from the original:
//   - crypto verification runs BEFORE temporal checks, so an expired-but-valid
//     signature reports `stale` (anonymous per Constitution IV.13) while a
//     tampered one reports `invalid_signature` regardless of timestamps;
//   - Ed25519 goes through keys.ts (noble) instead of WebCrypto key imports.
//
// Covered-component support is the minimal WBA set; anything else is rejected
// naming the supported set. States are facts, not verdicts: "verified" means
// "this signature cryptographically verifies against that directory".
import { fromBase64Url, toBase64Url, verify } from "./keys.js";

const SUPPORTED_COMPONENTS = [
  "@authority",
  "@method",
  "@path",
  "@scheme",
  "signature-agent",
];
const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const DEFAULT_SKEW_S = 300;

export interface ParsedSignatureInput {
  label: string;
  /** Verbatim text after `label=` — reused byte-for-byte as @signature-params. */
  inner: string;
  components: string[];
  params: Record<string, string | number>;
}

export function parseSignatureInput(headerValue: string): ParsedSignatureInput {
  const s = headerValue.trim();
  const eq = s.indexOf("=");
  if (eq < 1) throw new Error("Signature-Input: expected label=(...) form");
  const label = s.slice(0, eq).trim();
  const inner = s.slice(eq + 1).trim();
  if (!inner.startsWith("("))
    throw new Error("Signature-Input: expected component list after label");
  const close = inner.indexOf(")");
  if (close < 0)
    throw new Error("Signature-Input: unterminated component list");

  const components = (inner.slice(1, close).match(/"[^"]*"/g) ?? []).map((q) =>
    q.slice(1, -1),
  );

  const params: Record<string, string | number> = {};
  const paramRe = /;\s*([a-z]+)=(?:"([^"]*)"|([0-9]+))/g;
  let m = paramRe.exec(inner.slice(close + 1));
  while (m !== null) {
    const name = m[1];
    if (name) params[name] = m[2] !== undefined ? m[2] : Number(m[3] ?? "0");
    m = paramRe.exec(inner.slice(close + 1));
  }
  return { label, inner, components, params };
}

/** Signature header entry for `label` → raw bytes (RFC 8941 :base64: byte sequence). */
export function parseSignature(headerValue: string, label: string): Uint8Array {
  const s = headerValue.trim();
  const prefix = `${label}=`;
  if (!s.startsWith(prefix))
    throw new Error(`Signature: no entry for label "${label}"`);
  const v = s.slice(prefix.length).trim();
  if (!v.startsWith(":") || !v.endsWith(":"))
    throw new Error("Signature: expected :base64: byte sequence");
  return Uint8Array.from(atob(v.slice(1, -1)), (ch) => ch.charCodeAt(0));
}

/** The Signature-Agent header is a quoted https origin; returns its directory URL. */
export function parseSignatureAgent(headerValue: string): string {
  const s = headerValue.trim();
  if (!s.startsWith('"') || !s.endsWith('"'))
    throw new Error("Signature-Agent: must be a double-quoted string");
  let url: URL;
  try {
    url = new URL(s.slice(1, -1));
  } catch {
    throw new Error("Signature-Agent: not a valid URL");
  }
  if (url.protocol !== "https:")
    throw new Error("Signature-Agent: must be https");
  return url.origin + DIRECTORY_PATH;
}

export interface SignatureBaseContext {
  authority: string;
  method?: string;
  path?: string;
  scheme?: string;
  signatureAgent: string;
}

/** Build the RFC 9421 signature base for the covered components. */
export function buildSignatureBase(
  parsed: ParsedSignatureInput,
  ctx: SignatureBaseContext,
): string {
  const lines: string[] = [];
  for (const c of parsed.components) {
    if (!SUPPORTED_COMPONENTS.includes(c)) {
      throw new Error(
        `unsupported covered component "${c}" (supported: ${SUPPORTED_COMPONENTS.join(", ")})`,
      );
    }
    let value = "";
    if (c === "@authority") value = ctx.authority.toLowerCase();
    else if (c === "@method") value = (ctx.method ?? "").toUpperCase();
    else if (c === "@path") value = ctx.path ?? "";
    else if (c === "@scheme") value = (ctx.scheme ?? "https").toLowerCase();
    else if (c === "signature-agent") value = ctx.signatureAgent.trim();
    if (!value)
      throw new Error(
        `covered component "${c}" needs a value from the request`,
      );
    lines.push(`"${c}": ${value}`);
  }
  lines.push(`"@signature-params": ${parsed.inner}`);
  return lines.join("\n");
}

/** RFC 7638 / RFC 8037 A.3 thumbprint of an Ed25519 OKP JWK (base64url of SHA-256). */
export async function ed25519Thumbprint(jwk: {
  crv: string;
  kty: string;
  x: string;
}): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return toBase64Url(new Uint8Array(digest));
}

export type WbaState =
  | "verified"
  | "stale"
  | "invalid_signature"
  | "unknown_key"
  | "directory_unreachable"
  | "malformed";

export interface WbaCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface WbaResult {
  state: WbaState;
  checks: WbaCheck[];
  keyId: string | null;
  /** base64url raw Ed25519 public key — set once the key is found in the directory. */
  agentKey: string | null;
  directoryUrl: string | null;
  params: Record<string, string | number>;
}

export interface WbaInput {
  signature: string;
  signatureInput: string;
  signatureAgent: string;
  authority: string;
  method?: string;
  path?: string;
  scheme?: string;
}

/** Injected so callers add caching and tests stub the network; core never fetches. */
export type FetchDirectory = (url: string) => Promise<unknown>;

export interface WbaOptions {
  /** Temporal slack in seconds before a valid signature counts as stale (default 300). */
  skewToleranceS?: number;
  /** Epoch seconds "now" — injectable for deterministic tests. */
  nowS?: number;
}

export async function verifyWebBotAuth(
  input: WbaInput,
  deps: { fetchDirectory: FetchDirectory },
  options: WbaOptions = {},
): Promise<WbaResult> {
  const checks: WbaCheck[] = [];
  const push = (name: string, pass: boolean, detail?: string): boolean => {
    checks.push(detail === undefined ? { name, pass } : { name, pass, detail });
    return pass;
  };
  const result = (
    state: WbaState,
    extra: Partial<WbaResult> = {},
  ): WbaResult => ({
    state,
    checks,
    keyId: null,
    agentKey: null,
    directoryUrl: null,
    params: {},
    ...extra,
  });

  let parsed: ParsedSignatureInput;
  let sigBytes: Uint8Array;
  let directoryUrl: string;
  try {
    parsed = parseSignatureInput(input.signatureInput);
    sigBytes = parseSignature(input.signature, parsed.label);
    directoryUrl = parseSignatureAgent(input.signatureAgent);
  } catch (error) {
    push("parse", false, (error as Error).message);
    return result("malformed");
  }
  push(
    "parse",
    true,
    `label=${parsed.label} components=(${parsed.components.join(" ")})`,
  );

  const p = parsed.params;
  const keyId = typeof p["keyid"] === "string" ? p["keyid"] : null;
  const base: Partial<WbaResult> = { keyId, directoryUrl, params: p };

  if (
    !push("tag", p["tag"] === "web-bot-auth", `tag=${p["tag"] ?? "(absent)"}`)
  )
    return result("malformed", base);
  if (
    p["alg"] !== undefined &&
    !push("alg", p["alg"] === "ed25519", `alg=${p["alg"]}`)
  )
    return result("malformed", base);
  if (
    !push(
      "keyid_present",
      keyId !== null && keyId.length > 0,
      keyId ? undefined : "keyid missing",
    )
  )
    return result("malformed", base);
  if (
    !push(
      "covers_signature_agent",
      parsed.components.includes("signature-agent"),
      "WBA requires signature-agent in the covered components",
    )
  )
    return result("malformed", base);

  let jwks: unknown;
  try {
    jwks = await deps.fetchDirectory(directoryUrl);
  } catch (error) {
    push("directory_fetch", false, (error as Error).message);
    return result("directory_unreachable", base);
  }
  const keys = Array.isArray((jwks as { keys?: unknown[] } | null)?.keys)
    ? ((jwks as { keys: unknown[] }).keys as Array<{
        kty?: string;
        crv?: string;
        x?: string;
      }>)
    : [];
  push("directory_fetch", true, `${keys.length} key(s)`);

  let jwk: { kty: string; crv: string; x: string } | null = null;
  for (const k of keys) {
    if (k?.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string") {
      const candidate = { kty: k.kty, crv: k.crv, x: k.x };
      if ((await ed25519Thumbprint(candidate)) === keyId) {
        jwk = candidate;
        break;
      }
    }
  }
  if (
    !push(
      "key_in_directory",
      jwk !== null,
      jwk ? `thumbprint=${keyId}` : `no Ed25519 key with thumbprint ${keyId}`,
    )
  )
    return result("unknown_key", base);
  const found = jwk as { kty: string; crv: string; x: string };
  base.agentKey = found.x;

  // Crypto before time: only a signature that actually verifies may be called
  // stale — a tampered one is invalid regardless of timestamps (IV.13).
  let valid: boolean;
  try {
    const sigBase = buildSignatureBase(parsed, {
      authority: input.authority,
      signatureAgent: input.signatureAgent,
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
    });
    valid = await verify(sigBytes, sigBase, fromBase64Url(found.x));
  } catch (error) {
    push("signature", false, (error as Error).message);
    return result("malformed", base);
  }
  if (
    !push(
      "signature",
      valid,
      valid
        ? "Ed25519 signature verifies"
        : "Ed25519 signature does NOT verify",
    )
  )
    return result("invalid_signature", base);

  const nowS = options.nowS ?? Math.floor(Date.now() / 1000);
  const skewS = options.skewToleranceS ?? DEFAULT_SKEW_S;
  if (
    typeof p["expires"] === "number" &&
    !push(
      "not_expired",
      nowS <= p["expires"] + skewS,
      `expires=${p["expires"]} now=${nowS}`,
    )
  )
    return result("stale", base);
  if (
    typeof p["created"] === "number" &&
    !push(
      "created_sane",
      p["created"] <= nowS + skewS,
      `created=${p["created"]} now=${nowS}`,
    )
  )
    return result("stale", base);

  return result("verified", base);
}
