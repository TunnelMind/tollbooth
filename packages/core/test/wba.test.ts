import { describe, expect, it } from "vitest";
import {
  generateSecretKey,
  publicKeyOf,
  sign,
  toBase64Url,
} from "../src/keys.js";
import {
  buildSignatureBase,
  ed25519Thumbprint,
  parseSignature,
  parseSignatureAgent,
  parseSignatureInput,
  verifyWebBotAuth,
} from "../src/wba.js";

// ── helpers: a real Ed25519 keypair signing a real WBA request ──────────────

interface Agent {
  secretKey: Uint8Array;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  keyid: string;
}

async function makeAgent(): Promise<Agent> {
  const secretKey = generateSecretKey();
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: toBase64Url(await publicKeyOf(secretKey)),
  } as const;
  return { secretKey, jwk, keyid: await ed25519Thumbprint(jwk) };
}

const NOW = 1_800_000_000; // fixed epoch seconds; injected so tests are deterministic

async function signedRequest(
  agent: Agent,
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

const dirWith =
  (...keys: unknown[]) =>
  async () => ({ keys });

const at = (nowS: number) => ({ nowS });

// ── parsers ─────────────────────────────────────────────────────────────────

describe("RFC 9421 parsers", () => {
  it("parseSignatureInput extracts label, components, params, verbatim inner", () => {
    const p = parseSignatureInput(
      'sig2=("@authority" "signature-agent");created=1735689600;keyid="abc";alg="ed25519";expires=1735693200;tag="web-bot-auth"',
    );
    expect(p.label).toBe("sig2");
    expect(p.components).toEqual(["@authority", "signature-agent"]);
    expect(p.params["created"]).toBe(1735689600);
    expect(p.params["keyid"]).toBe("abc");
    expect(p.params["tag"]).toBe("web-bot-auth");
    expect(p.inner.startsWith('("@authority"')).toBe(true);
  });

  it("parseSignature requires matching label and :base64: form", () => {
    expect(() => parseSignature("sig1=:AAAA:", "sig2")).toThrow();
    expect(() => parseSignature("sig2=AAAA", "sig2")).toThrow();
    expect(parseSignature("sig2=:AAAA:", "sig2")).toHaveLength(3);
  });

  it("parseSignatureAgent enforces quoted https and returns the well-known URL", () => {
    expect(parseSignatureAgent('"https://signature-agent.test"')).toBe(
      "https://signature-agent.test/.well-known/http-message-signatures-directory",
    );
    expect(() => parseSignatureAgent("https://unquoted.test")).toThrow();
    expect(() => parseSignatureAgent('"http://insecure.test"')).toThrow();
  });

  it("buildSignatureBase rejects unsupported covered components", () => {
    const p = parseSignatureInput(
      'sig1=("@query-params");keyid="k";tag="web-bot-auth"',
    );
    expect(() =>
      buildSignatureBase(p, {
        authority: "x",
        signatureAgent: '"https://a.test"',
      }),
    ).toThrow(/unsupported covered component/);
  });

  it("thumbprint matches the RFC 8037 A.3 vector", async () => {
    const jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    };
    expect(await ed25519Thumbprint(jwk)).toBe(
      "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
    );
  });
});

// ── end-to-end verification ─────────────────────────────────────────────────

describe("verifyWebBotAuth", () => {
  it("verified: real signature against matching directory, agentKey exposed", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent);
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("verified");
    expect(res.keyId).toBe(agent.keyid);
    expect(res.agentKey).toBe(agent.jwk.x);
    expect(res.checks.every((c) => c.pass)).toBe(true);
  });

  it("invalid_signature: tampered authority", async () => {
    const agent = await makeAgent();
    const req = { ...(await signedRequest(agent)), authority: "evil.example" };
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("invalid_signature");
  });

  it("invalid_signature: tampered signature bytes", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent);
    req.signature = req.signature.replace(
      /=:(.)/,
      (_, c: string) => `=:${c === "A" ? "B" : "A"}`,
    );
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("invalid_signature");
  });

  it("stale: expired but cryptographically valid degrades to anonymous, not spoof (IV.13)", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent, { expires: NOW - 400 });
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("stale");
    expect(res.agentKey).toBe(agent.jwk.x);
  });

  it("stale: created beyond skew tolerance in the future", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent, {
      created: NOW + 400,
      expires: NOW + 800,
    });
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("stale");
  });

  it("verified: created in the future but within skew tolerance", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent, {
      created: NOW + 100,
      expires: NOW + 800,
    });
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("verified");
  });

  it("invalid_signature outranks stale: expired AND tampered is crypto-wrong", async () => {
    const agent = await makeAgent();
    const req = {
      ...(await signedRequest(agent, { expires: NOW - 400 })),
      authority: "evil.example",
    };
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(agent.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("invalid_signature");
  });

  it("unknown_key: directory lacks the signing key", async () => {
    const agent = await makeAgent();
    const other = await makeAgent();
    const req = await signedRequest(agent);
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: dirWith(other.jwk) },
      at(NOW),
    );
    expect(res.state).toBe("unknown_key");
  });

  it("unknown_key: garbage directory shape is treated as empty", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent);
    const res = await verifyWebBotAuth(
      req,
      { fetchDirectory: async () => "nope" },
      at(NOW),
    );
    expect(res.state).toBe("unknown_key");
  });

  it("directory_unreachable: fetch failure is a degraded fact, not a crash", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent);
    const res = await verifyWebBotAuth(
      req,
      {
        fetchDirectory: async () => {
          throw new Error("directory fetch 503");
        },
      },
      at(NOW),
    );
    expect(res.state).toBe("directory_unreachable");
  });

  it("malformed: wrong tag, and missing signature-agent coverage", async () => {
    const agent = await makeAgent();
    const req = await signedRequest(agent);
    const wrongTag = {
      ...req,
      signatureInput: req.signatureInput.replace("web-bot-auth", "other-tag"),
    };
    expect(
      (
        await verifyWebBotAuth(
          wrongTag,
          { fetchDirectory: dirWith(agent.jwk) },
          at(NOW),
        )
      ).state,
    ).toBe("malformed");
    const noSa = {
      ...req,
      signatureInput: `sig2=("@authority");created=${NOW};keyid="${agent.keyid}";tag="web-bot-auth"`,
    };
    expect(
      (
        await verifyWebBotAuth(
          noSa,
          { fetchDirectory: dirWith(agent.jwk) },
          at(NOW),
        )
      ).state,
    ).toBe("malformed");
  });

  it("malformed: garbage headers", async () => {
    const res = await verifyWebBotAuth(
      {
        signature: "??",
        signatureInput: "!!",
        signatureAgent: "nope",
        authority: "example.com",
      },
      { fetchDirectory: dirWith() },
      at(NOW),
    );
    expect(res.state).toBe("malformed");
  });
});
