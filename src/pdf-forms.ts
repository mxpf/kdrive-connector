// PDF.js resolves inherited /V entries. Cross-check page widgets against the
// AcroForm tree; never promote orphan or contradictory widgets to verified data.
export type FormValue = string | string[] | number | boolean | null;
export interface PdfFormField {
  name: string; type: string; value: FormValue; status: "stored_value" | "review_required" | "redacted";
  checked?: boolean; exportValue?: string; issues: string[];
}
const scalar = (v: unknown): FormValue => v == null ? null : typeof v === "string" || typeof v === "boolean" || typeof v === "number" ? v
  : Array.isArray(v) && v.every(x => typeof x === "string") ? v : null;
// PDF.js exposes a single choice as a scalar in the field tree and as a
// one-element array on its widget. Normalize only choice fields for comparison;
// preserve the widget's selected-values array in the public result.
const same = (a: unknown, b: unknown, choice: boolean) => {
  const normalize = (v: unknown) => choice && typeof v === "string" ? [v] : scalar(v);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};
export function extractFormFields(annotations: any[], tree: Record<string, any[]> | null) {
  const fields: PdfFormField[] = [];
  for (const widget of annotations) {
    if (widget.subtype !== "Widget") continue;
    const name = typeof widget.fieldName === "string" ? widget.fieldName : "";
    const entries = tree && Object.prototype.hasOwnProperty.call(tree, name) && Array.isArray(tree[name]) ? tree[name] : [];
    const canonical = entries.find(entry => entry.id === widget.id);
    const issues: string[] = [];
    if (!name) issues.push("UNNAMED_FIELD");
    if (!canonical) issues.push("ORPHAN_WIDGET");
    const choice = widget.fieldType === "Ch";
    if (canonical && !same(canonical.value, widget.fieldValue, choice)) issues.push("TREE_WIDGET_VALUE_MISMATCH");
    const values = entries.filter(entry => "value" in entry);
    if (!widget.radioButton && values.some(entry => !same(entry.value, widget.fieldValue, choice))) issues.push("CONFLICTING_FIELD_VALUES");
    const supported = ["Tx", "Ch", "Btn"].includes(widget.fieldType) && !widget.pushButton;
    if (!supported) issues.push("UNSUPPORTED_FIELD_TYPE");
    if (widget.actions || canonical?.actions) issues.push("SCRIPTED_FIELD_NOT_EVALUATED");
    const password = widget.password || canonical?.password || (widget.fieldFlags & 8192) !== 0;
    const value = supported && !password ? scalar(widget.fieldValue) : null;
    if (widget.fieldValue != null && value === null && supported && !password) issues.push("UNSUPPORTED_FIELD_VALUE");
    const field: PdfFormField = {
      name, type: widget.fieldType ?? "unknown", value,
      status: password ? "redacted" : issues.length ? "review_required" : "stored_value", issues,
    };
    if (password) field.issues.push("PASSWORD_FIELD_REDACTED");
    if ((widget.checkBox || widget.radioButton) && typeof value === "string") {
      const exportValue = widget.exportValue ?? widget.buttonValue;
      if (typeof exportValue === "string") { field.exportValue = exportValue; field.checked = value === exportValue && value !== "Off"; }
      else issues.push("BUTTON_EXPORT_VALUE_UNAVAILABLE");
    }
    if (issues.length && !password) field.status = "review_required";
    fields.push(field);
  }
  return fields;
}
