import assert from "node:assert/strict";
import test from "node:test";
import { prepareConfirmation, requireConfirmation, validateName } from "../src/safety.js";

test("confirmation phrases bind sensitive actions to exact targets", () => {
  assert.equal(prepareConfirmation("trash", { fileId: 42 }).confirmation, "CONFIRM TRASH 42");
  assert.equal(
    prepareConfirmation("rename", { fileId: 42, name: "Final draft.md" }).confirmation,
    'CONFIRM RENAME 42 TO "Final draft.md"',
  );
  assert.equal(
    prepareConfirmation("overwrite", { fileId: 42, etag: "0123456789abcdef" }).confirmation,
    "CONFIRM OVERWRITE 42 ETAG 0123456789abcdef",
  );
});

test("confirmation must match exactly", () => {
  assert.doesNotThrow(() => requireConfirmation("CONFIRM TRASH 42", "CONFIRM TRASH 42"));
  assert.throws(() => requireConfirmation("confirm trash 42", "CONFIRM TRASH 42"), /must explicitly provide/);
});

test("names reject ambiguous and oversized values", () => {
  assert.equal(validateName("  Report.pdf  "), "Report.pdf");
  assert.throws(() => validateName(".."));
  assert.throws(() => validateName("x".repeat(256)));
});
