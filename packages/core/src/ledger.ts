// D-3: the offer-state ledger. A bounded LRU map agent_key -> state; when
// full, the least recently seen key is evicted and its history forgotten.
// Eviction is amnesty, never an error - a database is not (Articles I, V).
// Keyed by VERIFIED agent key only; anonymous traffic is never ledgered
// (spec sec 8 honest limit).

export interface OfferState {
  offersSent: number;
  offersInWindow: number;
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

  recordOffer(key: string, nowMs: number, windowMs: number): OfferState {
    const state = this.touch(key, nowMs);
    state.offersSent += 1;
    if (nowMs - state.windowStart > windowMs) {
      state.windowStart = nowMs;
      state.offersInWindow = 0;
    }
    state.offersInWindow += 1;
    return state;
  }

  recordPaid(key: string, nowMs: number): void {
    this.touch(key, nowMs).paidEver = true;
  }

  /** Peek without refreshing recency. */
  get(key: string): OfferState | undefined {
    return this.map.get(key);
  }

  get size(): number {
    return this.map.size;
  }
}
