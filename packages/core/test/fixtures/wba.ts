// Shared WBA test fixtures: real Ed25519 keypairs signing real RFC 9421
// requests. Used by wba.test.ts and pipeline.test.ts.
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
  }: { created?: number; expires?: number } = {},
) {
  const signatureAgent = '"https://signature-agent.test"';
  const inner = `("@authority" "signature-agent");created=${created};expires=${expires};keyid="${agent.keyid}";alg="ed25519";tag="web-bot-auth"`;
  const signatureInput = `sig2=${inner}`;
  const base = buildSignatureBase(parseSignatureInput(signatureInput), {
    authority: "example.com",
    signatureAgent,
  });
  const sig = await sign(base, agent.secretKey);
  let b64 = "";
  for (const byte of sig) b64 += String.fromCharCode(byte);
  return {
    signature: `sig2=:${btoa(b64)}:`,
    signatureInput,
    signatureAgent,
    authority: "example.com",
  };
}

export const dirWith =
  (...keys: unknown[]) =>
  async () => ({ keys });
