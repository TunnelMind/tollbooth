// SPDX-License-Identifier: MIT
// B009: CIDR membership for the vendored crawler ranges (botranges.data.ts).
// Stdlib only: addresses become bigints and a prefix is a masked compare.
export { botRanges } from "./botranges.data.js";

/** Parse an IPv4 or IPv6 literal to [value, bits]; null when malformed. */
function parseIp(ip: string): [bigint, 32 | 128] | null {
  if (!ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let v = 0n;
    for (const p of parts) {
      if (!/^[0-9]{1,3}$/.test(p) || Number(p) > 255) return null;
      v = (v << 8n) | BigInt(p);
    }
    return [v, 32];
  }
  let s = ip;
  // An embedded dotted tail (::ffff:1.2.3.4) becomes two hex groups.
  const dot = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseIp(s.slice(dot + 1));
    if (!v4) return null;
    s = `${s.slice(0, dot + 1)}${(v4[0] >> 16n).toString(16)}:${(v4[0] & 0xffffn).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [
    ...head,
    ...Array(halves.length === 2 ? fill : 0).fill("0"),
    ...tail,
  ];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(`0x${g}`);
  }
  return [v, 128];
}

/**
 * True when `ip` falls inside any "addr/len" CIDR in `ranges`. IPv4 and
 * IPv6 never match each other, except that an IPv4-mapped IPv6 address
 * (::ffff:a.b.c.d, what a dual-stack socket reports) is matched as IPv4.
 * Malformed input never matches.
 */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  let addr = parseIp(ip);
  if (addr?.[1] === 128 && addr[0] >> 32n === 0xffffn)
    addr = [addr[0] & 0xffffffffn, 32];
  if (!addr) return false;
  const [value, bits] = addr;
  return ranges.some((range) => {
    const [base, lenText] = range.split("/");
    const net = parseIp(base ?? "");
    if (!net || net[1] !== bits || !/^[0-9]{1,3}$/.test(lenText ?? ""))
      return false;
    const len = Number(lenText);
    if (len > bits) return false;
    const shift = BigInt(bits - len);
    return value >> shift === net[0] >> shift;
  });
}
