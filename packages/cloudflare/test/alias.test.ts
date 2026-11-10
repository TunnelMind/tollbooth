import { expect, it } from "vitest";
import {
  FaresealBindingMissingError,
  faresealEnvMarker,
  TollboothBindingMissingError,
  tollboothEnvMarker,
} from "../src/index.js";

it("deprecated names are the same objects as the new ones", () => {
  expect(TollboothBindingMissingError).toBe(FaresealBindingMissingError);
  expect(tollboothEnvMarker).toBe(faresealEnvMarker);
  const err = new TollboothBindingMissingError("X", []);
  expect(err).toBeInstanceOf(FaresealBindingMissingError);
  expect(err.name).toBe("FaresealBindingMissingError");
});
