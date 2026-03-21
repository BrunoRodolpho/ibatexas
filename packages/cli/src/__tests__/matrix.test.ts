// Tests for lib/matrix.ts — state matrix engine.
// Uses pure boundary mocking: all external I/O (lock, Redis, pipeline, steps, ora, chalk) is mocked.
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup (vi.hoisted + vi.mock BEFORE imports) ─────────────────────────

const mockReleaseLock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockAcquireScenarioLock = vi.hoisted(() => vi.fn().mockResolvedValue(mockReleaseLock))

vi.mock("../lib/lock.js", () => ({
  acquireScenarioLock: mockAcquireScenarioLock,
}))

const mockCloseRedis = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../lib/redis.js", () => ({
  closeRedis: mockCloseRedis,
}))

const mockRunPipeline = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, steps: [], totalMs: 0 }),
)

vi.mock("../lib/pipeline.js", () => ({
  runPipeline: mockRunPipeline,
}))

const mockStepRegistry = vi.hoisted(() =>
  new Proxy({} as Record<string, { label: string; run: () => Promise<void> }>, {
    get: (_target, prop) => ({
      label: `Step: ${String(prop)}`,
      run: vi.fn().mockResolvedValue(undefined),
    }),
  }),
)

vi.mock("../lib/steps.js", () => ({
  StepRegistry: mockStepRegistry,
}))

// Mock chalk as passthrough
vi.mock("chalk", () => {
  const passthrough = (s: unknown) => String(s)
  const handler: ProxyHandler<typeof passthrough> = {
    get: () => new Proxy(passthrough, handler),
    apply: (_target, _thisArg, args) => String(args[0]),
  }
  return { default: new Proxy(passthrough, handler) }
})

// Mock ora — must return the same object from start() so chaining works
const mockSpinner = vi.hoisted(() => {
  const spinner: Record<string, unknown> = { text: "" }
  spinner.start = vi.fn(() => spinner)
  spinner.succeed = vi.fn(() => spinner)
  spinner.fail = vi.fn(() => spinner)
  spinner.stop = vi.fn(() => spinner)
  spinner.stopAndPersist = vi.fn(() => spinner)
  return spinner
})

vi.mock("ora", () => ({
  default: vi.fn(() => mockSpinner),
}))

// Mock @ibatexas/domain (dynamic import in disconnectAll)
const mockPrismaDisconnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    $disconnect: mockPrismaDisconnect,
  },
}))

// ── Import source after mocks ────────────────────────────────────────────────
import {
  generateAllStates,
  generateCornerStates,
  generateRandomState,
  listStates,
  runMatrix,
} from "../lib/matrix.js"

import type {
  StateVariable,
  MatrixDefinition,
  MatrixExpectation,
} from "../lib/matrix.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeVars(count: number): StateVariable[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `var-${i}`,
    description: `Variable ${i}`,
    apply: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  }))
}

function makeExpectation(overrides: Partial<MatrixExpectation> = {}): MatrixExpectation {
  return {
    section: "test-section",
    requires: [],
    severity: "error",
    check: vi.fn().mockResolvedValue({ ok: true, detail: "all good" }),
    ...overrides,
  }
}

