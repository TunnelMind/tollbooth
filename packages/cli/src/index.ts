// SPDX-License-Identifier: MIT
// The corpus generator lives in @tunnelmindai/tollbooth-maze; these re-exports keep it in
// @tunnelmindai/tollbooth-cli's published API (nothing in the repo imports them from here:
// cloudflare and the hono tests take them from maze).
export type { CorpusOptions } from "@tunnelmindai/tollbooth-maze";
export { corpusHash, generateCorpus } from "@tunnelmindai/tollbooth-maze";
