// driver/__tests__/driver.test.ts — T1a-8 acceptance: OFFLINE dry-run of the
// persona driver against a scripted ModelProvider stub.
//
// ZERO tokens / ZERO network: the stub returns deterministic canned tool-use
// responses — the Anthropic SDK is never constructed here (the adapter in
// anthropic-provider.ts is covered by the package type-check). Covered:
//
//   - closed act-tool set: the model sees exactly {chat, http}
//   - 2-act journey dry-run through the T1a-1 runner: act order +
//     ctx.vars threading (act 1 surfaces a handle, act 2's kickoff sees it)
//   - token-ceiling abort: journey.aborted reason=token_ceiling +
//     DriverTokenCeilingError
//   - http tool constraint: declared act honored (asRole from the YAML
//     declaration), undeclared call rejected as an is_error tool_result
//   - maxTurnsPerAct budget: exhaustion fails the act (no throw)
//   - driver.metadata: ANTHROPIC_MODEL + certifying flag (preflight)
//   - JSONL event-kind snapshot: stable field set per event kind

import { describe, expect, it } from "vitest"
import { onEvent, type IbxEventBase } from "@ibatexas/tools"
import { Channel } from "@ibatexas/types"

import type { Journey, HttpAct } from "../../schema/index.js"
import { runJourney, type ActExecutors, type JourneyRunContext } from "../../runner/index.js"
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "../model-provider.js"
import {
  PersonaDriver,
  createDriverChatExecutor,
  DriverTokenCeilingError,
  DEFAULT_DRIVER_MODEL,
  type PersonaDriverOptions,
} from "../persona-driver.js"

// ── Scripted ModelProvider stub (NOT the Anthropic SDK) ──────────────────────

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = []
  readonly #script: ModelResponse[]

  constructor(script: ModelResponse[]) {
    this.#script = [...script]
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Snapshot: the driver mutates its messages array across turns — record
    // the request as the model saw it, not a live alias.
    this.requests.push(structuredClone(request))
    const next = this.#script.shift()
    if (next === undefined) {
      throw new Error(`scripted provider exhausted after ${this.requests.length} calls`)
    }
    return next
  }
}

const usage = (inputTokens: number, outputTokens: number): ModelUsage => ({
  inputTokens,
  outputTokens,
})

function toolUseResponse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  u: ModelUsage = usage(100, 20),
): ModelResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: u }
}

function textResponse(text: string, u: ModelUsage = usage(100, 20)): ModelResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage: u }
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const PREFLIGHT_STUB = async () => ({ ok: true as const, certifying: true, checks: [] })

const ENV_STUB: Record<string, string | undefined> = {
  ANTHROPIC_MODEL: "claude-sonnet-4-6",
}

function makeJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    id: "JOURNEY-901",
    title: "driver dry-run",
    businessCase: "A loyal customer can place an order and amend it over chat",
    persona: "Ana, cliente fiel que pede costela defumada toda sexta-feira",
    channel: Channel.Web,
    acts: [
      { kind: "chat", name: "place-order", goal: "Place an order for one costela" },
      { kind: "chat", name: "confirm-order", goal: "Confirm the order placed in the previous act" },
    ],
    expects: [],
    verify: [],
    status: "active",
    blocked_by: [],
    source: "T1a-8 driver acceptance test",
    ...overrides,
  }
}

function makeDriver(
  journey: Journey,
  provider: ModelProvider,
  overrides: Partial<PersonaDriverOptions> = {},
): { driver: PersonaDriver; chatMessages: string[] } {
  const chatMessages: string[] = []
  const driver = new PersonaDriver({
    journey,
    runId: "run-driver-test",
    provider,
    chatTurn: async (message) => {
      chatMessages.push(message)
      return { replyText: `Pedido IBX-0042 confirmado para: ${message}` }
    },
    certifying: true,
    env: ENV_STUB,
    ...overrides,
  })
  return { driver, chatMessages }
}

function makeExecutors(driver: PersonaDriver): ActExecutors {
  return {
    chat: createDriverChatExecutor(driver),
    http: async () => {
      throw new Error("http executor not used in this test")
    },
    fixture: async () => {
      throw new Error("fixture executor not used in this test")
    },
  }
}

function captureEvents(): { events: IbxEventBase[]; stop: () => void } {
  const events: IbxEventBase[] = []
  const stop = onEvent((event) => events.push(event))
  return { events, stop }
}

