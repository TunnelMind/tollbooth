// Cross-implementation check for the EIP-712 encoding: our adapter's digest
// must equal viem's (the ecosystem's canonical implementation) for the same
// TransferWithAuthorization, and an authorization signed by a real viem
// wallet must verify through verifyProof. This closes the v1.0.0 sweep
// doc's "round-trip tested only" limit: if our bytes matched only
// ourselves, this suite would fail.
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseConfig } from "@tollbooth/core";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  authorizationHash,
  encodePayment,
  NETWORKS,
  type TransferAuthorization,
  verifyProof,
} from "../src/index.js";

const NOW = 1_800_000_000;
const NET = NETWORKS["base-sepolia"];
if (!NET) throw new Error("base-sepolia missing from NETWORKS");

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const AUTH: TransferAuthorization = {
  from: account.address, // checksummed, as a real wallet supplies it
  to: "0x1111111111111111111111111111111111111111",
  value: "1000",
  validAfter: "0",
  validBefore: String(NOW + 600),
  nonce: `0x${"ab".repeat(32)}`,
};

const TYPED_DATA = {
  domain: {
    name: NET.assetName,
    version: NET.assetVersion,
    chainId: Number(NET.chainId),
    verifyingContract: NET.asset as `0x${string}`,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization" as const,
  message: {
    from: AUTH.from as `0x${string}`,
    to: AUTH.to as `0x${string}`,
    value: BigInt(AUTH.value),
    validAfter: BigInt(AUTH.validAfter),
    validBefore: BigInt(AUTH.validBefore),
    nonce: AUTH.nonce as `0x${string}`,
  },
};

describe("EIP-712 cross-implementation compatibility", () => {
  it("our digest equals viem's, byte for byte", () => {
    const ours = `0x${bytesToHex(authorizationHash("base-sepolia", AUTH))}`;
    expect(ours).toBe(hashTypedData(TYPED_DATA));
  });

  it("a viem-wallet-signed authorization passes verifyProof", async () => {
    const signature = await account.signTypedData(TYPED_DATA);
    const cfg = parseConfig(`
mode = "toll"
[toll.x402]
pay_to = "${AUTH.to}"
`);
    const header = encodePayment({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization: AUTH },
    });
    const result = verifyProof(header, cfg, { nowS: NOW });
    expect(result).toEqual({ ok: true, payer: account.address.toLowerCase() });
  });
});
