// Derivation-layer pins for the RCA workbench — the "methodology as code"
// (rcaClient.ts) that turns the raw three-lane wire shape into the pipeline,
// the merged timeline, and the GAP synthesis. These encode the 2026-07-13
// deepening scan's hard-won truths so they cannot silently regress:
//   · classification is persona-based, NEVER positional (claims-ON = 3 calls)
//   · absence is only a signal when the lane actually answered (degraded
//     lanes must suppress GAP ghosts and read "silent", never "ok"/"off")
//   · reply.sent is the delivery verdict (incl. paused = designed silence)

import { describe, expect, it } from "vitest"
import {
  buildLinks,
  buildWireSections,
  derivePipeline,
  mergeTimeline,
  personaPhase,
  promptIdForPersona,
  type AdjDecision,
  type InvestigationContext,
  type LlmCall,
  type RcaTurnDetail,
  type VlLine,
  type WireExchange,
} from "../rcaClient"

// ── fixture builders ────────────────────────────────────────────────────────

const T0 = "2026-07-09T10:00:00.000Z"
const T1 = "2026-07-09T10:00:01.000Z"
const T2 = "2026-07-09T10:00:02.000Z"

function ctx(over: Partial<InvestigationContext> = {}): InvestigationContext {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    noncePrefix: "conv-1:",
    chatCuid: null,
    phoneHash: null,
    sessionHashed: null,
    channel: "whatsapp",
    startedAt: T0,
    endedAt: T2,
    durationMs: 2000,
    ...over,
  }
}

function call(over: Partial<LlmCall> = {}): LlmCall {
  return {
    callIndex: 0,
    persona: "ibatexas/planner.persona@aaa1111",
    model: "nemotron",
    temperature: 0,
    intentHash: null,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 300,
    completion: "ok",
    recordedAt: T1,
    ...over,
  }
}

function vl(over: Partial<VlLine> = {}): VlLine {
  return { time: T1, level: "30", component: "conductor", msg: "", fields: null, ...over }
}

function adj(over: Partial<AdjDecision> = {}): AdjDecision {
  return {
    recordedAt: T1,
    kind: "order.item.add",
    decisionKind: "EXECUTE",
    refusalKind: null,
    refusalCode: null,
    taint: null,
    principal: "llm",
    decisionBasis: [],
    durationMs: 3,
    nonce: null,
    intentHash: "ih-1",
    scope: "turn",
    supersedes: null,
    ...over,
  }
}

function D(over: Partial<RcaTurnDetail> = {}): RcaTurnDetail {
  return { context: ctx(), llm: [], adj: [], vl: [], wire: [], degraded: { adj: false, vl: false, wire: false }, ...over }
}

// ── persona classification (NEVER positional) ───────────────────────────────

describe("personaPhase / promptIdForPersona", () => {
  it("classifies by prefix — claim-planner before planner (shared prefix)", () => {
    expect(personaPhase("ibatexas/planner.persona@a")).toBe("planner")
    expect(personaPhase("ibatexas/claim-planner.persona@b")).toBe("claim-planner")
    expect(personaPhase("ibatexas/responder.grounded@c")).toBe("responder")
    expect(personaPhase(null)).toBeNull()
  })

  it("classifies the ops plane's personas too (ops/* runs the same loop)", () => {
    expect(personaPhase("ops/planner.persona@d")).toBe("planner")
    expect(personaPhase("ops/responder.grounded@e")).toBe("responder")
  })

  it("strips the content hash to recover the prompt-catalog id", () => {
    expect(promptIdForPersona("ibatexas/planner.persona@aaa1111")).toBe("ibatexas/planner.persona")
    expect(promptIdForPersona("not-a-catalog-id@x")).toBeNull()
    expect(promptIdForPersona(null)).toBeNull()
  })
})

// ── derivePipeline ──────────────────────────────────────────────────────────

const CLAIMS_ON_CALLS = [
  call({ callIndex: 0, persona: "ibatexas/planner.persona@a" }),
  call({ callIndex: 1, persona: "ibatexas/claim-planner.persona@b", completion: "{claims}" }),
  call({ callIndex: 2, persona: "ibatexas/responder.grounded@c", outputTokens: 42, completion: "olá" }),
]

function stage(d: RcaTurnDetail, key: string) {
  const s = derivePipeline(d).find((x) => x.key === key)
  if (s === undefined) throw new Error(`no stage ${key}`)
  return s
}

describe("derivePipeline — claims-ON 3-call turn", () => {
  it("reads the responder from the RESPONDER call, not callIndex 1", () => {
    const d = D({ llm: CLAIMS_ON_CALLS })
    expect(stage(d, "responder")).toMatchObject({ state: "ok", sub: "42 tok" })
    expect(stage(d, "claims")).toMatchObject({ state: "ok", sub: "engaged" })
    expect(stage(d, "planner")).toMatchObject({ state: "ok", sub: "call 0" })
  })

  it("flags an empty responder (the last responder call wins)", () => {
    const d = D({
      llm: [
        ...CLAIMS_ON_CALLS.slice(0, 2),
        call({ callIndex: 2, persona: "ibatexas/responder.persona@c", outputTokens: 0, completion: "" }),
      ],
    })
    expect(stage(d, "responder")).toMatchObject({ state: "warn", sub: "empty" })
  })
})