function makeCtx(journeyId = "JOURNEY-901"): JourneyRunContext {
  return { journeyId, runId: "run-driver-test", vars: {}, params: {} }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PersonaDriver — closed act-tool set", () => {
  it("offers the model exactly {chat, http} — nothing else, ever", async () => {
    const provider = new ScriptedProvider([textResponse("done")])
    const { driver } = makeDriver(makeJourney(), provider)

    await driver.runChatAct({ kind: "chat", goal: "any goal" }, makeCtx())

    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].tools.map((t) => t.name)).toEqual(["chat", "http"])
  })

  it("reports a closed-set violation back to the model instead of executing", async () => {
    // Defensive path: a hallucinated tool name (e.g. the T3-9 trigger-injection
    // helper, which is NOT an act tool) comes back as an is_error tool_result.
    const provider = new ScriptedProvider([
      toolUseResponse("tu-1", "inject_trigger", { subject: "ibatexas.payment.failed" }),
      textResponse("ok"),
    ])
    const { driver, chatMessages } = makeDriver(makeJourney(), provider)

    const result = await driver.runChatAct({ kind: "chat", goal: "g" }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    expect(chatMessages).toHaveLength(0) // nothing was executed
    const followUp = provider.requests[1].messages.at(-1)
    expect(followUp).toMatchObject({ role: "user" })
    const toolResults = followUp!.content as Array<{ content: string; isError?: boolean }>
    expect(toolResults[0].isError).toBe(true)
    expect(toolResults[0].content).toContain("unknown_act_tool")
    expect(toolResults[0].content).toContain("{chat, http}")
  })
})

describe("PersonaDriver — 2-act journey dry-run (runner-wired)", () => {
  it("runs acts in order, threads ctx.vars across acts, and emits the trace", async () => {
    const provider = new ScriptedProvider([
      // act 1: two persona turns, the second surfacing the order code
      toolUseResponse("tu-1", "chat", { message: "Oi! Quero uma costela defumada." }),
      toolUseResponse("tu-2", "chat", {
        message: "Confirmo o pedido.",
        vars: { orderCode: "IBX-0042" },
      }),
      textResponse("Pedido feito e confirmado."),
      // act 2: model sees ctx.vars in its kickoff and finishes immediately
      textResponse("Pedido já confirmado, nada a fazer."),
    ])
    const journey = makeJourney()
    const { driver, chatMessages } = makeDriver(journey, provider)
    const { events, stop } = captureEvents()

    try {
      const sharedVars: Record<string, unknown> = {}
      const result = await runJourney(journey, makeExecutors(driver), {
        runId: "run-driver-test",
        vars: sharedVars,
        preflight: PREFLIGHT_STUB,
      })

      // act order + outcomes
      expect(result.ok).toBe(true)
      expect(result.certifying).toBe(true)
      expect(result.acts.map((a) => [a.name, a.kind, a.outcome])).toEqual([
        ["place-order", "chat", "pass"],
        ["confirm-order", "chat", "pass"],
      ])

      // the LLM surfaced the handle into ctx.vars (string→string map)
      expect(sharedVars).toEqual({ orderCode: "IBX-0042" })

      // ctx.vars threading: act 2's kickoff message carries act 1's evidence
      expect(provider.requests).toHaveLength(4)
      const act2Kickoff = provider.requests[3].messages[0].content as string
      expect(act2Kickoff).toContain('"orderCode":"IBX-0042"')

      // both persona utterances reached the ChatClient seam, in order
      expect(chatMessages).toEqual(["Oi! Quero uma costela defumada.", "Confirmo o pedido."])

      // trace: full event-kind sequence (llm.call per provider round-trip —
      // the dollar source; evidence.capture at the vars surface point)
      expect(events.map((e) => e.type)).toEqual([
        "journey.start",
        "act.start",
        "llm.call",
        "llm.call",
        "evidence.capture",
        "llm.call",
        "act.end",
        "act.start",
        "llm.call",
        "act.end",
        "journey.end",
      ])
      const llmCalls = events.filter((e) => e.type === "llm.call")
      for (const call of llmCalls) {
        expect(call).toMatchObject({
          model: DEFAULT_DRIVER_MODEL,
          inputTokens: 100,
          outputTokens: 20,
          journey: "JOURNEY-901",
          runId: "run-driver-test",
        })
        expect(typeof call.duration).toBe("number")
      }
      expect(events.find((e) => e.type === "evidence.capture")).toMatchObject({
        evidence: "orderCode",
        detail: "IBX-0042",
      })
    } finally {
      stop()
    }
  })
})

