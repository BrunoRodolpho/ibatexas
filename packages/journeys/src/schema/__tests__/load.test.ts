// Tests for schema/load.ts — YAML loader roundtrip over a temp registry dir.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  loadJourneys,
  parseJourneyYaml,
  JourneyLoadError,
  DEFAULT_JOURNEYS_DIR,
} from "../load.js"

const VALID_YAML = `
id: JOURNEY-001
title: Authenticated customer places and cancels an order
businessCase: Checkout and cancel are the revenue-critical paths.
persona: Cliente autenticado que quer jantar costela no sábado.
channel: web
status: active
blocked_by: []
source: docs/agents/plan-v2.md §5 T1a-12
params:
  productHandle: costela-bovina-defumada
acts:
  - kind: fixture
    seed: seedCustomer
    params:
      phone: "+5511999990001"
  - kind: chat
    goal: Montar um pedido e finalizar o checkout.
  - kind: http
    method: GET
    path: /api/me
    asRole: customer
expects:
  - intentKind: order.checkout.create
    decision: EXECUTE
verify:
  - invariant: order.goal-state
    args:
      status: canceled
`

describe("parseJourneyYaml", () => {
  it("roundtrips a valid YAML document into a typed Journey", () => {
    const journey = parseJourneyYaml(VALID_YAML, "JOURNEY-001-place-and-cancel.yaml")
    expect(journey.id).toBe("JOURNEY-001")
    expect(journey.channel).toBe("web")
    expect(journey.acts[0]).toEqual({
      kind: "fixture",
      seed: "seedCustomer",
      params: { phone: "+5511999990001" },
    })
    expect(journey.expects).toEqual([
      { intentKind: "order.checkout.create", decision: "EXECUTE" },
    ])
    expect(journey.verify[0].invariant).toBe("order.goal-state")
  })

  it("throws JourneyLoadError naming the file on schema failure", () => {
    const bad = VALID_YAML.replace("decision: EXECUTE", "decision: ALLOW")
    let caught: unknown
    try {
      parseJourneyYaml(bad, "JOURNEY-001-bad.yaml")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(JourneyLoadError)
    const loadErr = caught as JourneyLoadError
    expect(loadErr.file).toBe("JOURNEY-001-bad.yaml")
    expect(loadErr.message).toContain("JOURNEY-001-bad.yaml")
    expect(loadErr.errors.map((e) => e.code)).toContain("invalid_decision")
  })

  it("throws JourneyLoadError on unparseable YAML", () => {
    expect(() => parseJourneyYaml("{ not: [valid", "broken.yaml")).toThrow(JourneyLoadError)
    expect(() => parseJourneyYaml("{ not: [valid", "broken.yaml")).toThrow(/yaml_parse_error/)
  })
})

describe("loadJourneys", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ibx-journeys-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("loads every *.yaml sorted by filename and skips the README", async () => {
    const second = VALID_YAML.replace("JOURNEY-001", "JOURNEY-002")
    await writeFile(join(dir, "JOURNEY-002-amend.yaml"), second)
    await writeFile(join(dir, "JOURNEY-001-place-and-cancel.yaml"), VALID_YAML)
    await writeFile(join(dir, "README.md"), "# not a journey")

    const journeys = await loadJourneys(dir)
    expect(journeys.map((j) => j.id)).toEqual(["JOURNEY-001", "JOURNEY-002"])
  })

  it("returns [] for an empty registry dir", async () => {
    await expect(loadJourneys(dir)).resolves.toEqual([])
  })

  it("rejects duplicate journey ids across files", async () => {
    await writeFile(join(dir, "JOURNEY-001-a.yaml"), VALID_YAML)
    await writeFile(join(dir, "JOURNEY-001-b.yaml"), VALID_YAML)
    await expect(loadJourneys(dir)).rejects.toThrow(/duplicate_journey_id/)
  })

  it("propagates schema failures naming the offending file", async () => {
    await writeFile(
      join(dir, "JOURNEY-009-bad.yaml"),
      VALID_YAML.replace("JOURNEY-001", "JOURNEY-9"),
    )
    await expect(loadJourneys(dir)).rejects.toThrow(/JOURNEY-009-bad\.yaml/)
  })

  it("throws a named error for an unreadable dir", async () => {
    await expect(loadJourneys(join(dir, "missing"))).rejects.toThrow(/journeys dir unreadable/)
  })

  it("default registry dir resolves to packages/journeys/journeys/", () => {
    expect(DEFAULT_JOURNEYS_DIR.replace(/\/$/, "").endsWith("packages/journeys/journeys")).toBe(
      true,
    )
  })

  it("loads the real registry home without errors (README-only until T1a-12)", async () => {
    // T1a-12 authors the real files; whatever is there must validate.
    const journeys = await loadJourneys()
    for (const j of journeys) expect(j.id).toMatch(/^JOURNEY-\d{3}$/)
  })
})
