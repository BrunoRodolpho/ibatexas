// A SCANNER fixture, not a compiler pass (LE2-017).
//
// Builds a diagnostic-shaped object with a rule id but declares no
// `const PASS = "<pass id>" as const`. The rule-inventory scanner must REFUSE
// this file rather than silently returning an inventory without it — a rule id
// the meta-gate cannot attribute to a pass is a rule id nothing can demand a
// fixture for. Exercised by `../../meta-coverage.test.ts`.
//
// Nothing imports this at runtime; it exists to be parsed.

export const phantomDiagnostic = {
  rule: "phantom-unattributed-rule",
  severity: "error",
  object: "capability:phantom",
  field: "phantom",
  message: "A scanner fixture, never emitted by any pass.",
}
