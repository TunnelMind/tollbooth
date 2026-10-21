// SPDX-License-Identifier: MIT
// The corpus generator lives in @tollbooth/maze since 2026-10-20; these
// re-exports keep @tollbooth/cli's API (cloudflare, hono tests import it here).
export type { CorpusOptions } from "@tollbooth/maze";
export { corpusHash, generateCorpus } from "@tollbooth/maze";
