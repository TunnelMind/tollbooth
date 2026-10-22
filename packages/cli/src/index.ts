// SPDX-License-Identifier: MIT
// The corpus generator lives in @tollbooth/maze; these re-exports keep it in
// @tollbooth/cli's published API (nothing in the repo imports them from here:
// cloudflare and the hono tests take them from maze).
export type { CorpusOptions } from "@tollbooth/maze";
export { corpusHash, generateCorpus } from "@tollbooth/maze";