function makeDefinition(overrides: Partial<MatrixDefinition> = {}): MatrixDefinition {
  return {
    name: "test-matrix",
    description: "A test matrix",
    category: "ui",
    baseSetup: [],
    variables: makeVars(2),
    expectations: [makeExpectation()],
    ...overrides,
  }
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

  it("each combination has correct activeVars and inactiveVars based on binary pattern", () => {
    const vars = makeVars(3)
    const states = generateAllStates(vars)

    // State 0 (binary 000): all OFF
    expect(states[0].activeVars).toEqual([])
    expect(states[0].inactiveVars).toEqual(["var-0", "var-1", "var-2"])

    // State 3 (binary 011): var-0 ON, var-1 ON, var-2 OFF
    expect(states[3].activeVars).toEqual(["var-0", "var-1"])
    expect(states[3].inactiveVars).toEqual(["var-2"])

    // State 5 (binary 101): var-0 ON, var-1 OFF, var-2 ON
    expect(states[5].activeVars).toEqual(["var-0", "var-2"])
    expect(states[5].inactiveVars).toEqual(["var-1"])

    // State 7 (binary 111): all ON
    expect(states[7].activeVars).toEqual(["var-0", "var-1", "var-2"])
    expect(states[7].inactiveVars).toEqual([])
  })

  it("stateIndex matches expected binary pattern", () => {
    const vars = makeVars(3)
    const states = generateAllStates(vars)

    for (const state of states) {
      // Verify that stateIndex encodes which variables are active
      for (let bit = 0; bit < vars.length; bit++) {
        const isActive = (state.stateIndex & (1 << bit)) !== 0
        if (isActive) {
          expect(state.activeVars).toContain(vars[bit].name)
        } else {
          expect(state.inactiveVars).toContain(vars[bit].name)
        }
      }
    }
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
  it("includes all-OFF (state 0) and all-ON (state 2^N-1)", () => {
    const vars = makeVars(3)
    const states = generateCornerStates(vars)
    const indices = states.map((s) => s.stateIndex)

    expect(indices).toContain(0)       // all OFF
    expect(indices).toContain(7)       // all ON (2^3 - 1)
  })

  it("includes each single-ON state", () => {
    const vars = makeVars(4)
    const states = generateCornerStates(vars)
    const indices = states.map((s) => s.stateIndex)

    // Each single-ON state is 2^bit
    expect(indices).toContain(1)   // var-0 only
    expect(indices).toContain(2)   // var-1 only
    expect(indices).toContain(4)   // var-2 only
    expect(indices).toContain(8)   // var-3 only
  })

  it("no duplicates", () => {
    const vars = makeVars(4)
    const states = generateCornerStates(vars)
    const indices = states.map((s) => s.stateIndex)
    expect(new Set(indices).size).toBe(indices.length)
  })

  it("returns correct count: 2 + N states (when N >= 2)", () => {
    // N=3: all-OFF(0), all-ON(7), single-ON: 1,2,4 → 5 states = 2 + 3
    const vars3 = makeVars(3)
    expect(generateCornerStates(vars3)).toHaveLength(5)

    // N=4: all-OFF(0), all-ON(15), single-ON: 1,2,4,8 → 6 states = 2 + 4
    const vars4 = makeVars(4)
    expect(generateCornerStates(vars4)).toHaveLength(6)
  })

  it("returns 1 state for 0 variables (only all-OFF)", () => {
    const states = generateCornerStates([])
    expect(states).toHaveLength(1)
    expect(states[0].stateIndex).toBe(0)
  })

  it("returns 2 states for 1 variable (all-OFF + all-ON overlap with single-ON)", () => {
    const vars = makeVars(1)
    const states = generateCornerStates(vars)
    // all-OFF=0, all-ON=1, single-ON var-0=1 → deduplicated to {0,1}
    expect(states).toHaveLength(2)
    const indices = states.map((s) => s.stateIndex)
    expect(indices).toContain(0)
    expect(indices).toContain(1)
  })

  it("with 2 variables returns 4 states", () => {
    const vars = makeVars(2)
    const states = generateCornerStates(vars)
    // all-OFF=0, all-ON=3, single-ON: 1,2 → 4 unique
    expect(states).toHaveLength(4)
    const indices = states.map((s) => s.stateIndex)
    expect(indices).toContain(0)
    expect(indices).toContain(1)
    expect(indices).toContain(2)
    expect(indices).toContain(3)
  })

  it("all-OFF state has no active variables", () => {
    const vars = makeVars(4)
    const states = generateCornerStates(vars)
    const allOff = states.find((s) => s.stateIndex === 0)
    expect(allOff).toBeDefined()
    expect(allOff!.activeVars).toEqual([])
  })

  it("all-ON state has all variables active", () => {
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

// ── generateRandomState ──────────────────────────────────────────────────────

describe("generateRandomState", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("returns exactly one state", () => {
    const vars = makeVars(3)
    const states = generateRandomState(vars)
    expect(states).toHaveLength(1)
  })

  it("returned state has valid stateIndex within range", () => {
    const vars = makeVars(3)
    const states = generateRandomState(vars)
    expect(states[0].stateIndex).toBeGreaterThanOrEqual(0)
    expect(states[0].stateIndex).toBeLessThan(8) // 2^3
  })

  it("uses crypto.getRandomValues (mock to verify determinism)", () => {
    const vars = makeVars(3) // 8 total states
    // Mock crypto.getRandomValues to always return 5
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (array instanceof Uint32Array) {
        array[0] = 5
      }
      return array
    })

    const states = generateRandomState(vars)
    expect(spy).toHaveBeenCalled()
    // 5 % 8 = 5, so we should get state index 5
    expect(states[0].stateIndex).toBe(5)

    spy.mockRestore()
  })

  it("deterministic mock produces consistent results", () => {
    const vars = makeVars(4) // 16 total states
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (array instanceof Uint32Array) {
        array[0] = 42
      }
      return array
    })

    const first = generateRandomState(vars)
    const second = generateRandomState(vars)
    expect(first[0].stateIndex).toBe(second[0].stateIndex)
    // 42 % 16 = 10
    expect(first[0].stateIndex).toBe(10)

    spy.mockRestore()
  })

  it("returned state is a valid member of generateAllStates", () => {
    const vars = makeVars(3)
    const all = generateAllStates(vars)
    const [random] = generateRandomState(vars)
    const match = all.find((s) => s.stateIndex === random.stateIndex)
    expect(match).toBeDefined()
    expect(match!.activeVars).toEqual(random.activeVars)
    expect(match!.inactiveVars).toEqual(random.inactiveVars)
  })
})

