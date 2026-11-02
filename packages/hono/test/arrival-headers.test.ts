// A001 drift guard: the header names requestFromContext reads must be exactly
// core's REQUEST_HEADERS_READ (which the arrival reading has one row for). A
// header added to the parser without a row in the reading fails here.
import { readFileSync } from "node:fs";
import { REQUEST_HEADERS_READ } from "@tollbooth/core";
import { expect, it } from "vitest";

it("requestFromContext reads exactly REQUEST_HEADERS_READ", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("function requestFromContext(");
  const end = src.indexOf("\nfunction ", start + 1);
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, end);
  const read = new Set(
    [...body.matchAll(/header\("([a-z-]+)"\)/g)].map((m) => m[1]),
  );
  expect([...read].sort()).toEqual([...REQUEST_HEADERS_READ].sort());
});
