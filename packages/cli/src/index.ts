// SPDX-License-Identifier: MIT
// The corpus generator lives in @tollbooth/maze since 2026-10-20; these
// re-exports keep @tollbooth/cli's published API (nothing in the repo imports
// them any more: cloudflare and the hono tests take them from maze).
export type { CorpusOptions } from "@tollbooth/maze";
export { corpusHash, generateCorpus } from "@tollbooth/maze";
