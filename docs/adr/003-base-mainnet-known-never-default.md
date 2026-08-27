# ADR 003 — base mainnet is a known network, never a default

**Relates to:** Constitution V.15, plan D-7.

x402's whole point is real settlement, and operators who want it need the
mainnet EIP-712 asset domain to build a payable offer. Shipping only
base-sepolia forced every mainnet operator to patch the package.

**Decision:** the adapter's NETWORKS table carries `base` (Circle USDC,
chainId 8453, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, domain "USD
Coin"/v2) alongside `base-sepolia`. Knowing an address is not endorsing it.

V.15 is preserved by three invariants, each test-guarded:
- the config **default** network stays `base-sepolia`;
- every committed **example** uses `base-sepolia` and none names `base`;
- documentation continues to use testnet values.

An operator reaches mainnet only by writing `network = "base"` in their own
config — which is exactly "settlement configuration belongs to the operator."
No further mainnet (other chains) is added except by the same deliberate PR
this ADR models.
