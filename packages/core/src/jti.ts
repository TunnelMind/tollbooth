// SPDX-License-Identifier: MIT
// AC-3.3: soft double-spend damping. Each signed voucher state has a unique
// jti (D-1 rotates it per re-sign), so counting spends per jti damps parallel
// replay of one state without ever limiting sequential spending. Bounded LRU;
// eviction is amnesty; per-instance only, and multi-instance operators share
// nothing (D-2) - this is soft enforcement (Article V.14), not a ledger.

export class JtiCache {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxEntries: number) {}

  /** Record one observed spend; true while this jti is within replay_window. */
  allow(jti: string, replayWindow: number): boolean {
    const seen = (this.counts.get(jti) ?? 0) + 1;
    this.counts.delete(jti);
    if (this.counts.size >= this.maxEntries) {
      const oldest = this.counts.keys().next().value;
      if (oldest !== undefined) this.counts.delete(oldest);
    }
    this.counts.set(jti, seen);
    return seen <= replayWindow;
  }

  get size(): number {
    return this.counts.size;
  }
}
