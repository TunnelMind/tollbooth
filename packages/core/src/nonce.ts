// SPDX-License-Identifier: MIT
// WBA replay refusal for signatures that carry the optional RFC 9421 `nonce`
// parameter. Same shape and stance as JtiCache: bounded LRU, eviction is
// amnesty, per-instance only (instances share nothing, D-2). Keys include the
// authority, so "per authority" is in the key while the cap bounds memory.

export class NonceCache {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries: number) {}

  /** Record `key`; true if it was already present (a replay). */
  seenBefore(key: string): boolean {
    const replay = this.seen.delete(key);
    if (!replay && this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(key);
    return replay;
  }

  get size(): number {
    return this.seen.size;
  }
}
