// Tests for runner/run-journey.ts — sequential execution, injected
// executors, journey.*/act.* event emission, fail-fast semantics, and the
// mandatory pre-flight first step (T1a-10).
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { onEvent, type IbxEventBase } from "@ibatexas/tools"

import { PreflightRefusalError } from "../../harness/preflight.js"
import { validateJourney, type Journey } from "../../schema/index.js"
import {
  runJourney,
  JourneyBlockedError,
  type ActExecutors,
  type PreflightFn,
  type RunJourneyOptions,
} from "../run-journey.js"

// Unit tests stub the pre-flight (its own checks are covered by
// harness/__tests__/preflight.test.ts and the live handshake).
const passPreflight: PreflightFn = async () => ({ ok: true, certifying: true, checks: [] })

function run(
  journey: Journey,
  executors: ActExecutors,
  opts: RunJourneyOptions = {},
): ReturnType<typeof runJourney> {
  return runJourney(journey, executors, { preflight: passPreflight, ...opts })
}

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
    rawEnvelope: async (act) => {
      log.push(`raw-envelope:${act.name ?? ""}`)
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
    const result = await run(makeJourney(), stubExecutors(log), { runId: "run-1" })

    expect(log).toEqual(["fixture:seed", "chat:talk", "http:probe"])
    expect(result.ok).toBe(true)
    expect(result.runId).toBe("run-1")
    expect(result.acts.map((a) => a.outcome)).toEqual(["pass", "pass", "pass"])
  })

  it("emits journey.* and act.* events in order", async () => {
    await run(makeJourney(), stubExecutors([]), { runId: "run-2" })

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

    const result = await run(makeJourney(), executors)

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

    const result = await run(makeJourney(), executors)

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

    await run(makeJourney({ params: { productHandle: "costela-bovina-defumada" } }), executors)

    expect(seen[0]).toEqual({
      journeyId: "JOURNEY-001",
      params: { productHandle: "costela-bovina-defumada" },
    })
    expect(seen[1]).toBe("pedido-do-teste")
  })

  it("generates a fresh runId when none is given", async () => {
    const a = await run(makeJourney(), stubExecutors([]))
    const b = await run(makeJourney(), stubExecutors([]))
    expect(a.runId).not.toBe(b.runId)
    expect(a.runId).toMatch(/[0-9a-f-]{36}/)
  })

  it("refuses to run a blocked journey (JourneyBlockedError)", async () => {
    const blocked = makeJourney({ status: "blocked", blocked_by: ["ws4"] })
    await expect(run(blocked, stubExecutors([]))).rejects.toThrow(JourneyBlockedError)
    await expect(run(blocked, stubExecutors([]))).rejects.toThrow(/journey_blocked/)
    expect(events).toHaveLength(0) // nothing emitted for a refused run
  })

  it("runs a blocked journey under allowBlocked (debugging escape hatch)", async () => {
    const blocked = makeJourney({ status: "blocked", blocked_by: ["ws4"] })
    const result = await run(blocked, stubExecutors([]), { allowBlocked: true })
    expect(result.ok).toBe(true)
  })

  it("dispatches a raw-envelope act to the rawEnvelope executor", async () => {
    const log: string[] = []
    const journey = makeJourney({
      acts: [
        {
          kind: "raw-envelope",
          name: "forged-probe",
          envelope: {
            kind: "order.cancel",
            actor: { principal: "system", sessionId: "forged" },
            taint: "TRUSTED",
          },
          expectStatus: 400,
        },
      ],
    })
    const result = await run(journey, stubExecutors(log))

    expect(log).toEqual(["raw-envelope:forged-probe"])
    expect(result.ok).toBe(true)
    expect(result.acts[0]).toMatchObject({ kind: "raw-envelope", outcome: "pass" })
  })

  it("labels unnamed acts act-<n>:<kind>", async () => {
    const journey = makeJourney({
      acts: [{ kind: "chat", goal: "Oi" }],
    })
    const result = await run(journey, stubExecutors([]))
    expect(result.acts[0].name).toBe("act-1:chat")
  })
})

describe("runJourney — mandatory pre-flight (T1a-10)", () => {
  let events: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    events = []
    unsub = onEvent((e) => events.push(e))
  })

  afterEach(() => {
    unsub()
  })

  it("runs the pre-flight as the FIRST step, with journeyId + runId", async () => {
    const order: string[] = []
    const seen: unknown[] = []
    const preflight: PreflightFn = async (args) => {
      order.push("preflight")
      seen.push(args)
      return { ok: true, certifying: true, checks: [] }
    }
    const executors = stubExecutors([])
    executors.fixture = async () => {
      order.push("act")
    }

    await runJourney(makeJourney(), executors, { preflight, runId: "run-pf" })

    expect(order[0]).toBe("preflight")
    expect(order).toContain("act")
    expect(seen[0]).toEqual({ journeyId: "JOURNEY-001", runId: "run-pf" })
  })

  it("propagates PreflightRefusalError — no act runs, no journey.start emitted", async () => {
    const log: string[] = []
    const preflight: PreflightFn = async () => {
      throw new PreflightRefusalError([
        { name: "fingerprint", ok: false, detail: "no testFingerprint" },
      ])
    }

    await expect(
      runJourney(makeJourney(), stubExecutors(log), { preflight }),
    ).rejects.toThrow(PreflightRefusalError)
    await expect(
      runJourney(makeJourney(), stubExecutors(log), { preflight }),
    ).rejects.toThrow(/preflight_refused/)

    expect(log).toHaveLength(0) // no act executed
    expect(events.filter((e) => e.type === "journey.start")).toHaveLength(0)
  })

  it("surfaces the pre-flight certifying flag on the run result", async () => {
    const nonCertifying: PreflightFn = async () => ({
      ok: true,
      certifying: false,
      checks: [],
    })
    const result = await runJourney(makeJourney(), stubExecutors([]), {
      preflight: nonCertifying,
    })
    expect(result.ok).toBe(true)
    expect(result.certifying).toBe(false)

    const certifying = await run(makeJourney(), stubExecutors([]))
    expect(certifying.certifying).toBe(true)
  })

  it("checks blocked status BEFORE the pre-flight (blocked journeys never handshake)", async () => {
    let called = 0
    const preflight: PreflightFn = async () => {
      called += 1
      return { ok: true, certifying: true, checks: [] }
    }
    const blocked = makeJourney({ status: "blocked", blocked_by: ["ws4"] })
    await expect(
      runJourney(blocked, stubExecutors([]), { preflight }),
    ).rejects.toThrow(JourneyBlockedError)
    expect(called).toBe(0)
  })
})