describe("PersonaDriver — budgets", () => {
  it("aborts the attempt over the token ceiling: journey.aborted reason=token_ceiling", async () => {
    const provider = new ScriptedProvider([
      // 900 + 200 = 1100 > ceiling 1000 → abort after accounting the call
      toolUseResponse("tu-1", "chat", { message: "Oi" }, usage(900, 200)),
    ])
    const journey = makeJourney({
      acts: [{ kind: "chat", name: "place-order", goal: "Place an order" }],
    })
    const { driver } = makeDriver(journey, provider, { tokenCeiling: 1_000 })
    const { events, stop } = captureEvents()

    try {
      const result = await runJourney(journey, makeExecutors(driver), {
        runId: "run-driver-test",
        preflight: PREFLIGHT_STUB,
      })

      expect(result.ok).toBe(false)
      expect(result.acts[0].outcome).toBe("error")
      expect(result.error).toContain("driver_token_ceiling")
      expect(driver.tokensUsed).toBe(1_100)

      const kinds = events.map((e) => e.type)
      expect(kinds).toEqual([
        "journey.start",
        "act.start",
        "llm.call", // the over-ceiling call is still accounted (dollar source)
        "journey.aborted",
        "act.end",
        "journey.end",
      ])
      expect(events.find((e) => e.type === "journey.aborted")).toMatchObject({
        journey: "JOURNEY-901",
        runId: "run-driver-test",
        reason: "token_ceiling",
        detail: "tokensUsed=1100 > tokenCeiling=1000",
      })
    } finally {
      stop()
    }
  })

  it("throws the named DriverTokenCeilingError from the act", async () => {
    const provider = new ScriptedProvider([
      toolUseResponse("tu-1", "chat", { message: "Oi" }, usage(900, 200)),
    ])
    const { driver } = makeDriver(makeJourney(), provider, { tokenCeiling: 1_000 })

    await expect(
      driver.runChatAct({ kind: "chat", goal: "g" }, makeCtx()),
    ).rejects.toBeInstanceOf(DriverTokenCeilingError)
  })

  it("fails (not throws) the act when maxTurnsPerAct is exhausted", async () => {
    const provider = new ScriptedProvider([
      toolUseResponse("tu-1", "chat", { message: "turno 1" }),
      toolUseResponse("tu-2", "chat", { message: "turno 2" }),
    ])
    const { driver } = makeDriver(makeJourney(), provider, { maxTurnsPerAct: 2 })

    const result = await driver.runChatAct({ kind: "chat", goal: "g" }, makeCtx())

    expect(result).toMatchObject({ ok: false })
    expect(result?.detail).toContain("max_turns_exhausted")
    expect(result?.detail).toContain("maxTurnsPerAct=2")
  })
})

describe("PersonaDriver — http act tool (constrained, declaration-bound)", () => {
  const declaredHttpAct: HttpAct = {
    kind: "http",
    name: "staff-probe",
    method: "POST",
    path: "/api/orders/intent",
    body: { reason: "declared-body" },
    asRole: "staff",
  }

  it("executes a journey-declared act honoring the DECLARED asRole; rejects undeclared", async () => {
    const provider = new ScriptedProvider([
      // declared act → executed
      toolUseResponse("tu-1", "http", { method: "POST", path: "/api/orders/intent" }),
      // undeclared act → is_error tool_result, never executed
      toolUseResponse("tu-2", "http", { method: "DELETE", path: "/api/admin/secret" }),
      textResponse("done"),
    ])
    const journey = makeJourney({
      acts: [
        { kind: "chat", name: "drive", goal: "Probe the declared staff route" },
        declaredHttpAct,
      ],
    })
    const executed: HttpAct[] = []
    const { driver } = makeDriver(journey, provider, {
      http: async (act) => {
        executed.push(act)
        return { status: 200, body: { ok: true } }
      },
    })

    const result = await driver.runChatAct({ kind: "chat", goal: "g" }, makeCtx())
    expect(result).toMatchObject({ ok: true })

    // exactly ONE http call executed — the declared one, with the YAML role
    expect(executed).toHaveLength(1)
    expect(executed[0].asRole).toBe("staff") // from the DECLARATION, not the model
    expect(executed[0].body).toEqual({ reason: "declared-body" })

    // the declared call's result went back to the model as JSON
    const turn2 = provider.requests[1].messages.at(-1)!
      .content as Array<{ content: string; isError?: boolean }>
    expect(JSON.parse(turn2[0].content)).toEqual({ status: 200, body: { ok: true } })
    expect(turn2[0].isError).toBeUndefined()

    // the undeclared call came back as a named is_error result
    const turn3 = provider.requests[2].messages.at(-1)!
      .content as Array<{ content: string; isError?: boolean }>
    expect(turn3[0].isError).toBe(true)
    expect(turn3[0].content).toContain("undeclared_http_act")
    expect(turn3[0].content).toContain("DELETE /api/admin/secret")
  })
})