// ── listStates ───────────────────────────────────────────────────────────────

describe("listStates", () => {
  it("delegates to generateAllStates with definition.variables", () => {
    const vars = makeVars(3)
    const definition = makeDefinition({ variables: vars })

    const listed = listStates(definition)
    const allStates = generateAllStates(vars)

    expect(listed).toEqual(allStates)
    expect(listed).toHaveLength(8) // 2^3
  })

  it("returns 1 state for definition with 0 variables", () => {
    const definition = makeDefinition({ variables: [] })
    const listed = listStates(definition)
    expect(listed).toHaveLength(1)
    expect(listed[0].stateIndex).toBe(0)
  })

  it("returns 4 states for definition with 2 variables", () => {
    const definition = makeDefinition({ variables: makeVars(2) })
    const listed = listStates(definition)
    expect(listed).toHaveLength(4)
  })
})

// ── runMatrix — integration ──────────────────────────────────────────────────

describe("runMatrix — integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockAcquireScenarioLock.mockResolvedValue(mockReleaseLock)
    mockRunPipeline.mockResolvedValue({ ok: true, steps: [], totalMs: 0 })
  })

  it("acquires lock, runs base setup, executes states, releases lock", async () => {
    const vars = makeVars(1)
    const definition = makeDefinition({
      variables: vars,
      baseSetup: ["seed-products" as never],
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition)

    // Lock acquired with matrix prefix
    expect(mockAcquireScenarioLock).toHaveBeenCalledWith("matrix:test-matrix", { force: undefined })
    // Pipeline ran for base setup
    expect(mockRunPipeline).toHaveBeenCalled()
    // Lock released
    expect(mockReleaseLock).toHaveBeenCalled()
    // States executed (2^1 = 2 states)
    expect(result.statesRun).toBe(2)
  })

  it("returns ok:true when all expectations pass", async () => {
    const definition = makeDefinition({
      variables: makeVars(1),
      expectations: [
        makeExpectation({
          section: "passing-check",
          requires: [],
          check: vi.fn().mockResolvedValue({ ok: true, detail: "visible" }),
        }),
      ],
    })

    const result = await runMatrix(definition)

    expect(result.ok).toBe(true)
    expect(result.results.every((r) => r.ok)).toBe(true)
  })

  it("returns ok:false when any expectation fails", async () => {
    const vars = makeVars(1)
    const definition = makeDefinition({
      variables: vars,
      expectations: [
        makeExpectation({
          section: "failing-check",
          requires: ["var-0"],
          // When var-0 is ON (state 1), requires are met → expected visible → ok should be true for pass
          // When var-0 is OFF (state 0), requires NOT met → expected hidden → ok:true means check found it → !ok = false → "fail"
          // Let's make the check always return ok:false:
          // State 0: expected hidden, check ok:false → !ok = true → pass
          // State 1: expected visible, check ok:false → mismatch → fail
          check: vi.fn().mockResolvedValue({ ok: false, detail: "not found" }),
        }),
      ],
    })

    const result = await runMatrix(definition)

    expect(result.ok).toBe(false)
    // At least one state result should be not ok
    expect(result.results.some((r) => !r.ok)).toBe(true)
  })

  it("releases lock even on failure", async () => {
    const definition = makeDefinition({
      variables: makeVars(1),
      expectations: [
        makeExpectation({
          check: vi.fn().mockRejectedValue(new Error("check exploded")),
        }),
      ],
    })

    const result = await runMatrix(definition)

    // Should still release lock regardless of check failures
    expect(mockReleaseLock).toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it("handles lock acquisition failure gracefully", async () => {
    mockAcquireScenarioLock.mockRejectedValueOnce(new Error("Lock held by another scenario"))

    const definition = makeDefinition()
    const result = await runMatrix(definition)

    expect(result.ok).toBe(false)
    expect(result.statesRun).toBe(0)
    expect(result.results).toEqual([])
  })

  it("opts.state runs specific state by index", async () => {
    const vars = makeVars(2) // 4 states: 0,1,2,3
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition, { state: 2 })

    expect(result.statesRun).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].stateIndex).toBe(2)
  })

  it("opts.state returns failure for invalid state index", async () => {
    const vars = makeVars(2) // 4 states: 0,1,2,3
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition, { state: 99 })

    expect(result.ok).toBe(false)
    expect(result.statesRun).toBe(0)
  })

  it("opts.corners runs corner states only", async () => {
    const vars = makeVars(3) // 8 total states, corners = 5 (all-OFF, all-ON, 3 single-ON)
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition, { corners: true })

    expect(result.statesRun).toBe(5)
    const indices = result.results.map((r) => r.stateIndex)
    expect(indices).toContain(0)   // all OFF
    expect(indices).toContain(7)   // all ON
    expect(indices).toContain(1)   // var-0 only
    expect(indices).toContain(2)   // var-1 only
    expect(indices).toContain(4)   // var-2 only
  })

  it("opts.random runs single random state", async () => {
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (array instanceof Uint32Array) {
        array[0] = 3
      }
      return array
    })

    const vars = makeVars(2) // 4 states
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition, { random: true })

    expect(result.statesRun).toBe(1)
    expect(result.results).toHaveLength(1)
    // 3 % 4 = 3
    expect(result.results[0].stateIndex).toBe(3)

    spy.mockRestore()
  })

  it("closes Redis and Prisma in finally block", async () => {
    const definition = makeDefinition({
      variables: makeVars(1),
      expectations: [makeExpectation()],
    })

    await runMatrix(definition)

    expect(mockCloseRedis).toHaveBeenCalled()
    expect(mockPrismaDisconnect).toHaveBeenCalled()
  })

  it("closes Redis and Prisma even when execution throws", async () => {
    mockRunPipeline.mockRejectedValueOnce(new Error("pipeline exploded"))

    const definition = makeDefinition({
      baseSetup: ["seed-products" as never],
      variables: makeVars(1),
      expectations: [makeExpectation()],
    })

    // runMatrix has try/finally but no catch — rejection propagates after cleanup
    await expect(runMatrix(definition)).rejects.toThrow("pipeline exploded")

    expect(mockCloseRedis).toHaveBeenCalled()
    expect(mockPrismaDisconnect).toHaveBeenCalled()
    expect(mockReleaseLock).toHaveBeenCalled()
  })

  it("passes force option to acquireScenarioLock", async () => {
    const definition = makeDefinition()

    await runMatrix(definition, { force: true })

    expect(mockAcquireScenarioLock).toHaveBeenCalledWith("matrix:test-matrix", { force: true })
  })

  it("skips base setup when baseSetup is empty", async () => {
    const definition = makeDefinition({
      baseSetup: [],
      variables: makeVars(1),
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition)

    expect(mockRunPipeline).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.statesRun).toBe(2) // 2^1
  })

  it("returns failure when base setup pipeline fails", async () => {
    mockRunPipeline.mockResolvedValueOnce({ ok: false, steps: [], totalMs: 0 })

    const definition = makeDefinition({
      baseSetup: ["seed-products" as never],
      variables: makeVars(1),
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition)

    expect(result.ok).toBe(false)
    expect(result.statesRun).toBe(0)
  })

  it("calls remove() on all variables before apply() for each state", async () => {
    const vars = makeVars(2)
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    await runMatrix(definition, { state: 3 }) // state 3: both vars ON

    // Both variables should have remove() called (clean slate)
    expect(vars[0].remove).toHaveBeenCalled()
    expect(vars[1].remove).toHaveBeenCalled()
    // Both should have apply() called since both are active in state 3
    expect(vars[0].apply).toHaveBeenCalled()
    expect(vars[1].apply).toHaveBeenCalled()
  })

  it("does not call apply() on inactive variables", async () => {
    const vars = makeVars(2)
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    await runMatrix(definition, { state: 1 }) // state 1: only var-0 ON

    // var-0 should be applied
    expect(vars[0].apply).toHaveBeenCalled()
    // var-1 should NOT be applied (only removed)
    expect(vars[1].apply).not.toHaveBeenCalled()
    expect(vars[1].remove).toHaveBeenCalled()
  })

  it("populates totalStates as 2^N regardless of states actually run", async () => {
    const vars = makeVars(3) // 8 total states
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition, { state: 0 })

    expect(result.totalStates).toBe(8)
    expect(result.statesRun).toBe(1)
  })

  it("returns matrix name in result", async () => {
    const definition = makeDefinition({ name: "my-custom-matrix" })

    const result = await runMatrix(definition)

    expect(result.matrix).toBe("my-custom-matrix")
  })

  it("expectation with requires met → expected visible → check ok:true → pass", async () => {
    const vars = makeVars(1)
    const definition = makeDefinition({
      variables: vars,
      expectations: [
        makeExpectation({
          section: "requires-var0",
          requires: ["var-0"],
          check: vi.fn().mockResolvedValue({ ok: true, detail: "found" }),
        }),
      ],
    })

    // Run state 1 (var-0 ON) — requires met, check ok → pass
    const result = await runMatrix(definition, { state: 1 })

    expect(result.ok).toBe(true)
    const check = result.results[0].checks[0]
    expect(check.expected).toBe("visible")
    expect(check.actual).toBe("pass")
  })

  it("expectation with requires NOT met → expected hidden → check ok:false → pass", async () => {
    const vars = makeVars(1)
    const definition = makeDefinition({
      variables: vars,
      expectations: [
        makeExpectation({
          section: "requires-var0",
          requires: ["var-0"],
          check: vi.fn().mockResolvedValue({ ok: false, detail: "not found" }),
        }),
      ],
    })

    // Run state 0 (var-0 OFF) — requires NOT met → expected hidden → check ok:false → !ok = true → pass
    const result = await runMatrix(definition, { state: 0 })

    expect(result.ok).toBe(true)
    const check = result.results[0].checks[0]
    expect(check.expected).toBe("hidden")
    expect(check.actual).toBe("pass")
  })

  it("expectation check throwing error results in fail", async () => {
    const vars = makeVars(1)
    const definition = makeDefinition({
      variables: vars,
      expectations: [
        makeExpectation({
          section: "exploding-check",
          requires: [],
          check: vi.fn().mockRejectedValue(new Error("boom")),
        }),
      ],
    })

    const result = await runMatrix(definition, { state: 0 })

    expect(result.ok).toBe(false)
    const check = result.results[0].checks[0]
    expect(check.actual).toBe("fail")
    expect(check.detail).toContain("boom")
  })

  it("durationMs is populated in result", async () => {
    const definition = makeDefinition({
      variables: makeVars(1),
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition)

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("runs all 2^N states by default (no opts)", async () => {
    const vars = makeVars(2)
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition)

    expect(result.statesRun).toBe(4) // 2^2
    expect(result.totalStates).toBe(4)
    const indices = result.results.map((r) => r.stateIndex)
    expect(indices).toEqual([0, 1, 2, 3])
  })

  it("does not acquire lock when lock acquisition fails and does not run any states", async () => {
    mockAcquireScenarioLock.mockRejectedValueOnce(new Error("locked"))

    const vars = makeVars(1)
    const applyFn = vars[0].apply as ReturnType<typeof vi.fn>
    const definition = makeDefinition({
      variables: vars,
      expectations: [makeExpectation()],
    })

    const result = await runMatrix(definition)

    expect(result.ok).toBe(false)
    expect(applyFn).not.toHaveBeenCalled()
    expect(mockRunPipeline).not.toHaveBeenCalled()
  })
})