describe("derivePipeline — kernel stage", () => {
  it("excludes archiver appends: bookkeeping is not an envelope", () => {
    const d = D({ adj: [adj({ kind: "conversation.message.append" })] })
    expect(stage(d, "kernel")).toMatchObject({ state: "silent", sub: "no envelopes" })
  })

  it("reads silent (not 'no envelopes') when the ADJ lane degraded", () => {
    const d = D({ degraded: { adj: true, vl: false, wire: false } })
    expect(stage(d, "kernel")).toMatchObject({ state: "silent", sub: "ADJ degraded" })
  })

  it("surfaces the most governance-significant decision", () => {
    const d = D({ adj: [adj(), adj({ decisionKind: "REFUSE" })] })
    expect(stage(d, "kernel")).toMatchObject({ state: "warn", sub: "REFUSE ×2" })
  })
})

describe("derivePipeline — claims stage", () => {
  it("is off when never engaged", () => {
    expect(stage(D(), "claims")).toMatchObject({ state: "off", sub: "not engaged" })
  })

  it("warns on a degraded/UNKNOWN terminal posture", () => {
    const d = D({
      llm: [call({ persona: "ibatexas/claim-planner.persona@b" })],
      vl: [vl({ fields: { event: "claims.terminal", kernelTerminal: "UNKNOWN" } })],
    })
    expect(stage(d, "claims")).toMatchObject({ state: "warn", sub: "UNKNOWN" })
  })

  it("reads silent when engaged but the VL lane degraded", () => {
    const d = D({
      llm: [call({ persona: "ibatexas/claim-planner.persona@b" })],
      degraded: { adj: false, vl: true, wire: false },
    })
    expect(stage(d, "claims")).toMatchObject({ state: "silent", sub: "engaged · VL degraded" })
  })
})

describe("derivePipeline — send stage (reply.sent is the verdict)", () => {
  it("delivered", () => {
    const d = D({ vl: [vl({ fields: { event: "reply.sent", disposition: "deliverable", textSent: "true" } })] })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "delivered" })
  })

  it("delivered via the canonical deliveredText boolean (server now carries it)", () => {
    const d = D({ vl: [vl({ fields: { event: "reply.sent", disposition: "deliverable", deliveredText: "true" } })] })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "delivered" })
  })

  it("paused suppression is designed silence, not a failure", () => {
    const d = D({ vl: [vl({ fields: { event: "reply.sent", disposition: "suppressed_paused" } })] })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "paused · designed silence" })
  })

  it("not delivered carries the disposition", () => {
    const d = D({ vl: [vl({ fields: { event: "reply.sent", disposition: "empty_completion" } })] })
    expect(stage(d, "send")).toMatchObject({ state: "fail", sub: "not delivered (empty_completion)" })
  })

  it("whatsapp with a degraded VL lane reads silent — never 'no send event'", () => {
    const d = D({ degraded: { adj: false, vl: true, wire: false } })
    expect(stage(d, "send")).toMatchObject({ state: "silent", sub: "VL degraded" })
  })

  it("web: the conductor turn line's redacted response is the reply evidence", () => {
    const d = D({
      context: ctx({ channel: "web" }),
      vl: [vl({ fields: { event: "turn", response: "olá" } })],
    })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "replied" })
  })
})

// ── mergeTimeline ───────────────────────────────────────────────────────────

describe("mergeTimeline", () => {
  it("orders events across lanes by time; unknown times sink to the end", () => {
    const d = D({
      llm: [call({ recordedAt: T2 })],
      adj: [adj({ recordedAt: T0 })],
      vl: [vl({ time: T1 }), vl({ time: null, msg: "no-time" })],
    })
    const sources = mergeTimeline(d).map((e) => e.source)
    expect(sources.slice(0, 3)).toEqual(["ADJ", "VL", "LLM"])
    expect(sources[sources.length - 1]).toBe("VL") // the time-less line sorts last
  })

  it("synthesizes a GAP for a whatsapp turn with zero delivery evidence", () => {
    const d = D({ llm: [call()] })
    expect(mergeTimeline(d).some((e) => e.source === "GAP")).toBe(true)
  })

  it("suppresses the GAP when the VL lane degraded — absence is only a signal when the lane answered", () => {
    const d = D({ llm: [call()], degraded: { adj: false, vl: true, wire: false } })
    expect(mergeTimeline(d).some((e) => e.source === "GAP")).toBe(false)
  })

  it("suppresses the GAP when reply.sent exists (any disposition)", () => {
    const d = D({
      llm: [call()],
      vl: [vl({ fields: { event: "reply.sent", disposition: "suppressed_paused" } })],
    })
    expect(mergeTimeline(d).some((e) => e.source === "GAP")).toBe(false)
  })

  it("never mints a GAP for non-whatsapp channels", () => {
    const d = D({ context: ctx({ channel: "web" }), llm: [call()] })
    expect(mergeTimeline(d).some((e) => e.source === "GAP")).toBe(false)
  })

  it("marks empty LLM calls and carries the prompt-catalog id for the jump", () => {
    const d = D({ llm: [call({ outputTokens: 0, completion: "" })] })
    const ev = mergeTimeline(d).find((e) => e.source === "LLM")
    expect(ev?.empty).toBe(true)
    expect(ev?.promptId).toBe("ibatexas/planner.persona")
  })
})

