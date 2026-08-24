import { describe, expect, it } from "vitest";
import { OfferLedger } from "../src/ledger.js";

describe("D-3 offer ledger", () => {
  it("counts offers and resets the window when it expires", () => {
    const ledger = new OfferLedger(10);
    ledger.recordOffer("k", 0, 1000);
    ledger.recordOffer("k", 500, 1000);
    expect(ledger.get("k")).toMatchObject({
      offersSent: 2,
      offersInWindow: 2,
      firstSeen: 0,
    });
    ledger.recordOffer("k", 2000, 1000);
    expect(ledger.get("k")).toMatchObject({
      offersSent: 3,
      offersInWindow: 1,
      windowStart: 2000,
    });
  });

  it("records paid_ever without disturbing counts", () => {
    const ledger = new OfferLedger(10);
    ledger.recordOffer("k", 0, 1000);
    ledger.recordPaid("k", 10);
    expect(ledger.get("k")).toMatchObject({
      offersSent: 1,
      paidEver: true,
      lastSeen: 10,
    });
  });

  it("evicts the least recently used at capacity - amnesty, not an error", () => {
    const ledger = new OfferLedger(2);
    ledger.recordOffer("a", 0, 1000);
    ledger.recordOffer("b", 1, 1000);
    ledger.recordOffer("a", 2, 1000); // refresh a
    ledger.recordOffer("c", 3, 1000); // evicts b, the least recent
    expect(ledger.get("b")).toBeUndefined();
    expect(ledger.get("a")?.offersSent).toBe(2);
    expect(ledger.size).toBe(2);
  });
});
