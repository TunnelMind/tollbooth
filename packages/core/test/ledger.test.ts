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

  // R-O3: held repeats are counted per key, in the offer window.
  it("recordHeld counts 1..n and records no offer", () => {
    const ledger = new OfferLedger(10);
    for (let n = 1; n <= 5; n++)
      expect(ledger.recordHeld("k", n, 1000)).toBe(n);
    expect(ledger.get("k")).toMatchObject({
      heldInWindow: 5,
      offersSent: 0,
      offersInWindow: 0,
    });
  });

  it("recordHeld rolls with the window like recordOffer", () => {
    const ledger = new OfferLedger(10);
    ledger.recordOffer("k", 0, 1000);
    ledger.recordHeld("k", 500, 1000);
    // Exactly windowMs old is still inside the window (the roll is `>`).
    expect(ledger.recordHeld("k", 1000, 1000)).toBe(2);
    expect(ledger.get("k")).toMatchObject({
      windowStart: 0,
      offersInWindow: 1,
    });
    // Past it: one shared window, so the offer count rolls too.
    expect(ledger.recordHeld("k", 1001, 1000)).toBe(1);
    expect(ledger.get("k")).toMatchObject({
      windowStart: 1001,
      offersInWindow: 0,
      heldInWindow: 1,
      offersSent: 1,
    });
  });

  it("recordOffer's window roll clears the held count", () => {
    const ledger = new OfferLedger(10);
    ledger.recordHeld("k", 0, 1000);
    ledger.recordOffer("k", 500, 1000);
    expect(ledger.get("k")?.heldInWindow).toBe(1);
    ledger.recordOffer("k", 2000, 1000);
    expect(ledger.get("k")).toMatchObject({
      heldInWindow: 0,
      windowStart: 2000,
    });
  });

  it("recordPaid resets the held count", () => {
    const ledger = new OfferLedger(10);
    for (let i = 0; i < 3; i++) ledger.recordHeld("k", i, 1000);
    ledger.recordPaid("k", 10);
    expect(ledger.get("k")?.heldInWindow).toBe(0);
    expect(ledger.recordHeld("k", 11, 1000)).toBe(1);
  });
});
