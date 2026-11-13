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
  // When each entry's held count began. Kept beside the entry, not in
  // OfferState (its exported shape is fixed by the spec's row T1); keyed by
  // the entry itself, so it goes when the entry is evicted.
  private readonly heldStart = new WeakMap<OfferState, number>();

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

  /**
   * An entry that only recordHeld has written. Before R-O3 a held repeat
   * wrote nothing, so such a key has no offer window yet: it is never
   * exhausted, and its first offer opens the window (second review H1).
   */
  private static heldOnly(state: OfferState): boolean {
    return state.offersSent === 0 && !state.paidEver;
  }

  /** One window for both counts: when it expires, both start over. */
  private roll(state: OfferState, nowMs: number, windowMs: number): void {
    if (nowMs - state.windowStart > windowMs) {
      state.windowStart = nowMs;
      state.offersInWindow = 0;
      state.heldInWindow = 0;
      this.heldStart.delete(state);
    }
  }

  recordOffer(key: string, nowMs: number, windowMs: number): OfferState {
    const state = this.touch(key, nowMs);
    // The first offer opens the window, as it would on a fresh entry.
    if (OfferLedger.heldOnly(state)) state.windowStart = nowMs;
    state.offersSent += 1;
    this.roll(state, nowMs, windowMs);
    state.offersInWindow += 1;
    return state;
  }

  /**
   * R-O3: counts a held early-payment repeat and returns the count in the
   * window. Records no offer; the pipeline decides when the repeats stop
   * being free.
   *
   * Second review H1: this must NOT roll. The offer window belongs to
   * recordOffer; restarting an expired one here moves where the next offers
   * are counted and changes who is mazed. The held count has its own window
   * of the same length, opened by the first held repeat, so old repeats
   * stop counting with time; it is also cleared when recordOffer rolls the
   * offer window, or on payment.
   */
  recordHeld(key: string, nowMs: number, windowMs: number): number {
    const state = this.touch(key, nowMs);
    const heldStart = this.heldStart.get(state);
    if (heldStart === undefined || nowMs - heldStart > windowMs) {
      this.heldStart.set(state, nowMs);
      state.heldInWindow = 0;
    }
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
    this.heldStart.delete(state);
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
      !OfferLedger.heldOnly(state) &&
      nowMs - state.windowStart <= windowMs &&
      state.offersInWindow >= grace
    );
  }

  /** Peek without refreshing recency. */
  get(key: string): OfferState | undefined {
    return this.map.get(key);
  }

  /**
   * Peek for readers that describe a key's offer window (the signed
   * receipt). A held-only entry has no offer window yet, so it reads as no
   * entry, as it did before recordHeld existed (review R005).
   */
  usableState(key: string): OfferState | undefined {
    const state = this.map.get(key);
    return state && !OfferLedger.heldOnly(state) ? state : undefined;
  }

  get size(): number {
    return this.map.size;
  }
}
