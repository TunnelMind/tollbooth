// SPDX-License-Identifier: MIT
// RFC 8785 (JCS) canonicalizer, ported from the estate's proven
// implementation (tunnelmind-data-api api/utils/jcs.js, byte-for-byte via
// oai-resolver src/rune.js, cross-checked there against Rust's
// serde_json_canonicalizer). Receipts are signed over this form, so any
// behavioral change is a signature break.

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
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const esc = ESC[ch];
    if (esc !== undefined) out += esc;
    else if (s.charCodeAt(i) < 0x20)
      out += `\\u${s.charCodeAt(i).toString(16).padStart(4, "0")}`;
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
