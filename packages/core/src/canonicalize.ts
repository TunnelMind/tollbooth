// SPDX-License-Identifier: MIT
// RFC 8785 (JCS) canonicalizer, ported from the estate's proven
// implementation (tunnelmind-data-api api/utils/jcs.js, byte-for-byte via
// oai-resolver src/rune.js, cross-checked there against Rust's
// serde_json_canonicalizer). Receipts and vouchers are signed over this form,
// so any behavioral change is a signature break; test/vectors/jcs.json (the
// estate's shared frozen vectors, vendored byte-for-byte from receipt-verify)
// pins the bytes. Input may be hostile (verifyReceipt canonicalizes what it
// was handed): throws on a lone surrogate, a non-finite number or a non-JSON
// type; verifyReceipt turns that throw into a failed check.

const ESC: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    // The iterator yields a valid pair as one code point > 0xFFFF, so a cp in
    // this range is a lone surrogate. TextEncoder would map it to U+FFFD and
    // two different strings would sign to the same bytes; refused, as
    // receipt-verify's jcs.ts does (the shared vectors pin it).
    if (cp >= 0xd800 && cp <= 0xdfff)
      throw new Error("JCS: lone surrogate in string");
    const esc = ESC[ch];
    if (esc !== undefined) out += esc;
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * RFC 8785 canonical JSON serialization. Undefined object properties are
 * dropped (JSON.stringify parity); non-finite numbers and non-JSON values
 * throw rather than serialize.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`JCS: non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${encodeString(k)}:${canonicalize(record[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}
