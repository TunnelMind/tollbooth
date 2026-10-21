// Shared WBA test fixtures: real Ed25519 keypairs signing real RFC 9421
// requests. Used by the core, hono and cloudflare suites.
import {
  generateSecretKey,
  publicKeyOf,
  sign,
  toBase64Url,
} from "../../src/keys.js";
import {
  buildSignatureBase,
  ed25519Thumbprint,
  parseSignatureInput,
} from "../../src/wba.js";

export interface TestAgent {
  secretKey: Uint8Array;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  keyid: string;
}

export async function makeAgent(): Promise<TestAgent> {
  const secretKey = generateSecretKey();
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: toBase64Url(await publicKeyOf(secretKey)),
  } as const;
  return { secretKey, jwk, keyid: await ed25519Thumbprint(jwk) };
}

/** Fixed epoch seconds, injected everywhere so tests are deterministic. */
export const NOW = 1_800_000_000;

export async function signedRequest(
  agent: TestAgent,
  {
    created = NOW,
    expires = NOW + 60,
    components = ["@authority", "signature-agent"],
    authority = "example.com",
    path,
    nonce,
  }: {
    created?: number;
    /** `null` omits the expires parameter entirely. */
    expires?: number | null;
    components?: string[];
    authority?: string;
    /** Signed over when components include "@path"; echoed in the result. */
    path?: string;
    /** Adds the optional RFC 9421 `nonce` parameter. */
    nonce?: string;
  } = {},
) {
  const signatureAgent = '"https://signature-agent.test"';
  const list = components.map((c) => `"${c}"`).join(" ");
  const exp = expires === null ? "" : `;expires=${expires}`;
  const inner = `(${list});created=${created}${exp};keyid="${agent.keyid}";alg="ed25519"${nonce === undefined ? "" : `;nonce="${nonce}"`};tag="web-bot-auth"`;
  const signatureInput = `sig2=${inner}`;
  const base = buildSignatureBase(parseSignatureInput(signatureInput), {
    authority,
    signatureAgent,
    ...(path !== undefined ? { path } : {}),
  });
  const sig = await sign(base, agent.secretKey);
  let b64 = "";
  for (const byte of sig) b64 += String.fromCharCode(byte);
  return {
    signature: `sig2=:${btoa(b64)}:`,
    signatureInput,
    signatureAgent,
    authority,
    ...(path !== undefined ? { path } : {}),
  };
}

export const dirWith =
  (...keys: unknown[]) =>
  async () => ({ keys });
