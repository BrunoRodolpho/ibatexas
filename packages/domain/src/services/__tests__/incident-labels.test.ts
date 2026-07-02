// incident-labels — canonical pt-BR label coverage over the frozen taxonomy.
//
// The incident-notification staff ping (and any other server consumer) renders
// cause/severity labels from the CANONICAL maps in incident-policy.ts rather
// than a private copy. This test pins the invariant the dedup depends on: every
// FROZEN_CAUSES value — explicitly including the wave-1 `pause_read_error` —
// resolves to a real pt-BR label, never a raw enum-key fallback.

import { describe, it, expect } from "vitest"
import {
  FROZEN_CAUSES,
  INCIDENT_CAUSE_LABELS_PT,
  INCIDENT_SEVERITY_LABELS_PT,
} from "../__shared__/incident-policy.js"

describe("incident cause labels — canonical pt-BR coverage", () => {
  it("every FROZEN_CAUSES value resolves to a non-raw pt-BR label", () => {
    for (const cause of FROZEN_CAUSES) {
      const label = INCIDENT_CAUSE_LABELS_PT[cause]
      expect(label, `no canonical label for cause '${cause}'`).toBeTruthy()
      // "non-raw" — the label must not just echo the enum key back.
      expect(label, `label for '${cause}' is the raw enum key`).not.toBe(cause)
    }
  })

  it("includes the wave-1 pause_read_error cause with a proper label", () => {
    expect(FROZEN_CAUSES).toContain("pause_read_error")
    const label = INCIDENT_CAUSE_LABELS_PT.pause_read_error
    expect(label).toBeTruthy()
    expect(label).not.toBe("pause_read_error")
  })

  it("has no label keys outside the frozen taxonomy", () => {
    for (const key of Object.keys(INCIDENT_CAUSE_LABELS_PT)) {
      expect(FROZEN_CAUSES as readonly string[]).toContain(key)
    }
  })
})

describe("incident severity labels — canonical pt-BR coverage", () => {
  it("labels every severity with a non-raw pt-BR string", () => {
    for (const severity of ["low", "medium", "high"] as const) {
      const label = INCIDENT_SEVERITY_LABELS_PT[severity]
      expect(label, `no canonical label for severity '${severity}'`).toBeTruthy()
      expect(label).not.toBe(severity)
    }
  })
})
