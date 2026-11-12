import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ignores both the new and the legacy site key file", () => {
  const lines = readFileSync(
    new URL("../../../.gitignore", import.meta.url),
    "utf8",
  ).split("\n");
  expect(lines).toContain("fareseal.key");
  expect(lines).toContain("tollbooth.key");
});
