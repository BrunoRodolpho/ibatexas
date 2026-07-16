// read-tool-corpus/__tests__/load.test.ts — YAML loader roundtrip + a load
// of the REAL committed FE-T13 corpus, mirroring
// ../../extraction/__tests__/load.test.ts's pattern for the sibling format.

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { loadReadToolCorpus, ReadToolCorpusLoadError, DEFAULT_READ_TOOL_CORPUS_DIR } from "../load.js"

const VALID_YAML = `
tool: check_availability
source: tickets/language-engine/issues/13-rollout-status-read-verbs.md
cases:
  - id: four-people
    utterance: tem mesa pra 4 pessoas dia 2026-07-18?
    expectArgs:
      date: "2026-07-18"
      partySize: 4
`

describe("loadReadToolCorpus — roundtrip over a temp dir", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ibx-read-tool-corpus-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("loads a valid file and preserves case ordering", async () => {
    await writeFile(join(dir, "check_availability.yaml"), VALID_YAML)
    const files = await loadReadToolCorpus(dir)
    expect(files).toHaveLength(1)
    expect(files[0]!.tool).toBe("check_availability")
    expect(files[0]!.cases[0]!.expectArgs).toEqual({ date: "2026-07-18", partySize: 4 })
  })

  it("throws ReadToolCorpusLoadError on a duplicate case id within one file", async () => {
    const dup = VALID_YAML.replace(
      "cases:\n  - id: four-people",
      "cases:\n  - id: four-people\n    utterance: x\n    expectArgs: {}\n  - id: four-people",
    )
    await writeFile(join(dir, "check_availability.yaml"), dup)
    await expect(loadReadToolCorpus(dir)).rejects.toThrow(ReadToolCorpusLoadError)
  })

  it("accepts expectArgs: null (the sound-abstention case)", async () => {
    const withNull = `
tool: get_also_added
source: tickets/language-engine/issues/13-rollout-status-read-verbs.md
cases:
  - id: no-context-abstains
    utterance: o que combina com o que eu pedi?
    expectArgs: null
`
    await writeFile(join(dir, "get_also_added.yaml"), withNull)
    const files = await loadReadToolCorpus(dir)
    expect(files[0]!.cases[0]!.expectArgs).toBeNull()
  })

  it("DEFAULT_READ_TOOL_CORPUS_DIR resolves to packages/journeys/read-tool-corpus", () => {
    expect(
      DEFAULT_READ_TOOL_CORPUS_DIR.replace(/\/$/, "").endsWith("packages/journeys/read-tool-corpus"),
    ).toBe(true)
  })
})

// The exact 12-name chat-plane read-tool roster (apps/api/src/claustrum/
// language-engine/read-tool-schemas.ts's READ_TOOL_AUTHORED_SCHEMAS) and,
// for the 5 field-bearing tools, their exact declared field names — a small,
// stable, closed vocabulary DUPLICATED here (not imported: this package is
// TEST-PLANE ONLY and never imports apps/api, check-bypass leg 7), same
// justification field-trust.ts's own duplication note in ../../extraction/
// schema.ts gives for FieldTrustSchema.
const KNOWN_READ_TOOLS = new Set([
  "get_cart",
  "get_order_history",
  "check_order_status",
  "get_recommendations",
  "get_also_added",
  "get_ordered_together",
  "get_payment_status",
  "get_payment_history",
  "check_availability",
  "get_my_reservations",
  "get_my_profile",
  "get_my_preferences",
])

const FIELD_NAMES_BY_TOOL: Readonly<Record<string, ReadonlySet<string>>> = {
  check_availability: new Set(["date", "partySize", "preferredTime"]),
  get_recommendations: new Set(["context"]),
  get_also_added: new Set(["productId"]),
  get_ordered_together: new Set(["productId"]),
  get_my_reservations: new Set(["status"]),
}

describe("loadReadToolCorpus — the REAL committed FE-T13 corpus", () => {
  it("loads every committed file without errors", async () => {
    const files = await loadReadToolCorpus()
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const file of files) {
      expect(KNOWN_READ_TOOLS.has(file.tool), `unknown read tool "${file.tool}"`).toBe(true)
    }
  })

  it("covers all 5 field-bearing read tools (the other 7 have no field to calibrate — see the FE-T13 coverage report)", async () => {
    const files = await loadReadToolCorpus()
    const covered = new Set(files.map((f) => f.tool))
    for (const tool of Object.keys(FIELD_NAMES_BY_TOOL)) {
      expect(covered.has(tool), `missing corpus for field-bearing tool "${tool}"`).toBe(true)
    }
  })

  it("every case's expectArgs keys are declared fields of its tool's schema — no stray/typo'd arg name", async () => {
    const files = await loadReadToolCorpus()
    for (const file of files) {
      const declared = FIELD_NAMES_BY_TOOL[file.tool]
      if (declared === undefined) continue // zero-field tool: expectArgs must always be {}
      for (const kase of file.cases) {
        if (kase.expectArgs === null) continue // sound-abstention case — nothing to check
        for (const key of Object.keys(kase.expectArgs)) {
          expect(
            declared.has(key),
            `${file.tool}:${kase.id} — expectArgs key "${key}" is not a declared field`,
          ).toBe(true)
        }
      }
    }
  })

  it("each field-bearing corpus has a real phrasing-diversity sample (>= 8 cases)", async () => {
    const files = await loadReadToolCorpus()
    for (const file of files) {
      if (FIELD_NAMES_BY_TOOL[file.tool] === undefined) continue
      expect(file.cases.length, `${file.tool}: expected >= 8 cases`).toBeGreaterThanOrEqual(8)
    }
  })
})
