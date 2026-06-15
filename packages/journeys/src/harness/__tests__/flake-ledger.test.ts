// Tests for the T1b-4 flake ledger: pure outcome transitions (green deletes,
// yellow streaks → quarantine at 2 consecutive flaky nights, red no-ops,
// quarantined entries immutable to nightly outcomes), the manual
// de-quarantine refusals, and load/save round-trips (missing = empty,
// malformed = loud, stable key order on save).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  dequarantineJourney,
  emptyFlakeLedger,
  FLAKE_LEDGER_VERSION,
  FlakeLedgerError,
  flakeOwner,
  loadFlakeLedger,
  QUARANTINE_THRESHOLD,
  quarantinedJourneyIds,
  recordNightlyOutcome,
  saveFlakeLedger,
  type FlakeLedger,
} from "../flake-ledger.js"

function flakyLedger(overrides: Partial<FlakeLedger["journeys"][string]> = {}): FlakeLedger {
  return {
    version: FLAKE_LEDGER_VERSION,
    journeys: {
      "JOURNEY-001": {
        journey: "JOURNEY-001",
        firstSeen: "2026-06-10",
        owner: "",
        status: "flaky",
        consecutiveFlakyNights: 1,
        lastFlakyNight: "2026-06-10",
        ...overrides,
      },
    },
  }
}

describe("recordNightlyOutcome — the T1b-4 policy transitions", () => {
  it("green over an absent entry is a no-op", () => {
    const ledger = emptyFlakeLedger()
    const result = recordNightlyOutcome(ledger, "JOURNEY-001", "green", "2026-06-11")
    expect(result.changed).toBe(false)
    expect(result.ledger).toBe(ledger)
  })

  it("green DELETES a flaky entry (consecutive-by-construction)", () => {
    const result = recordNightlyOutcome(flakyLedger(), "JOURNEY-001", "green", "2026-06-11")
    expect(result.changed).toBe(true)
    expect(result.ledger.journeys["JOURNEY-001"]).toBeUndefined()
  })

  it("yellow creates a streak-1 flaky entry with firstSeen = tonight", () => {
    const result = recordNightlyOutcome(emptyFlakeLedger(), "JOURNEY-001", "yellow", "2026-06-11")
    expect(result.changed).toBe(true)
    expect(result.newlyQuarantined).toBe(false)
    expect(result.ledger.journeys["JOURNEY-001"]).toEqual({
      journey: "JOURNEY-001",
      firstSeen: "2026-06-11",
      owner: "",
      status: "flaky",
      consecutiveFlakyNights: 1,
      lastFlakyNight: "2026-06-11",
    })
  })

  it("same-night yellow repeat is idempotent (manual re-dispatch guard)", () => {
    const ledger = flakyLedger({ lastFlakyNight: "2026-06-11", firstSeen: "2026-06-11" })
    const result = recordNightlyOutcome(ledger, "JOURNEY-001", "yellow", "2026-06-11")
    expect(result.changed).toBe(false)
    expect(result.ledger).toBe(ledger)
  })

  it(`second consecutive flaky night QUARANTINES (threshold ${QUARANTINE_THRESHOLD})`, () => {
    const result = recordNightlyOutcome(flakyLedger(), "JOURNEY-001", "yellow", "2026-06-11")
    expect(result.changed).toBe(true)
    expect(result.newlyQuarantined).toBe(true)
    const entry = result.ledger.journeys["JOURNEY-001"]!
    expect(entry.status).toBe("quarantined")
    expect(entry.consecutiveFlakyNights).toBe(2)
    expect(entry.quarantinedAt).toBe("2026-06-11")
    // The streak start is preserved — the entry tells the whole story.
    expect(entry.firstSeen).toBe("2026-06-10")
  })

  it("red leaves the ledger untouched (issues, not quarantine, own hard failures)", () => {
    const ledger = flakyLedger()
    const result = recordNightlyOutcome(ledger, "JOURNEY-001", "red", "2026-06-11")
    expect(result.changed).toBe(false)
    expect(result.ledger).toBe(ledger)
    // ...also when no entry exists at all.
    const fresh = recordNightlyOutcome(emptyFlakeLedger(), "JOURNEY-002", "red", "2026-06-11")
    expect(fresh.changed).toBe(false)
  })

  it("quarantined entries are immutable to nightly outcomes (de-quarantine is manual)", () => {
    const ledger = flakyLedger({
      status: "quarantined",
      consecutiveFlakyNights: 2,
      quarantinedAt: "2026-06-10",
    })
    for (const outcome of ["green", "yellow", "red"] as const) {
      const result = recordNightlyOutcome(ledger, "JOURNEY-001", outcome, "2026-06-11")
      expect(result.changed).toBe(false)
      expect(result.ledger).toBe(ledger)
    }
  })

  it("rejects a non-ISO date loudly", () => {
    expect(() =>
      recordNightlyOutcome(emptyFlakeLedger(), "JOURNEY-001", "yellow", "11/06/2026"),
    ).toThrow(FlakeLedgerError)
  })
})

describe("dequarantineJourney — the manual green-twice flow", () => {
  it("removes a quarantined entry", () => {
    const ledger = flakyLedger({
      status: "quarantined",
      consecutiveFlakyNights: 2,
      quarantinedAt: "2026-06-11",
    })
    const next = dequarantineJourney(ledger, "JOURNEY-001")
    expect(next.journeys["JOURNEY-001"]).toBeUndefined()
  })

  it("refuses an unknown id (operator typo)", () => {
    expect(() => dequarantineJourney(emptyFlakeLedger(), "JOURNEY-404")).toThrow(
      FlakeLedgerError,
    )
  })

  it("refuses a flaky (non-quarantined) entry — green nights clear those", () => {
    expect(() => dequarantineJourney(flakyLedger(), "JOURNEY-001")).toThrow(
      /not quarantined/,
    )
  })
})

describe("load/save round-trip", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ibx-flake-ledger-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("a missing file is an empty ledger", () => {
    expect(loadFlakeLedger(join(dir, "absent.json"))).toEqual(emptyFlakeLedger())
  })

  it("a malformed file fails LOUDLY (never run with unreadable quarantine state)", () => {
    const path = join(dir, "broken.json")
    writeFileSync(path, "{not json")
    expect(() => loadFlakeLedger(path)).toThrow(FlakeLedgerError)
    writeFileSync(path, JSON.stringify({ version: 99, journeys: {} }))
    expect(() => loadFlakeLedger(path)).toThrow(FlakeLedgerError)
  })

  it("saves with stable key order + trailing newline and round-trips", () => {
    const path = join(dir, "ledger.json")
    const ledger: FlakeLedger = {
      version: FLAKE_LEDGER_VERSION,
      journeys: {
        ...flakyLedger().journeys,
        "JOURNEY-009": {
          journey: "JOURNEY-009",
          firstSeen: "2026-06-09",
          owner: "bnocesar",
          status: "quarantined",
          consecutiveFlakyNights: 2,
          lastFlakyNight: "2026-06-10",
          quarantinedAt: "2026-06-10",
        },
      },
    }
    saveFlakeLedger(ledger, path)
    const raw = readFileSync(path, "utf-8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(raw.indexOf("JOURNEY-001")).toBeLessThan(raw.indexOf("JOURNEY-009"))
    expect(loadFlakeLedger(path)).toEqual(ledger)
    expect(quarantinedJourneyIds(ledger)).toEqual(["JOURNEY-009"])
    expect(flakeOwner(ledger, "JOURNEY-009")).toBe("bnocesar")
    expect(flakeOwner(ledger, "JOURNEY-404")).toBe("")
  })
})
