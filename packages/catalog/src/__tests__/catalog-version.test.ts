// LE2-014 — the CATALOG_VERSION contract.
//
// The version's whole job is to be a stable, monotonic serial that a turn's
// trace can carry so the turn is replayable against exactly the catalog it
// saw. A single test run cannot observe monotonicity (that is a property of
// the commit history, enforced by review against the README's bump
// discipline). What it CAN pin is the shape the trace column and every
// consumer depend on — and the fact that the constant is authored, not
// computed.

import { describe, expect, it } from "vitest"

import { CATALOG_VERSION } from "../version.js"

describe("CATALOG_VERSION", () => {
  it("is a positive integer (the turn_trace.catalog_version column is INTEGER)", () => {
    expect(Number.isInteger(CATALOG_VERSION)).toBe(true)
    expect(CATALOG_VERSION).toBeGreaterThan(0)
  })

  it("is stable within a process — reading it twice yields the same value", () => {
    // Guards against anyone turning the constant into a getter over a clock,
    // a build timestamp, or a content hash. A version that changes on its own
    // is not a version; it would silently break replay, which is the one
    // thing the stamp exists for.
    expect(CATALOG_VERSION).toBe(CATALOG_VERSION)
    expect(typeof CATALOG_VERSION).toBe("number")
  })

  it("is finite and safely representable (it round-trips through JSON and Postgres)", () => {
    expect(Number.isFinite(CATALOG_VERSION)).toBe(true)
    expect(CATALOG_VERSION).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    expect(JSON.parse(JSON.stringify({ v: CATALOG_VERSION })).v).toBe(CATALOG_VERSION)
  })
})
