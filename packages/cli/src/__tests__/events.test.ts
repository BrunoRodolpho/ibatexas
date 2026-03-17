// Tests for lib/events.ts — structured event emitter for scenario execution.
// Uses in-memory listener fixtures; no external deps.

import { describe, it, expect, beforeEach, vi } from "vitest"

// Freeze time so timestamps are deterministic
vi.useFakeTimers()
vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"))

import {
  emit,
  onEvent,
  emitScenarioStart,
  emitScenarioFinish,
  emitStepStart,
  emitStepFinish,
  type ScenarioEvent,
} from "../lib/events.js"

describe("events — emit + onEvent", () => {
  let captured: ScenarioEvent[]
  let unsub: () => void

  beforeEach(() => {
    captured = []
    unsub = onEvent((e) => captured.push(e))
    vi.clearAllMocks()
  })

  // Clean up listener after each test to avoid cross-test leaks
  afterEach(() => {
    unsub()
  })

  it("dispatches events to registered listeners", () => {
    const event: ScenarioEvent = {
      type: "scenario.start",
      timestamp: new Date().toISOString(),
      scenario: "homepage",
    }
    emit(event)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual(event)
  })

  it("dispatches to multiple listeners", () => {
    const captured2: ScenarioEvent[] = []
    const unsub2 = onEvent((e) => captured2.push(e))

    const event: ScenarioEvent = {
      type: "step.start",
      timestamp: new Date().toISOString(),
      step: "seed-products",
    }
    emit(event)

    expect(captured).toHaveLength(1)
    expect(captured2).toHaveLength(1)
    unsub2()
  })

  it("unsubscribe removes the listener", () => {
    unsub()
    emit({
      type: "scenario.finish",
      timestamp: new Date().toISOString(),
      scenario: "homepage",
      duration: 1000,
    })
    expect(captured).toHaveLength(0)
  })

  it("does not crash when a listener throws", () => {
    const badUnsub = onEvent(() => {
      throw new Error("boom")
    })

    // Should not throw, and the good listener should still receive the event
    const event: ScenarioEvent = {
      type: "cache.hit",
      timestamp: new Date().toISOString(),
    }
    expect(() => emit(event)).not.toThrow()
    expect(captured).toHaveLength(1)

    badUnsub()
  })

  it("writes to stderr when IBX_EVENTS=json", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env.IBX_EVENTS
    process.env.IBX_EVENTS = "json"

    const event: ScenarioEvent = {
      type: "lock.acquire",
      timestamp: "2025-06-01T12:00:00.000Z",
      scenario: "test",
    }
    emit(event)

    expect(stderrSpy).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`)
    expect(captured).toHaveLength(1)

    process.env.IBX_EVENTS = original
    stderrSpy.mockRestore()
  })

  it("does NOT write to stderr when IBX_EVENTS is unset", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const original = process.env.IBX_EVENTS
    delete process.env.IBX_EVENTS

    emit({ type: "verify.pass", timestamp: "2025-06-01T12:00:00.000Z" })

    expect(stderrSpy).not.toHaveBeenCalled()
    process.env.IBX_EVENTS = original
    stderrSpy.mockRestore()
  })
})

describe("events — convenience helpers", () => {
  let captured: ScenarioEvent[]
  let unsub: () => void

  beforeEach(() => {
    captured = []
    unsub = onEvent((e) => captured.push(e))
  })

  afterEach(() => {
    unsub()
  })

  it("emitScenarioStart emits correct type and scenario", () => {
    emitScenarioStart("homepage")
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe("scenario.start")
    expect(captured[0].scenario).toBe("homepage")
    expect(captured[0].timestamp).toBe("2025-06-01T12:00:00.000Z")
  })

  it("emitScenarioFinish emits correct type, scenario, and duration", () => {
    emitScenarioFinish("homepage", 5000)
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe("scenario.finish")
    expect(captured[0].scenario).toBe("homepage")
    expect(captured[0].duration).toBe(5000)
  })

  it("emitStepStart emits correct type, scenario, and step", () => {
    emitStepStart("homepage", "seed-products")
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe("step.start")
    expect(captured[0].scenario).toBe("homepage")
    expect(captured[0].step).toBe("seed-products")
  })

  it("emitStepFinish emits correct type, scenario, step, and duration", () => {
    emitStepFinish("homepage", "reindex", 1200)
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe("step.finish")
    expect(captured[0].scenario).toBe("homepage")
    expect(captured[0].step).toBe("reindex")
    expect(captured[0].duration).toBe(1200)
  })
})

describe("events — onEvent idempotent unsubscribe", () => {
  it("calling unsubscribe twice does not throw", () => {
    const unsub = onEvent(() => {})
    unsub()
    expect(() => unsub()).not.toThrow()
  })
})
