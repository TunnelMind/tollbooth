import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("AC-1.3 - toll-mode cross-field validation", () => {
  it("rejects toll mode with no enabled payment option, naming toll", () => {
    expect(() =>
      parseConfig(`mode = "toll"\n[toll.x402]\nenabled = false`),
    ).toThrowError(/toll/);
  });

  it("rejects enabled x402 without pay_to", () => {
    expect(() => parseConfig(`mode = "toll"`)).toThrowError(
      /toll\.x402\.pay_to/,
    );
  });

  it("rejects enabled stripe without payment_link and webhook_secret, naming both", () => {
    let message = "";
    try {
      parseConfig(
        `mode = "toll"\n[toll.x402]\nenabled = false\n[toll.stripe]\nenabled = true`,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("toll.stripe.payment_link");
    expect(message).toContain("toll.stripe.webhook_secret");
  });

  it("observe mode needs no payment configuration at all", () => {
    expect(() => parseConfig("")).not.toThrow();
  });
});
