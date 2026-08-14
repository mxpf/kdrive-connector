import assert from "node:assert/strict";
import test from "node:test";
import { validateName } from "../src/safety.js";

test("names reject ambiguous and oversized values", () => {
  assert.equal(validateName("  Report.pdf  "), "Report.pdf");
  assert.throws(() => validateName(".."));
  assert.throws(() => validateName("x".repeat(256)));
});
