// SPDX-License-Identifier: MIT
// D-3: the offer-state ledger. A bounded LRU map agent_key -> state; when
// full, the least recently seen key is evicted and its history forgotten.
// Eviction is amnesty, never an error - a database is not (Articles I, V).
// Keyed by VERIFIED agent key only; anonymous traffic is never ledgered
// (spec sec 8 honest limit).

export interface OfferState {
  offersSent: number;
  offersInWindow: number;
  /** R-O3: held early-payment repeats in the same window as the offers. */
  heldInWindow: number;
  windowStart: number;
  firstSeen: number;
  lastSeen: number;
  paidEver: boolean;
}

export class OfferLedger {
  private readonly map = new Map<string, OfferState>();

  constructor(private readonly maxEntries: number) {}

  private touch(key: string, nowMs: number): OfferState {
    let state = this.map.get(key);
    if (state) {
      this.map.delete(key);
    } else {
      if (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
      state = {
        offersSent: 0,
        offersInWindow: 0,
        heldInWindow: 0,
        windowStart: nowMs,
        firstSeen: nowMs,
        lastSeen: nowMs,
        paidEver: false,
      };
    }
    state.lastSeen = nowMs;
    this.map.set(key, state);
    return state;
  }

  /** One window for both counts: when it expires, both start over. */
  private roll(state: OfferState, nowMs: number, windowMs: number): void {
    if (nowMs - state.windowStart > windowMs) {
      state.windowStart = nowMs;
      state.offersInWindow = 0;
      state.heldInWindow = 0;
    }
  }

  recordOffer(key: string, nowMs: number, windowMs: number): OfferState {
    const state = this.touch(key, nowMs);
    state.offersSent += 1;
    this.roll(state, nowMs, windowMs);
    state.offersInWindow += 1;
    return state;
  }

  /**
   * R-O3: counts a held early-payment repeat and returns the count in the
   * window. Records no offer; the pipeline decides when the repeats stop
   * being free.
   */
  recordHeld(key: string, nowMs: number, windowMs: number): number {
    const state = this.touch(key, nowMs);
    this.roll(state, nowMs, windowMs);
    state.heldInWindow += 1;
    return state.heldInWindow;
  }

  /**
   * Payment redeems (AC-4.4): besides marking paid_ever, it clears the
   * offer window, so a mazed key that pays starts with fresh grace - the
   * exit is always open.
   */
  recordPaid(key: string, nowMs: number): void {
    const state = this.touch(key, nowMs);
    state.paidEver = true;
    state.offersInWindow = 0;
    state.heldInWindow = 0;
    state.windowStart = nowMs;
  }

  /** AC-4.1: >= grace offers inside the still-open window. Never mutates. */
  exhausted(
    key: string,
    nowMs: number,
    windowMs: number,
    grace: number,
  ): boolean {
    const state = this.map.get(key);
    return (
      state !== undefined &&
      nowMs - state.windowStart <= windowMs &&
      state.offersInWindow >= grace
    );
  }

  /** Peek without refreshing recency. */
  get(key: string): OfferState | undefined {
    return this.map.get(key);
  }

  get size(): number {
    return this.map.size;
  }
}
