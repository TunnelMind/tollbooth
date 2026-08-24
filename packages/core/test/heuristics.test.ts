import { describe, expect, it } from "vitest";
import { agentHeuristics } from "../src/heuristics.js";
import { AGENT_UAS, HUMAN_UAS } from "./fixtures/user-agents.js";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("D-4(c) heuristics - human fixtures all pass through", () => {
  for (const ua of HUMAN_UAS) {
    it(`human: ${ua.slice(0, 60)}...`, () => {
      // Browser navigation shape: Accept includes text/html.
      expect(
        agentHeuristics({
          userAgent: ua,
          accept: BROWSER_ACCEPT,
          hasCookies: false,
        }).agent,
      ).toBe(false);
      // Browser subresource/XHR shape: no text/html but Sec-Fetch-Site present.
      expect(
        agentHeuristics({
          userAgent: ua,
          accept: "*/*",
          hasCookies: false,
          secFetchSite: "same-origin",
        }).agent,
      ).toBe(false);
    });
  }
});

describe("D-4(c) heuristics - agent fixtures caught by UA rules alone", () => {
  for (const ua of AGENT_UAS) {
    it(`agent: ${ua.slice(0, 60)}...`, () => {
      // Browser-shaped headers on purpose: the UA rule alone must fire.
      const result = agentHeuristics({
        userAgent: ua,
        accept: BROWSER_ACCEPT,
        hasCookies: true,
      });
      expect(result.agent).toBe(true);
      expect(result.matched.length).toBeGreaterThan(0);
    });
  }
});

describe("D-4(c) heuristics - header rule", () => {
  it("fires when Accept lacks text/html with no cookies and no Sec-Fetch-Site", () => {
    const result = agentHeuristics({
      userAgent: "SomeClient/1.0",
      accept: "*/*",
      hasCookies: false,
    });
    expect(result.agent).toBe(true);
    expect(result.matched).toContain("accept-no-html");
  });

  it("fires when Accept is missing entirely", () => {
    expect(
      agentHeuristics({ userAgent: "SomeClient/1.0", hasCookies: false }).agent,
    ).toBe(true);
  });

  it("does not fire when Sec-Fetch-Site is present (browser subresource)", () => {
    expect(
      agentHeuristics({
        userAgent: "SomeClient/1.0",
        accept: "*/*",
        hasCookies: false,
        secFetchSite: "cross-site",
      }).agent,
    ).toBe(false);
  });

  it("does not fire when cookies are present", () => {
    expect(
      agentHeuristics({
        userAgent: "SomeClient/1.0",
        accept: "*/*",
        hasCookies: true,
      }).agent,
    ).toBe(false);
  });
});

describe("D-4(c) heuristics - facts for the observe report", () => {
  it("names every rule that matched", () => {
    const result = agentHeuristics({
      userAgent: "curl/8.7.1",
      accept: "*/*",
      hasCookies: false,
    });
    expect(result.matched).toContain("ua-prefix:curl/");
    expect(result.matched).toContain("accept-no-html");
  });

  it("classifies nothing on an empty result", () => {
    const result = agentHeuristics({
      userAgent: "",
      accept: BROWSER_ACCEPT,
      hasCookies: false,
    });
    expect(result).toEqual({ agent: false, matched: [] });
  });
});
