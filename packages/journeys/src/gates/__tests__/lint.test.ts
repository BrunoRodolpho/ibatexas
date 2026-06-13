// Tests for gates/lint.ts — the roster gate behind `ibx journey lint`.
import { describe, it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { CHAT_DRIVABLE_TOOL_KINDS } from "@ibatexas/packs-composed"

import { validateJourney, type Journey } from "../../schema/index.js"
import { KNOWN_INVARIANT_IDS } from "../invariant-registry.js"
import {
  advertisedChatKinds,
  journeyPersonaContext,
  lintDigestLock,
  lintJourney,
  lintJourneys,
  verifyLintBaseline,
  STAFF_ROUTE_KINDS,
  type JourneyLintProblem,
} from "../lint.js"

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))

function codesByFile(problems: JourneyLintProblem[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const p of problems) {
    const list = map.get(p.file) ?? []
    list.push(p.code)
    map.set(p.file, list)
  }
  return map
}

/** Build a schema-valid Journey object for the pure lintJourney checks. */
function journeyOf(overrides: Record<string, unknown>): Journey {
  const result = validateJourney({
    id: "JOURNEY-999",
    title: "in-memory lint probe",
    businessCase: "lint unit test",
    persona: "Persona de teste.",
    channel: "web",
    acts: [{ kind: "chat", goal: "objetivo" }],
    expects: [],
    verify: [],
    status: "active",
    source: "lint.test.ts",
    ...overrides,
  })
  if (!result.ok) {
    throw new Error(
      `fixture doc must be schema-valid: ${JSON.stringify(result.errors)}`,
    )
  }
  return result.journey
}

describe("lintJourneys — good fixtures", () => {
  it("lints a clean registry green", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "good") })
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.journeys.map((j) => j.id)).toEqual([
      "JOURNEY-901",
      "JOURNEY-902",
    ])
    for (const entry of report.journeys) {
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("derives the persona context per journey", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "good") })
    const byId = new Map(report.journeys.map((j) => [j.id, j.personaContext]))
    expect(byId.get("JOURNEY-901")).toBe("authed-customer") // params.authenticated
    expect(byId.get("JOURNEY-902")).toBe("guest") // staff-http only
  })

  it("passes vacuously on an empty registry (zero journeys)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journeys-lint-empty-"))
    try {
      const report = await lintJourneys({ dir })
      expect(report.ok).toBe(true)
      expect(report.journeys).toEqual([])
      expect(report.problems).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("fails closed when the registry dir is unreadable", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "no-such-dir") })
    expect(report.ok).toBe(false)
    expect(report.problems.map((p) => p.code)).toEqual(["registry_unreadable"])
  })
})

describe("lintJourneys — bad fixtures", () => {
  it("reports every expected problem code per file", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "bad") })
    expect(report.ok).toBe(false)

    const codes = codesByFile(report.problems)
    expect(codes.get("journey-910-unknown-kind.yaml")).toEqual([
      "unknown_intent_kind",
    ])
    expect(codes.get("journey-911-chat-unadvertised.yaml")).toEqual([
      "expectation_unreachable",
    ])
    expect(codes.get("journey-912-unknown-invariant.yaml")).toEqual([
      "unknown_invariant",
    ])
    expect(codes.get("journey-913-bad-surfaces.yaml")?.sort()).toEqual([
      "invalid_http_path",
      "unsupported_channel",
    ])
    // Check 6 — schema rules re-surfaced at lint altitude, not thrown.
    expect(codes.get("journey-914-raw-medusa-id.yaml")).toEqual([
      "raw_medusa_id",
    ])
  })

  it("a schema-invalid file never lands in the journeys list", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "bad") })
    expect(report.journeys.map((j) => j.id)).not.toContain("JOURNEY-914")
    // …but the schema-valid (lint-failing) ones do, with digests.
    expect(report.journeys.map((j) => j.id)).toContain("JOURNEY-910")
  })

  it("rejects duplicate journey ids across files", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "bad-dup") })
    expect(report.ok).toBe(false)
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toMatchObject({
      code: "duplicate_journey_id",
      file: "journey-920-second.yaml",
      journeyId: "JOURNEY-920",
    })
  })
})

