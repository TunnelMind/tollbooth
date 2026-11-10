import { expect, it } from "vitest";
import { fareseal, tollbooth } from "../src/index.js";

it("deprecated tollbooth is the same function as fareseal", () => {
  expect(tollbooth).toBe(fareseal);
});
