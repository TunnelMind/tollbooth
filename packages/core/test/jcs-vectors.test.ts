// The frozen JCS wire vectors (test/vectors/jcs.json), byte-identical to
// receipt-verify's test/vectors/jcs.json (sha256 81a79410874c5ed24ea0468a
// 3d684e3a03111dc0a2fd2e8317ed3e3dfb978cdd); atap carries the same copy.
// A change starts there and is mirrored here; biome leaves the file unformatted.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonicalize.js";

type Vector = {
  name: string;
  input: unknown;
  canonical?: string;
  throws?: boolean;
};
const { vectors } = JSON.parse(
  readFileSync(new URL("./vectors/jcs.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };

describe("frozen JCS vectors shared with receipt-verify and atap", () => {
  for (const v of vectors) {
    it(v.name, () => {
      if (v.throws)
        expect(() => canonicalize(v.input)).toThrow(/lone surrogate/);
      else expect(canonicalize(v.input)).toBe(v.canonical);
    });
  }
});