describe("persona contexts + advertised surface (DR-5)", () => {
  it("order.checkout.create is advertised to authed customers, never to guests", () => {
    expect(advertisedChatKinds("authed-customer").has("order.checkout.create")).toBe(true)
    expect(advertisedChatKinds("guest").has("order.checkout.create")).toBe(false)
  })

  it("staff-route kinds are never chat-advertised in either persona context", () => {
    for (const kind of STAFF_ROUTE_KINDS) {
      expect(advertisedChatKinds("authed-customer").has(kind)).toBe(false)
      expect(advertisedChatKinds("guest").has(kind)).toBe(false)
      expect(CHAT_DRIVABLE_TOOL_KINDS).not.toContain(kind)
    }
  })

  it("an http act asRole=customer also marks the journey authenticated", () => {
    const journey = journeyOf({
      acts: [
        { kind: "chat", goal: "objetivo" },
        { kind: "http", method: "GET", path: "/api/me", asRole: "customer" },
      ],
    })
    expect(journeyPersonaContext(journey)).toBe("authed-customer")
  })

  it("defaults to guest without an authentication marker", () => {
    expect(journeyPersonaContext(journeyOf({}))).toBe("guest")
  })
})

describe("lintJourney — expectation reachability (checks 2 + 3)", () => {
  it("staff-http journeys cannot expect non-staff-route kinds", () => {
    const journey = journeyOf({
      acts: [
        {
          kind: "http",
          method: "POST",
          path: "/api/admin/reservations/checkin",
          asRole: "staff",
        },
      ],
      expects: [{ intentKind: "order.item.add", decision: "EXECUTE" }],
    })
    const problems = lintJourney(journey, "in-memory.yaml")
    expect(problems.map((p) => p.code)).toEqual(["expectation_unreachable"])
  })

  it("fixture-only journeys cannot expect anything (preconditions produce no envelopes)", () => {
    const journey = journeyOf({
      acts: [{ kind: "fixture", seed: "seedCustomer" }],
      expects: [{ intentKind: "order.item.add", decision: "EXECUTE" }],
    })
    const problems = lintJourney(journey, "in-memory.yaml")
    expect(problems.map((p) => p.code)).toEqual(["expectation_unreachable"])
  })

  it("a customer http act keeps the http surface open in v1", () => {
    // Public (non-staff) envelope routes are not statically enumerable yet —
    // the Phase-1b reconciliation gate owns the runtime truth (documented
    // v1 shallowness).
    const journey = journeyOf({
      acts: [
        { kind: "http", method: "POST", path: "/api/orders/intent", asRole: "customer" },
      ],
      expects: [{ intentKind: "order.cancel.system", decision: "REFUSE" }],
    })
    expect(lintJourney(journey, "in-memory.yaml")).toEqual([])
  })
})

describe("digest-lock + baseline verification (pack-bom idiom)", () => {
  it("locks every journey id to its content digest", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "good") })
    const lock = lintDigestLock(report)
    expect(Object.keys(lock).sort()).toEqual(["JOURNEY-901", "JOURNEY-902"])
    expect(verifyLintBaseline(report, lock)).toEqual([])
  })

  it("flags journeys missing from the baseline and diverging digests", async () => {
    const report = await lintJourneys({ dir: join(FIXTURES, "good") })
    const lock = lintDigestLock(report)

    const empty = verifyLintBaseline(report, {})
    expect(empty.map((m) => m.reason)).toEqual([
      "missing_in_baseline",
      "missing_in_baseline",
    ])

    const tampered = { ...lock, "JOURNEY-901": "0".repeat(64) }
    const mismatches = verifyLintBaseline(report, tampered)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toMatchObject({
      journeyId: "JOURNEY-901",
      reason: "digest_mismatch",
    })
  })

  it("an empty registry verifies vacuously against the committed empty baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journeys-lint-empty-"))
    try {
      const report = await lintJourneys({ dir })
      expect(verifyLintBaseline(report, {})).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("invariant registry", () => {
  it("knows the placeholder goal-state invariants the fixtures use", () => {
    for (const id of ["order.goal-state", "reservation.goal-state", "cart.goal-state", "audit.refusal-basis"]) {
      expect(KNOWN_INVARIANT_IDS.has(id)).toBe(true)
    }
    expect(KNOWN_INVARIANT_IDS.has("no.such.invariant")).toBe(false)
  })
})
