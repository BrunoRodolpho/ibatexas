// The CONFORMANCE CORPUS — the registry the suite and the meta-gate read
// (LE2-017).
//
// One entry per rule id the compiler can emit, plus the clean controls. The
// meta-enforcement test (`../__tests__/meta-coverage.test.ts`) scans the
// compiler's own source for its registered passes and rule ids and FAILS when
// anything here is missing — so a later ticket's pass (boot reconciliation,
// the journey/compensation/lifecycle passes) cannot land without extending
// this array.
//
// Registration is deliberately one explicit line per fixture family: removing
// a fixture is a visible edit, and the meta-gate turns it into a named
// failure.

import { CLEAN_FIXTURES } from "./clean.js"
import { REFERENTIAL_INTEGRITY_FIXTURES } from "./referential-integrity.js"
import { SAFETY_IMPLICATION_EDGES_FIXTURES } from "./safety-implication-edges.js"
import { SLOT_DATAFLOW_FIXTURES } from "./slot-dataflow.js"
import { TERMINAL_COVERAGE_FIXTURES } from "./terminal-coverage.js"
import type { ConformanceFixture } from "../types.js"

/**
 * Every conformance fixture, in pass-registration order then rule order, with
 * the clean controls last. The order is the order the goldens are written and
 * the suite reports in; it carries no other contract.
 */
export const CONFORMANCE_FIXTURES: readonly ConformanceFixture[] = [
  ...REFERENTIAL_INTEGRITY_FIXTURES,
  ...SLOT_DATAFLOW_FIXTURES,
  ...SAFETY_IMPLICATION_EDGES_FIXTURES,
  ...TERMINAL_COVERAGE_FIXTURES,
  ...CLEAN_FIXTURES,
]

/** The fixtures that must FAIL to compile — everything with a target rule. */
export const REJECTION_FIXTURES: readonly ConformanceFixture[] =
  CONFORMANCE_FIXTURES.filter((f) => f.targets !== null)

/** The fixtures that must compile CLEAN. */
export const CLEAN_CONFORMANCE_FIXTURES: readonly ConformanceFixture[] =
  CONFORMANCE_FIXTURES.filter((f) => f.targets === null)
