// Tests for runner/run-journey.ts — sequential execution, injected
// executors, journey.*/act.* event emission, fail-fast semantics.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { onEvent, type IbxEventBase } from "@ibatexas/tools"

import { validateJourney, type Journey } from "../../schema/index.js"
import {
  runJourney,
  JourneyBlockedError,
  type ActExecutors,
} from "../run-journey.js"

function makeJourney(overrides: Record<string, unknown> = {}): Journey {
  const result = validateJourney({
    id: "JOURNEY-001",
    title: "Runner skeleton exercise",
    businessCase: "Prove acts run sequentially with events.",
    persona: "Cliente de teste.",
    channel: "web",
    status: "active",
    blocked_by: [],
    source: "T1a-1 unit test",
    acts: [
      { kind: "fixture", name: "seed", seed: "seedCustomer" },
      { kind: "chat", name: "talk", goal: "Fazer um pedido." },
      { kind: "http", name: "probe", method: "GET", path: "/api/me" },
    ],
    expects: [],
    verify: [],
    ...overrides,
  })
  if (!result.ok) throw new Error(`fixture journey invalid: ${JSON.stringify(result.errors)}`)
  return result.journey
}

function stubExecutors(log: string[]): ActExecutors {
  return {
    chat: async (act) => {
      log.push(`chat:${act.name ?? ""}`)
    },
    http: async (act) => {
      log.push(`http:${act.name ?? ""}`)
    },
    fixture: async (act) => {
      log.push(`fixture:${act.name ?? ""}`)
    },
  }
}

describe("runJourney — sequential execution", () => {
  let events: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    events = []
    unsub = onEvent((e) => events.push(e))
  })

  afterEach(() => {
    unsub()
  })

  it("executes stub acts strictly in YAML order", async () => {
    const log: string[] = []
    const result = await runJourney(makeJourney(), stubExecutors(log), { runId: "run-1" })

    expect(log).toEqual(["fixture:seed", "chat:talk", "http:probe"])
    expect(result.ok).toBe(true)
    expect(result.runId).toBe("run-1")
    expect(result.acts.map((a) => a.outcome)).toEqual(["pass", "pass", "pass"])
  })

  it("emits journey.* and act.* events in order", async () => {
    await runJourney(makeJourney(), stubExecutors([]), { runId: "run-2" })

    expect(events.map((e) => e.type)).toEqual([
      "journey.start",
      "act.start",
      "act.end",
      "act.start",
      "act.end",
      "act.start",
      "act.end",
      "journey.end",
    ])
    expect(events[0]).toMatchObject({ journey: "JOURNEY-001", runId: "run-2" })
    expect(events[1]).toMatchObject({ act: "seed", actKind: "fixture", actIndex: 0 })
    expect(events.at(-1)).toMatchObject({ type: "journey.end", outcome: "pass" })
  })

  it("stops at the first failing act (fail-fast)", async () => {
    const log: string[] = []
    const executors = stubExecutors(log)
    executors.chat = async () => ({ ok: false, detail: "driver gave up" })

    const result = await runJourney(makeJourney(), executors)

    expect(log).toEqual(["fixture:seed"]) // http never ran
    expect(result.ok).toBe(false)
    expect(result.acts).toHaveLength(2)
    expect(result.acts[1]).toMatchObject({ kind: "chat", outcome: "fail", detail: "driver gave up" })
    expect(result.error).toBe("driver gave up")
    expect(events.at(-1)).toMatchObject({ type: "journey.end", outcome: "fail" })
  })

  it("captures executor throws as outcome=error without rethrowing", async () => {
    const executors = stubExecutors([])
    executors.fixture = async () => {
      throw new Error("seed helper exploded")
    }

    const result = await runJourney(makeJourney(), executors)

    expect(result.ok).toBe(false)
    expect(result.acts).toHaveLength(1)
    expect(result.acts[0].outcome).toBe("error")
    expect(result.error).toBe("seed helper exploded")
    expect(events.at(-1)).toMatchObject({ type: "journey.end", outcome: "error" })
  })

  it("threads ctx (journeyId, runId, params, shared vars) into executors", async () => {
    const seen: unknown[] = []
    const executors = stubExecutors([])
    executors.fixture = async (_act, ctx) => {
      ctx.vars.orderHandle = "pedido-do-teste"
      seen.push({ journeyId: ctx.journeyId, params: ctx.params })
    }
    executors.chat = async (_act, ctx) => {
      seen.push(ctx.vars.orderHandle)
    }

    await runJourney(makeJourney({ params: { productHandle: "costela-bovina-defumada" } }), executors)

    expect(seen[0]).toEqual({
      journeyId: "JOURNEY-001",
      params: { productHandle: "costela-bovina-defumada" },
    })
    expect(seen[1]).toBe("pedido-do-teste")
  })

  it("generates a fresh runId when none is given", async () => {
    const a = await runJourney(makeJourney(), stubExecutors([]))
    const b = await runJourney(makeJourney(), stubExecutors([]))
    expect(a.runId).not.toBe(b.runId)
    expect(a.runId).toMatch(/[0-9a-f-]{36}/)
  })

  it("refuses to run a blocked journey (JourneyBlockedError)", async () => {
    const blocked = makeJourney({ status: "blocked", blocked_by: ["ws4"] })
    await expect(runJourney(blocked, stubExecutors([]))).rejects.toThrow(JourneyBlockedError)
    await expect(runJourney(blocked, stubExecutors([]))).rejects.toThrow(/journey_blocked/)
    expect(events).toHaveLength(0) // nothing emitted for a refused run
  })

  it("runs a blocked journey under allowBlocked (debugging escape hatch)", async () => {
    const blocked = makeJourney({ status: "blocked", blocked_by: ["ws4"] })
    const result = await runJourney(blocked, stubExecutors([]), { allowBlocked: true })
    expect(result.ok).toBe(true)
  })

  it("labels unnamed acts act-<n>:<kind>", async () => {
    const journey = makeJourney({
      acts: [{ kind: "chat", goal: "Oi" }],
    })
    const result = await runJourney(journey, stubExecutors([]))
    expect(result.acts[0].name).toBe("act-1:chat")
  })
})
