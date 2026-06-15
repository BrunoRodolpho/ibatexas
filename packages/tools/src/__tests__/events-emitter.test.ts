// Tests for events/emitter.ts — the structured JSONL event emitter
// (moved here from packages/cli/src/lib/events.ts in T1a-1, union extended
// with the journey plane: journey.* / act.* / llm.call / evidence.*).
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest"
import {
  emit,
  onEvent,
  emitScenarioStart,
  emitJourneyStart,
  emitJourneyEnd,
  emitActStart,
  emitActEnd,
  emitLlmCall,
  type IbxEvent,
  type IbxEventBase,
  type ScenarioEvent,
} from "../events/emitter.js"

vi.useFakeTimers()
vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"))

describe("events emitter — listener dispatch (legacy scenario surface)", () => {
  let captured: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    captured = []
    unsub = onEvent((e) => captured.push(e))
  })

  afterEach(() => {
    unsub()
  })

  it("dispatches scenario events unchanged (cli call-site compatibility)", () => {
    // The legacy ScenarioEvent alias must stay assignable to emit()'s input.
    const event: ScenarioEvent & { type: "scenario.start" } = {
      type: "scenario.start",
      timestamp: new Date().toISOString(),
      scenario: "homepage",
    }
    emit(event)
    emitScenarioStart("homepage")
    expect(captured).toHaveLength(2)
    expect(captured[0]).toEqual(event)
    expect(captured[1].type).toBe("scenario.start")
  })

  it("does not crash when a listener throws", () => {
    const badUnsub = onEvent(() => {
      throw new Error("boom")
    })
    expect(() =>
      emit({ type: "cache.hit", timestamp: new Date().toISOString() }),
    ).not.toThrow()
    expect(captured).toHaveLength(1)
    badUnsub()
  })

  it("unsubscribe removes the listener", () => {
    unsub()
    emit({ type: "verify.pass", timestamp: new Date().toISOString() })
    expect(captured).toHaveLength(0)
    unsub = onEvent((e) => captured.push(e)) // restore for afterEach symmetry
  })
})

describe("events emitter — journey-plane union", () => {
  let captured: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    captured = []
    unsub = onEvent((e) => captured.push(e))
  })

  afterEach(() => {
    unsub()
  })

  it("accepts every journey-plane kind", () => {
    const ts = new Date().toISOString()
    const events: IbxEvent[] = [
      { type: "journey.start", timestamp: ts, journey: "JOURNEY-001", runId: "r-1" },
      { type: "act.start", timestamp: ts, journey: "JOURNEY-001", runId: "r-1", act: "a1", actKind: "chat", actIndex: 0 },
      { type: "llm.call", timestamp: ts, journey: "JOURNEY-001", runId: "r-1", model: "claude-sonnet-4-6", inputTokens: 812, outputTokens: 67 },
      { type: "act.end", timestamp: ts, journey: "JOURNEY-001", runId: "r-1", act: "a1", actKind: "chat", actIndex: 0, duration: 1200, outcome: "pass" },
      { type: "evidence.capture", timestamp: ts, journey: "JOURNEY-001", runId: "r-1", evidence: "audit-trail" },
      { type: "evidence.persist", timestamp: ts, journey: "JOURNEY-001", runId: "r-1", evidence: "runs/r-1/audit-trail.json" },
      { type: "journey.end", timestamp: ts, journey: "JOURNEY-001", runId: "r-1", duration: 4200, outcome: "pass" },
    ]
    for (const e of events) emit(e)
    expect(captured.map((e) => e.type)).toEqual([
      "journey.start",
      "act.start",
      "llm.call",
      "act.end",
      "evidence.capture",
      "evidence.persist",
      "journey.end",
    ])
  })

  it("llm.call REQUIRES inputTokens/outputTokens at the type level", () => {
    // @ts-expect-error — llm.call without token counts is unrepresentable
    const missing: IbxEvent = { type: "llm.call", timestamp: new Date().toISOString() }
    void missing

    emitLlmCall({ inputTokens: 10, outputTokens: 3, model: "claude-sonnet-4-6" })
    expect(captured[0]).toMatchObject({
      type: "llm.call",
      inputTokens: 10,
      outputTokens: 3,
      model: "claude-sonnet-4-6",
    })
  })

  it("rejects unknown event kinds at the type level", () => {
    // @ts-expect-error — "journey.teleport" is not part of the union
    const bogus: IbxEvent = { type: "journey.teleport", timestamp: new Date().toISOString() }
    void bogus
  })
})

describe("events emitter — IBX_EVENTS=json JSONL shape", () => {
  const ORIGINAL = process.env.IBX_EVENTS
  let lines: string[]
  let stderrSpy: MockInstance<typeof process.stderr.write>

  beforeEach(() => {
    lines = []
    process.env.IBX_EVENTS = "json"
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        lines.push(String(chunk))
        return true
      }) as typeof process.stderr.write)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    if (ORIGINAL === undefined) delete process.env.IBX_EVENTS
    else process.env.IBX_EVENTS = ORIGINAL
  })

  it("writes one JSON line per event — full journey trace snapshot", () => {
    emitJourneyStart("JOURNEY-001", "run-fixed")
    emitActStart("JOURNEY-001", "run-fixed", "open-chat", "chat", 0)
    emitLlmCall({
      inputTokens: 812,
      outputTokens: 67,
      model: "claude-sonnet-4-6",
      journey: "JOURNEY-001",
      runId: "run-fixed",
    })
    emitActEnd("JOURNEY-001", "run-fixed", "open-chat", "chat", 0, 1200, "pass")
    emitJourneyEnd("JOURNEY-001", "run-fixed", 4200, "pass")

    // Every line is valid standalone JSON terminated by \n (JSONL).
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true)
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    }

    expect(lines.join("")).toMatchInlineSnapshot(`
      "{"type":"journey.start","timestamp":"2026-06-12T12:00:00.000Z","journey":"JOURNEY-001","runId":"run-fixed"}
      {"type":"act.start","timestamp":"2026-06-12T12:00:00.000Z","journey":"JOURNEY-001","runId":"run-fixed","act":"open-chat","actKind":"chat","actIndex":0}
      {"type":"llm.call","timestamp":"2026-06-12T12:00:00.000Z","inputTokens":812,"outputTokens":67,"model":"claude-sonnet-4-6","journey":"JOURNEY-001","runId":"run-fixed"}
      {"type":"act.end","timestamp":"2026-06-12T12:00:00.000Z","journey":"JOURNEY-001","runId":"run-fixed","act":"open-chat","actKind":"chat","actIndex":0,"duration":1200,"outcome":"pass"}
      {"type":"journey.end","timestamp":"2026-06-12T12:00:00.000Z","journey":"JOURNEY-001","runId":"run-fixed","duration":4200,"outcome":"pass"}
      "
    `)
  })

  it("does NOT write to stderr when IBX_EVENTS is unset", () => {
    delete process.env.IBX_EVENTS
    emitScenarioStart("homepage")
    expect(lines).toHaveLength(0)
  })
})
