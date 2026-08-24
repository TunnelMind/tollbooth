import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("scaffold", () => {
  it("workspace resolves and tests run", () => {
    expect(PACKAGE_NAME).toBe("@tollbooth/core");
  });
});
