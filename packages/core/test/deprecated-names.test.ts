import { expect, it } from "vitest";
import {
  type FaresealConfig,
  parseConfig,
  type TollboothConfig,
} from "../src/index.js";

// Type-level: the deprecated name and the new one are the same type, both
// ways. `tsc -p tsconfig.tests.json` is what proves it.
it("TollboothConfig and FaresealConfig are interchangeable", () => {
  const a: TollboothConfig = parseConfig(`mode = "observe"`);
  const b: FaresealConfig = a;
  const c: TollboothConfig = b;
  expect(b).toBe(a);
  expect(c).toBe(a);
});
