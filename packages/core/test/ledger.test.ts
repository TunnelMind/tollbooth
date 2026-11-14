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

  // Second review H1: this test used to pin the opposite ("recordHeld rolls
  // with the window like recordOffer"). A held repeat wrote nothing before
  // R-O3, so it must leave the offer window exactly where it was.
  it("recordHeld never rolls the offer window (H1)", () => {
    const ledger = new OfferLedger(10);
    ledger.recordOffer("k", 0, 1000);
    ledger.recordHeld("k", 500, 1000);
    expect(ledger.recordHeld("k", 1000, 1000)).toBe(2);
    const before = { ...ledger.get("k") };
    // The reviewer's case: the window (1000) expired long before t=1203.
    expect(ledger.recordHeld("k", 1203, 1000)).toBe(3);
    expect(ledger.get("k")).toMatchObject({
      windowStart: before.windowStart,
      offersInWindow: before.offersInWindow,
      offersSent: 1,
      heldInWindow: 3,
    });
    expect(before).toMatchObject({ windowStart: 0, offersInWindow: 1 });
  });

  // R001 attempt 2 (QA): the held count expires with its own window. Left to
  // pile up across an expired offer window, the 61st repeat overall recorded
  // an offer and the agent was mazed one request early. Expected values are
  // main's ledger on this schedule (main writes nothing for a held repeat).
  it("the held count expires with its own window, not the offer window", () => {
    const W = 600_000;
    const ledger = new OfferLedger(10);
    ledger.recordOffer("k", 0, W);
    for (let i = 0; i < 50; i++)
      expect(ledger.recordHeld("k", 1000 + i, W)).toBe(i + 1);
    // The held window opened at 1000; 700000 is past it, so the count restarts.
    for (let i = 0; i < 11; i++)
      expect(ledger.recordHeld("k", 700_000 + i, W)).toBe(i + 1);
    // None of that touched the offer window.
    expect(ledger.get("k")).toMatchObject({
      windowStart: 0,
      offersInWindow: 1,
      offersSent: 1,
    });
    // Main: three offers from 701000, the fourth request is exhausted.
    const answers: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      answers.push(ledger.exhausted("k", 701_000 + i, W, 3));
      if (!answers[i]) ledger.recordOffer("k", 701_000 + i, W);
    }
    expect(answers).toEqual([false, false, false, true]);
    expect(ledger.get("k")).toMatchObject({
      offersSent: 4,
      offersInWindow: 3,
      windowStart: 701_000,
    });
  });

  it("the held window edge: exactly windowMs old still counts, 1 ms more restarts", () => {
    const ledger = new OfferLedger(10);
    expect(ledger.recordHeld("k", 100, 1000)).toBe(1);
    expect(ledger.recordHeld("k", 1100, 1000)).toBe(2);
    expect(ledger.recordHeld("k", 1101, 1000)).toBe(1);
  });

  // H1 sweep: for every time across the window edge, the offer state is the
  // same whether or not a held repeat came in, before and after the next
  // offer, and so is the maze answer. `seeded` = the key had an offer at 0;
  // unseeded is the key whose only entry was made by recordHeld.
  it.each([true, false])(
    "recordHeld leaves offers alone at every t across the edge (seeded=%s)",
    (seeded) => {
      const W = 1000;
      const offers = (l: OfferLedger) => {
        const s = l.get("k");
        return s && [s.windowStart, s.offersInWindow, s.offersSent];
      };
      for (let t = 0; t <= 2500; t++) {
        const held = new OfferLedger(10);
        const plain = new OfferLedger(10);
        if (seeded) for (const l of [held, plain]) l.recordOffer("k", 0, W);
        held.recordHeld("k", t, W);
        if (seeded) expect(offers(held), `t=${t}`).toEqual(offers(plain));
        // grace 0 is the hardest case: any open window is exhausted.
        for (const grace of [0, 1])
          expect(held.exhausted("k", t, W, grace), `t=${t} g=${grace}`).toBe(
            plain.exhausted("k", t, W, grace),
          );
        for (const l of [held, plain]) l.recordOffer("k", t + 47, W);
        expect(offers(held), `t=${t} +offer`).toEqual(offers(plain));
        for (const probe of [t + 47, t + 47 + W, t + 48 + W])
          expect(held.exhausted("k", probe, W, 1), `t=${t} p=${probe}`).toBe(
            plain.exhausted("k", probe, W, 1),
          );
      }
    },
  );

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

  // R014 (second review 2, L3). The two tests above read only the count,
  // which is 0 after a roll or a payment whether or not the held window's
  // start was dropped too. A start that is carried over ends the next held
  // window early (more free held repeats). The end is only visible through
  // a later recordHeld: one that is inside the restarted window but more
  // than windowMs after the old start.
  it("recordOffer's window roll restarts the held window, it does not carry the old start over", () => {
    const ledger = new OfferLedger(10);
    ledger.recordOffer("k", 0, 1000);
    expect(ledger.recordHeld("k", 900, 1000)).toBe(1); // held window opens at 900
    ledger.recordOffer("k", 1500, 1000); // offer window rolls mid held-window
    expect(ledger.recordHeld("k", 1600, 1000)).toBe(1); // reopens at 1600
    // 2000 is 400 ms into the new held window and 1100 ms after the old start.
    expect(ledger.recordHeld("k", 2000, 1000)).toBe(2);
    expect(ledger.recordHeld("k", 2600, 1000)).toBe(3); // edge: 1600 + 1000
    expect(ledger.recordHeld("k", 2601, 1000)).toBe(1);
  });

  it("recordPaid clears the held window's start, not only its count", () => {
    const ledger = new OfferLedger(10);
    expect(ledger.recordHeld("k", 0, 1000)).toBe(1); // held window opens at 0
    ledger.recordPaid("k", 500);
    expect(ledger.recordHeld("k", 600, 1000)).toBe(1); // reopens at 600
    // 1100 is 500 ms into the new held window and 1100 ms after the old start.
    expect(ledger.recordHeld("k", 1100, 1000)).toBe(2);
    expect(ledger.recordHeld("k", 1600, 1000)).toBe(3); // edge: 600 + 1000
    expect(ledger.recordHeld("k", 1601, 1000)).toBe(1);
  });
});
