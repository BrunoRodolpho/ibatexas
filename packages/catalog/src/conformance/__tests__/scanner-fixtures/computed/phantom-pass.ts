// A SCANNER fixture, not a compiler pass (LE2-017).
//
// Declares a pass id properly, then builds its rule id by string
// CONCATENATION — a shape the rule-inventory scanner cannot statically
// resolve. It must THROW, naming file and line, rather than return an
// inventory missing that rule: a meta-gate that quietly finds no rules passes
// vacuously forever. Exercised by `../../meta-coverage.test.ts`.
//
// Nothing imports this at runtime; it exists to be parsed.

const PASS = "phantom-computed" as const

export function phantomDiagnostic(family: string): Record<string, string> {
  return {
    pass: PASS,
    rule: `phantom-${family}-rule`,
    severity: "error",
    object: "capability:phantom",
    field: "phantom",
    message: "A scanner fixture, never emitted by any pass.",
  }
}
