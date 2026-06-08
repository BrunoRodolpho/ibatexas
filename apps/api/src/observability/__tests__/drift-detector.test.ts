/**
 * F3 — behavioral drift detector wiring.
 *
 * Validates the AuditRecord -> drift-dimension extraction + the fail-safe tee.
 * The detector internals are upstream-tested (@adjudicate/drift); this locks
 * (a) our dimension choice reads the right redacted fields, and (b) the
 * observe() tee never throws on a malformed record (hot-path safety).
 */

import { describe, expect, it } from "vitest";
import { createDriftDetector } from "@adjudicate/drift";
import type { AuditRecord } from "@adjudicate/core";
import {
  observeDriftRecord,
  __resetDriftDetectorForTest,
} from "../drift-detector.js";

const rec = (decisionKind: string): AuditRecord =>
  ({
    decision: { kind: decisionKind },
    envelope: { kind: "order.cart.ensure" },
    decision_basis: [{ category: "business" }],
  }) as unknown as AuditRecord;

describe("F3 drift detection", () => {
  it("fires a decision.kind alert when the recent window shifts off the baseline", () => {
    const det = createDriftDetector({
      baselineWindow: 10,
      recentWindow: 10,
      alertThreshold: 0.3,
      dimensions: ["decision.kind"],
    });
    // Baseline: all EXECUTE. Recent: all REFUSE → TVD = 1.0 > 0.3.
    for (let i = 0; i < 10; i++) det.observe(rec("EXECUTE"));
    for (let i = 0; i < 10; i++) det.observe(rec("REFUSE"));
    const alerts = det.evaluate();
    expect(alerts.some((a) => a.dimension === "decision.kind")).toBe(true);
  });

  it("does NOT alert when the distribution is stable", () => {
    const det = createDriftDetector({
      baselineWindow: 10,
      recentWindow: 10,
      alertThreshold: 0.3,
      dimensions: ["decision.kind"],
    });
    for (let i = 0; i < 20; i++) det.observe(rec("EXECUTE"));
    expect(det.evaluate().length).toBe(0);
  });

  it("the observe() tee never throws on a malformed/empty record", () => {
    __resetDriftDetectorForTest();
    expect(() => observeDriftRecord({} as unknown as AuditRecord)).not.toThrow();
    expect(() =>
      observeDriftRecord({ decision: {} } as unknown as AuditRecord),
    ).not.toThrow();
    __resetDriftDetectorForTest();
  });
});
