# @tunnelmindai/fareseal-adapter-x402

x402 payment offers and local EIP-3009 proof verification for Fareseal.

`verifyProof` refuses an `X-PAYMENT` header longer than 8192 characters
(`MAX_X_PAYMENT_CHARS`) as `malformed`, before decoding it.

Part of [Fareseal](https://github.com/TunnelMind/tollbooth) - pay the toll or meet
the maze: self-hosted middleware that offers crawlers paid access, passes
humans untouched, and leaves offline-verifiable conduct receipts. The
[main README](https://github.com/TunnelMind/tollbooth#readme) has the full
story, quickstart and honest limits. MIT.