describe("PersonaDriver — scripted utterances & metadata", () => {
  it("sends a scripted utterance through the ChatClient seam with ZERO model calls", async () => {
    const provider = new ScriptedProvider([])
    const { driver, chatMessages } = makeDriver(makeJourney(), provider)

    const result = await driver.runChatAct(
      { kind: "chat", utterance: "Oi, tem costela hoje?" },
      makeCtx(),
    )

    expect(result).toMatchObject({ ok: true })
    expect(chatMessages).toEqual(["Oi, tem costela hoje?"])
    expect(provider.requests).toHaveLength(0)
    expect(driver.tokensUsed).toBe(0)
  })

  it("metadata records ANTHROPIC_MODEL + the preflight certifying flag", () => {
    const provider = new ScriptedProvider([])
    const { driver } = makeDriver(makeJourney(), provider, { certifying: false })

    expect(driver.metadata).toEqual({
      driverModel: DEFAULT_DRIVER_MODEL, // IBX_DRIVER_MODEL unset → default
      anthropicModel: "claude-sonnet-4-6",
      certifying: false,
    })
  })

  it("IBX_DRIVER_MODEL overrides the driver model", () => {
    const provider = new ScriptedProvider([])
    const { driver } = makeDriver(makeJourney(), provider, {
      env: { ...ENV_STUB, IBX_DRIVER_MODEL: "claude-haiku-4-5" },
    })

    expect(driver.metadata.driverModel).toBe("claude-haiku-4-5")
  })
})

describe("PersonaDriver — JSONL event-kind snapshot", () => {
  it("emits a stable field set per event kind", async () => {
    const { events, stop } = captureEvents()
    try {
      // Happy run (journey.start/act.*/llm.call/evidence.capture/journey.end)…
      const happyProvider = new ScriptedProvider([
        toolUseResponse("tu-1", "chat", { message: "Oi", vars: { orderCode: "IBX-0042" } }),
        textResponse("feito"),
        textResponse("nada a fazer"),
      ])
      const journey = makeJourney()
      const happy = makeDriver(journey, happyProvider)
      await runJourney(journey, makeExecutors(happy.driver), {
        runId: "run-driver-test",
        preflight: PREFLIGHT_STUB,
      })

      // …plus an aborted run so journey.aborted is in the snapshot too.
      const abortProvider = new ScriptedProvider([
        toolUseResponse("tu-1", "chat", { message: "Oi" }, usage(900, 200)),
      ])
      const aborted = makeDriver(journey, abortProvider, { tokenCeiling: 1_000 })
      await runJourney(journey, makeExecutors(aborted.driver), {
        runId: "run-driver-test",
        preflight: PREFLIGHT_STUB,
      })

      // Every kind emits the SAME field set on every occurrence…
      const fieldSets: Record<string, string[]> = {}
      for (const event of events) {
        const fields = Object.keys(event).sort()
        const seen = fieldSets[event.type]
        if (seen === undefined) fieldSets[event.type] = fields
        else expect(fields, `unstable field set for ${event.type}`).toEqual(seen)
      }

      // …and the per-kind field sets are pinned (the JSONL trace contract).
      expect(fieldSets).toEqual({
        "journey.start": ["journey", "runId", "timestamp", "type"],
        "act.start": ["act", "actIndex", "actKind", "journey", "runId", "timestamp", "type"],
        "llm.call": [
          "duration",
          "inputTokens",
          "journey",
          "model",
          "outputTokens",
          "runId",
          // T1a-13: driver llm.calls are stamped source:"driver" so the cost
          // report splits them from the SUT-side events (source:"sut").
          "source",
          "timestamp",
          "type",
        ],
        "evidence.capture": ["detail", "evidence", "journey", "runId", "timestamp", "type"],
        "act.end": [
          "act",
          "actIndex",
          "actKind",
          "detail",
          "duration",
          "journey",
          "outcome",
          "runId",
          "timestamp",
          "type",
        ],
        "journey.aborted": ["detail", "journey", "reason", "runId", "timestamp", "type"],
        "journey.end": ["duration", "journey", "outcome", "runId", "timestamp", "type"],
      })

      // Surface the snapshot in the verify output (English test/CLI output).
      console.log(`driver JSONL event-kind snapshot: ${JSON.stringify(fieldSets)}`)
    } finally {
      stop()
    }
  })
})
