// examples/agent-client.ts - a minimal paying agent (AC-7.1): request, read
// the machine-readable 402 offer (AC-7.2), pay by voucher or x402, retry.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  authorizationHash,
  encodePayment,
  type TransferAuthorization,
  usdToAtomic,
} from "@tollbooth/adapter-x402";

type Creds = { voucher?: string; ethKeyHex?: string; fetchFn?: typeof fetch };
type Offer = {
  options: Array<{
    method: string;
    network?: string;
    pay_to?: string;
    price_usd?: string;
  }>;
};

const addr = (pub: Uint8Array) =>
  `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;

function signAuth(
  network: string,
  auth: TransferAuthorization,
  priv: Uint8Array,
): string {
  const digest = authorizationHash(network, auth);
  const rs = secp256k1.sign(digest, priv, { prehash: false });
  for (const rec of [0, 1]) {
    const sig = secp256k1.Signature.fromBytes(rs, "compact").addRecoveryBit(
      rec,
    );
    if (addr(sig.recoverPublicKey(digest).toBytes(false)) === auth.from)
      return `0x${bytesToHex(rs)}${(27 + rec).toString(16)}`;
  }
  throw new Error("recovery failed");
}

export async function fetchPaying(
  url: string,
  creds: Creds = {},
): Promise<Response> {
  const f = creds.fetchFn ?? fetch;
  const first = await f(url);
  if (first.status !== 402) return first;
  const offer = (await first.json()) as Offer;

  if (creds.voucher !== undefined)
    return f(url, { headers: { "tollbooth-voucher": creds.voucher } });

  const x = offer.options.find((o) => o.method === "x402");
  if (!x?.network || !x.pay_to || !x.price_usd || !creds.ethKeyHex)
    return first;

  const priv = hexToBytes(creds.ethKeyHex);
  const auth: TransferAuthorization = {
    from: addr(secp256k1.getPublicKey(priv, false)),
    to: x.pay_to,
    value: usdToAtomic(x.price_usd).toString(),
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`,
  };
  const payment = encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: x.network,
    payload: {
      signature: signAuth(x.network, auth, priv),
      authorization: auth,
    },
  });
  return f(url, { headers: { "x-payment": payment } });
}