// ── buildLinks ──────────────────────────────────────────────────────────────

describe("buildLinks", () => {
  it("queries VictoriaLogs by BOTH id bindings (correlationId + turnId)", () => {
    const links = buildLinks(ctx())
    expect(links.victoriaLogs).toContain(encodeURIComponent("correlationId:turn-1 OR turnId:turn-1"))
  })

  it("drops the adjudicate console link when the conversation is unknown", () => {
    expect(buildLinks(ctx({ conversationId: null })).adjConsole).toBeNull()
  })
})

// ── Wire Truth — wire attachment + section building ─────────────────────────

function wx(over: Partial<WireExchange> = {}): WireExchange {
  return {
    seq: 0,
    callIndex: 0,
    model: "nemotron-3-nano:4b",
    request: {
      model: "nemotron-3-nano:4b",
      temperature: 0,
      max_tokens: 1024,
      reasoning_effort: "none",
      messages: [
        { role: "system", content: "Você é um atendente." },
        { role: "user", content: "oi" },
      ],
    },
    response: { choices: [{ message: { content: "", reasoning: "Vou responder." }, finish_reason: "stop" }] },
    requestHash: "a".repeat(64),
    requestTruncated: false,
    responseTruncated: false,
    recordedAt: T1,
    ...over,
  }
}

describe("mergeTimeline — wire attachment", () => {
  it("attaches a call's wire attempts (retries included) to its LLM row", () => {
    const d = D({
      llm: [call({ callIndex: 0 })],
      wire: [wx({ seq: 0, callIndex: 0 }), wx({ seq: 1, callIndex: 0 })],
    })
    const ev = mergeTimeline(d).find((e) => e.source === "LLM")
    expect(ev?.wire).toHaveLength(2)
    expect(ev?.text).toContain("wire×2")
    // An LLM row with wire is expandable even when the completion is empty.
    expect(ev?.detail).toBeDefined()
  })

  it("surfaces an unmatched wire attempt as its own row — never silently dropped", () => {
    const d = D({ llm: [call({ callIndex: 0 })], wire: [wx({ seq: 5, callIndex: 3 })] })
    const rows = mergeTimeline(d).filter((e) => e.source === "LLM")
    expect(rows).toHaveLength(2)
    const orphan = rows.find((e) => e.text.includes("unmatched"))
    expect(orphan?.wire).toHaveLength(1)
  })

  it("tolerates a pre-capture API response with no wire lane", () => {
    const d = D({ llm: [call()] })
    // simulate the previous wire shape from a not-yet-restarted API
    delete (d as { wire?: unknown }).wire
    expect(() => mergeTimeline(d)).not.toThrow()
    expect(mergeTimeline(d).find((e) => e.source === "LLM")?.wire).toBeUndefined()
  })
})

describe("buildWireSections", () => {
  it("splits an OpenAI-shaped request into params / messages / response", () => {
    const s = buildWireSections(wx())
    expect(s.params).toContain("model=nemotron-3-nano:4b")
    expect(s.params).toContain("reasoning_effort=none")
    expect(s.params).toContain("max_tokens=1024")
    expect(s.messages).toEqual([
      { role: "system", content: "Você é um atendente." },
      { role: "user", content: "oi" },
    ])
    expect(s.tools).toEqual([])
    expect(s.response).toContain("Vou responder.")
    expect(s.truncated).toEqual({ request: false, response: false })
  })

  it("lists the tool roster with per-tool schemas", () => {
    const s = buildWireSections(
      wx({
        request: {
          model: "m",
          messages: [{ role: "user", content: "refund" }],
          tools: [
            {
              type: "function",
              function: { name: "express_intent", parameters: { type: "object" } },
            },
          ],
          response_format: { type: "json_object" },
        },
      }),
    )
    expect(s.tools).toEqual([{ name: "express_intent", schema: JSON.stringify({ type: "object" }, null, 2) }])
    expect(s.params).toContain('response_format={"type":"json_object"}')
  })

  it("degrades a truncation marker to raw JSON with the flag surfaced", () => {
    const s = buildWireSections(
      wx({
        request: { __truncated: true, originalBytes: 99999, head: "{...}" },
        requestTruncated: true,
      }),
    )
    expect(s.truncated.request).toBe(true)
    expect(s.messages).toEqual([])
    // Non-standard bodies go to the scroll-capped raw block, never the params line.
    expect(s.params).toBe("(non-standard request body)")
    expect(s.raw).toContain("__truncated")
  })
})
