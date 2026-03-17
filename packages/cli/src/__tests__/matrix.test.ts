// Tests for lib/matrix.ts — state combination generation.
// Tests pure combination logic only (generateAllStates, generateCornerStates).
// runMatrix is too coupled to infra (lock, pipeline, ora, chalk) to test in isolation.

import { describe, it, expect } from "vitest"

import {
  generateAllStates,
  generateCornerStates,
  type StateVariable,
} from "../lib/matrix.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeVars(count: number): StateVariable[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `var-${i}`,
    description: `Variable ${i}`,
    apply: async () => {},
    remove: async () => {},
  }))
}

// ── generateAllStates ────────────────────────────────────────────────────────

describe("generateAllStates", () => {
  it("generates 2^0 = 1 state for 0 variables", () => {
    const states = generateAllStates([])
    expect(states).toHaveLength(1)
    expect(states[0].stateIndex).toBe(0)
    expect(states[0].activeVars).toEqual([])
    expect(states[0].inactiveVars).toEqual([])
  })

  it("generates 2^1 = 2 states for 1 variable", () => {
    const vars = makeVars(1)
    const states = generateAllStates(vars)
    expect(states).toHaveLength(2)

    // State 0: all OFF
    expect(states[0].activeVars).toEqual([])
    expect(states[0].inactiveVars).toEqual(["var-0"])

    // State 1: var-0 ON
    expect(states[1].activeVars).toEqual(["var-0"])
    expect(states[1].inactiveVars).toEqual([])
  })

  it("generates 2^2 = 4 states for 2 variables", () => {
    const vars = makeVars(2)
    const states = generateAllStates(vars)
    expect(states).toHaveLength(4)

    // Verify all state indices present
    const indices = states.map((s) => s.stateIndex)
    expect(indices).toEqual([0, 1, 2, 3])
  })

  it("generates 2^3 = 8 states for 3 variables", () => {
    const vars = makeVars(3)
    const states = generateAllStates(vars)
    expect(states).toHaveLength(8)
  })

  it("correctly maps bits to active/inactive variables", () => {
    const vars = makeVars(3)
    const states = generateAllStates(vars)

    // State 0 (binary 000): all OFF
    expect(states[0].activeVars).toEqual([])
    expect(states[0].inactiveVars).toEqual(["var-0", "var-1", "var-2"])

    // State 5 (binary 101): var-0 ON, var-1 OFF, var-2 ON
    expect(states[5].activeVars).toEqual(["var-0", "var-2"])
    expect(states[5].inactiveVars).toEqual(["var-1"])

    // State 7 (binary 111): all ON
    expect(states[7].activeVars).toEqual(["var-0", "var-1", "var-2"])
    expect(states[7].inactiveVars).toEqual([])
  })

  it("every state has active + inactive = all variables", () => {
    const vars = makeVars(4)
    const states = generateAllStates(vars)
    const allNames = vars.map((v) => v.name)

    for (const state of states) {
      const combined = [...state.activeVars, ...state.inactiveVars].sort()
      expect(combined).toEqual([...allNames].sort())
    }
  })

  it("no duplicate state indices", () => {
    const vars = makeVars(4)
    const states = generateAllStates(vars)
    const indices = new Set(states.map((s) => s.stateIndex))
    expect(indices.size).toBe(states.length)
  })
})

// ── generateCornerStates ─────────────────────────────────────────────────────

describe("generateCornerStates", () => {
  it("returns 1 state for 0 variables (just all-OFF)", () => {
    const states = generateCornerStates([])
    expect(states).toHaveLength(1)
    expect(states[0].stateIndex).toBe(0)
  })

  it("returns 2 states for 1 variable (all-OFF + all-ON are same as single-ON)", () => {
    const vars = makeVars(1)
    const states = generateCornerStates(vars)
    // States: 0 (all OFF) and 1 (all ON / single-ON for var-0)
    expect(states).toHaveLength(2)
    const indices = states.map((s) => s.stateIndex)
    expect(indices).toContain(0)
    expect(indices).toContain(1)
  })

  it("returns N+2 states for N variables (all-OFF + all-ON + each single-ON)", () => {
    const vars = makeVars(3)
    const states = generateCornerStates(vars)

    // Expected: state 0 (all OFF), 7 (all ON), 1, 2, 4 (each single-ON)
    // = 5 states (if no overlap)
    const indices = states.map((s) => s.stateIndex)
    expect(indices).toContain(0) // all OFF
    expect(indices).toContain(7) // all ON (2^3 - 1)
    expect(indices).toContain(1) // only var-0 ON
    expect(indices).toContain(2) // only var-1 ON
    expect(indices).toContain(4) // only var-2 ON
    expect(states).toHaveLength(5)
  })

  it("with 2 variables returns 4 states (no duplicates even when overlap)", () => {
    const vars = makeVars(2)
    const states = generateCornerStates(vars)

    // all-OFF=0, all-ON=3, single-ON var-0=1, single-ON var-1=2
    // Total: 4 unique states
    const indices = states.map((s) => s.stateIndex)
    expect(new Set(indices).size).toBe(4)
    expect(indices).toContain(0)
    expect(indices).toContain(3)
    expect(indices).toContain(1)
    expect(indices).toContain(2)
  })

  it("includes all-OFF state", () => {
    const vars = makeVars(4)
    const states = generateCornerStates(vars)
    const allOff = states.find((s) => s.stateIndex === 0)
    expect(allOff).toBeDefined()
    expect(allOff!.activeVars).toEqual([])
  })

  it("includes all-ON state", () => {
    const vars = makeVars(4)
    const states = generateCornerStates(vars)
    const allOn = states.find((s) => s.stateIndex === 15) // 2^4 - 1
    expect(allOn).toBeDefined()
    expect(allOn!.activeVars).toHaveLength(4)
  })

  it("each single-ON state has exactly one active variable", () => {
    const vars = makeVars(3)
    const states = generateCornerStates(vars)
    const singleOns = states.filter(
      (s) => s.stateIndex !== 0 && s.stateIndex !== (1 << vars.length) - 1,
    )
    for (const state of singleOns) {
      expect(state.activeVars).toHaveLength(1)
    }
  })
})
