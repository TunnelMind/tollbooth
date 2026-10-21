// The frozen JCS wire vectors (test/vectors/jcs.json), byte-identical to
// receipt-verify's test/vectors/jcs.json (sha256 0798d3b0ba7af654f1c5e88a
// bb9b91dc3aca0692a9f716ae7bf5bd17b6f64d19); atap carries the same copy.
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
