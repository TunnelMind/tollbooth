// SPDX-License-Identifier: MIT
// The corpus generator lives in @tunnelmindai/fareseal-maze; these re-exports keep it in
// @tunnelmindai/fareseal-cli's published API (nothing in the repo imports them from here:
// cloudflare and the hono tests take them from maze).
export type { CorpusOptions } from "@tunnelmindai/fareseal-maze";
export { corpusHash, generateCorpus } from "@tunnelmindai/fareseal-maze";
