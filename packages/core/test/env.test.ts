// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";

const SUFFIXES = [
  "SITE_KEY",
  "SETTLE_TOKEN",
  "ENV",
  "FLUSH_INTERVAL_MS",
  "EXAMPLE_SERVE",
  "REPORT_TOKEN",
];

describe("readEnv — FARESEAL_ first, TOLLBOOTH_ fallback", () => {
  it.each(SUFFIXES)("%s: new name alone", (s) => {
    expect(readEnv({ [`FARESEAL_${s}`]: "n" }, s)).toBe("n");
  });
  it.each(SUFFIXES)("%s: old name alone", (s) => {
    expect(readEnv({ [`TOLLBOOTH_${s}`]: "o" }, s)).toBe("o");
  });
  it.each(SUFFIXES)("%s: both set, new wins", (s) => {
    expect(
      readEnv({ [`FARESEAL_${s}`]: "n", [`TOLLBOOTH_${s}`]: "o" }, s),
    ).toBe("n");
  });
  it.each(SUFFIXES)("%s: empty new falls back to old", (s) => {
    expect(
      readEnv({ [`FARESEAL_${s}`]: "  ", [`TOLLBOOTH_${s}`]: "o" }, s),
    ).toBe("o");
  });
  it("neither set, or non-string values, give empty string", () => {
    expect(readEnv({}, "SITE_KEY")).toBe("");
    expect(readEnv({ FARESEAL_SITE_KEY: 1 }, "SITE_KEY")).toBe("");
  });
  it("trims", () => {
    expect(readEnv({ FARESEAL_ENV: " x " }, "ENV")).toBe("x");
  });
});
