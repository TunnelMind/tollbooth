import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonicalize.js";

/** IEEE 754 double from its big-endian hex representation (RFC 8785 Appendix B). */
function hexToDouble(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

// Non-ASCII characters from the RFC examples, built from code points so
// the ASCII-only test source cannot be corrupted by encoding round-trips.
const EURO = String.fromCharCode(0x20ac);
const CONTROL_80 = String.fromCharCode(0x80);
const O_DIAERESIS = String.fromCharCode(0xf6);
const EMOJI = String.fromCharCode(0xd83d, 0xde00); // U+1F600 surrogate pair
const DALET_DAGESH = String.fromCharCode(0xfb33);

describe("RFC 8785 sec 3.2.3 - canonical form", () => {
  it("matches the RFC's worked example byte-for-byte", () => {
    const input = {
      numbers: [
        333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001,
      ],
      string: `${EURO}$\u000f\nA'B"\\\\"/`,
      literals: [null, true, false],
    };
    const expected =
      '{"literals":[null,true,false],' +
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      `"string":"${EURO}$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`;
    expect(canonicalize(input)).toBe(expected);
  });

  it("sorts keys by UTF-16 code units (surrogates sort before U+FB33)", () => {
    const input = {
      [EURO]: "Euro Sign",
      "\r": "Carriage Return",
      [DALET_DAGESH]: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      [EMOJI]: "Emoji: Grinning Face",
      [CONTROL_80]: "Control",
      [O_DIAERESIS]: "Latin Small Letter O With Diaeresis",
    };
    const expected =
      '{"\\r":"Carriage Return",' +
      '"1":"One",' +
      `"${CONTROL_80}":"Control",` +
      `"${O_DIAERESIS}":"Latin Small Letter O With Diaeresis",` +
      `"${EURO}":"Euro Sign",` +
      `"${EMOJI}":"Emoji: Grinning Face",` +
      `"${DALET_DAGESH}":"Hebrew Letter Dalet With Dagesh"}`;
    expect(canonicalize(input)).toBe(expected);
  });

  it("is stable under key insertion order", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
});

describe("RFC 8785 Appendix B - number serialization", () => {
  const vectors: Array<[string, string]> = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"], // minus zero
    ["0000000000000001", "5e-324"], // smallest subnormal
    ["7fefffffffffffff", "1.7976931348623157e+308"], // largest finite
    ["3ff0000000000000", "1"],
    ["400921fb54442d18", "3.141592653589793"],
    ["4340000000000000", "9007199254740994"], // 2^53
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
  ];
  for (const [hex, expected] of vectors) {
    it(`${hex} -> ${expected}`, () => {
      expect(canonicalize(hexToDouble(hex))).toBe(expected);
    });
  }

  it("throws on NaN and Infinity", () => {
    expect(() => canonicalize(hexToDouble("7ff8000000000000"))).toThrowError(
      /non-finite/,
    );
    expect(() => canonicalize(hexToDouble("7ff0000000000000"))).toThrowError(
      /non-finite/,
    );
  });
});

describe("estate-implementation parity", () => {
  it("drops undefined object properties (JSON.stringify parity)", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("throws on non-JSON types", () => {
    expect(() => canonicalize(undefined)).toThrowError(/unsupported/);
    expect(() => canonicalize(10n)).toThrowError(/unsupported/);
    expect(() => canonicalize([undefined])).toThrowError(/unsupported/);
  });
});
