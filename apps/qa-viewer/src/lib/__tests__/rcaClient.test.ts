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
  claimsFlow,
  conductorDecision,
  deliveryState,
  derivePipeline,
  draftVsShipped,
  groupsOrFallback,
  mergeTimeline,
  parseTypesField,
  personaPhase,
  promptIdForPersona,
  replyProvenance,
  rollupDelivery,
  stageFacts,
  templateRef,
  type AdjDecision,
  type DeliveryRecord,
  type InvestigationContext,
  type LlmCall,
  type RcaConversation,
  type RcaConversationGroup,
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
  return { context: ctx(), llm: [], adj: [], vl: [], wire: [], delivery: [], degraded: { adj: false, vl: false, wire: false, delivery: false }, ...over }
}

/** LE2-030 — one whatsapp_delivery row (a captured SID + its latest status). */
function del(over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    messageSid: "SM_0",
    partIndex: 0,
    status: null,
    sentAt: T1,
    statusAt: null,
    errorCode: null,
    errorMessage: null,
    callbackCount: 0,
    source: "send",
    ...over,
  }
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
    const d = D({ degraded: { adj: false, vl: true, wire: false, delivery: false } })
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

// ── LE2-030: Twilio delivery confirmation outranks reply.sent ───────────────

describe("deliveryState / rollupDelivery", () => {
  it("maps Twilio's vocabulary onto the three workbench states", () => {
    expect(deliveryState("delivered")).toBe("delivered")
    expect(deliveryState("read")).toBe("delivered")
    expect(deliveryState("failed")).toBe("failed")
    expect(deliveryState("undelivered")).toBe("failed")
    expect(deliveryState("canceled")).toBe("failed")
    // In-flight and "no callback yet" are the SAME honest answer: pending.
    expect(deliveryState("sent")).toBe("pending")
    expect(deliveryState("queued")).toBe("pending")
    expect(deliveryState(null)).toBe("pending")
  })

  it("returns null with no rows (a pre-capture or web turn)", () => {
    expect(rollupDelivery([])).toBeNull()
  })

  it("one failed part fails the whole reply; one unconfirmed keeps it pending", () => {
    expect(
      rollupDelivery([del({ status: "delivered" }), del({ status: "failed", partIndex: 1 })]),
    ).toMatchObject({ state: "failed", delivered: 1, failed: 1, pending: 0, total: 2 })
    expect(
      rollupDelivery([del({ status: "delivered" }), del({ status: null, partIndex: 1 })]),
    ).toMatchObject({ state: "pending", delivered: 1, failed: 0, pending: 1 })
    expect(
      rollupDelivery([del({ status: "delivered" }), del({ status: "read", partIndex: 1 })]),
    ).toMatchObject({ state: "delivered", delivered: 2 })
  })
})

describe("derivePipeline — send stage (LE2-030: delivered / failed / pending)", () => {
  const sent = vl({ fields: { event: "reply.sent", disposition: "deliverable", deliveredText: "true" } })

  it("delivered — every captured part confirmed by Twilio", () => {
    const d = D({ vl: [sent], delivery: [del({ status: "delivered" })] })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "delivered" })
  })

  it("failed — Twilio said the reply never landed, even though reply.sent claimed delivery", () => {
    const d = D({
      vl: [sent],
      delivery: [del({ status: "undelivered", errorCode: "63024" })],
    })
    expect(stage(d, "send")).toMatchObject({ state: "fail", sub: "failed · 1/1 not delivered" })
  })

  it("pending — accepted by Twilio, no callback yet: silent, never a failure", () => {
    const d = D({ vl: [sent], delivery: [del({ status: null })] })
    expect(stage(d, "send")).toMatchObject({ state: "silent", sub: "pending · 1/1 unconfirmed" })
  })

  it("counts multi-part replies", () => {
    const d = D({
      vl: [sent],
      delivery: [del({ status: "delivered" }), del({ status: "delivered", partIndex: 1 })],
    })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "delivered (2 parts)" })
  })

  it("a paused turn stays designed silence — it has no SIDs to confirm", () => {
    const d = D({
      vl: [vl({ fields: { event: "reply.sent", disposition: "suppressed_paused" } })],
      delivery: [],
    })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "paused · designed silence" })
  })

  it("falls back to the reply.sent verdict when no delivery rows exist (pre-capture turn)", () => {
    const d = D({ vl: [sent], delivery: [] })
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "delivered" })
  })

  it("tolerates an older API that sends no delivery field at all", () => {
    const d = D({ vl: [sent] })
    delete (d as { delivery?: unknown }).delivery
    expect(stage(d, "send")).toMatchObject({ state: "ok", sub: "delivered" })
  })
})

describe("stageFacts — send stage carries the per-part delivery evidence", () => {
  it("leads with the rollup, then one line per part", () => {
    const d = D({
      vl: [vl({ fields: { event: "reply.sent", deliveredText: "true" } })],
      delivery: [
        del({ messageSid: "SM_a", status: "delivered", statusAt: T2 }),
        del({
          messageSid: "SM_b",
          partIndex: 1,
          status: "failed",
          statusAt: T2,
          errorCode: "63016",
          errorMessage: "Failed to send freeform message",
        }),
      ],
    })
    const facts = stageFacts(d, "send")
    expect(facts[0]).toBe("delivery: 1 delivered · 1 failed · 0 pending (2 parts)")
    expect(facts[1]).toContain("SM_a")
    expect(facts[1]).toContain("delivered")
    expect(facts[2]).toContain("SM_b")
    expect(facts[2]).toContain("failed")
    expect(facts[2]).toContain("63016")
    // The reply.sent fields still follow.
    expect(facts).toContain("deliveredText: true")
  })

  it("says so explicitly when a part has no callback yet", () => {
    const d = D({ delivery: [del({ messageSid: "SM_c" })] })
    expect(stageFacts(d, "send")[1]).toContain("no callback yet")
  })

  it("never mints a verdict from a degraded delivery lane", () => {
    const d = D({ delivery: [], degraded: { adj: false, vl: false, wire: false, delivery: true } })
    expect(stageFacts(d, "send")).toContain("delivery lane degraded — absence is not a signal here")
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

// ── stage attribution (the donut drill-down filter) ─────────────────────────

describe("mergeTimeline — stage attribution", () => {
  it("tags LLM rows by persona phase — claim-planner lands under the claims donut", () => {
    const d = D({
      llm: [
        call({ callIndex: 0, persona: "ibatexas/planner.persona@a" }),
        call({ callIndex: 1, persona: "ibatexas/claim-planner.persona@b" }),
        call({ callIndex: 2, persona: "ibatexas/responder.grounded@c" }),
      ],
    })
    const stages = mergeTimeline(d)
      .filter((e) => e.source === "LLM")
      .map((e) => e.stage)
    expect(stages).toEqual(["planner", "claims", "responder"])
  })

  it("tags ADJ rows kernel vs archive — archiver bookkeeping is not a kernel mutation", () => {
    const d = D({
      adj: [adj({ kind: "order.item.add" }), adj({ kind: "conversation.message.append" })],
      vl: [vl({ fields: { event: "reply.sent", deliveredText: "true" } })],
    })
    const byKind = new Map(mergeTimeline(d).filter((e) => e.source === "ADJ").map((e) => [e.text.split(" ")[0], e.stage]))
    expect(byKind.get("order.item.add")).toBe("kernel")
    expect(byKind.get("conversation.message.append")).toBe("archive")
  })

  it("tags reply.sent VL lines and the GAP ghost as the send stage", () => {
    const sent = D({ llm: [call()], vl: [vl({ fields: { event: "reply.sent", deliveredText: "true" } })] })
    expect(mergeTimeline(sent).find((e) => e.source === "VL")?.stage).toBe("send")
    const ghost = D({ llm: [call()] })
    expect(mergeTimeline(ghost).find((e) => e.source === "GAP")?.stage).toBe("send")
  })
})

// ── stageFacts (the donut's evidence panel) ─────────────────────────────────

describe("stageFacts", () => {
  it("kernel: lists real envelopes with decision + refusal, excludes archiver rows", () => {
    const d = D({
      adj: [
        adj({ kind: "order.cancel", decisionKind: "REQUEST_CONFIRMATION" }),
        adj({ kind: "conversation.message.append" }),
      ],
    })
    const facts = stageFacts(d, "kernel")
    expect(facts).toHaveLength(1)
    expect(facts[0]).toContain("order.cancel → REQUEST_CONFIRMATION")
  })

  it("kernel: a degraded ADJ lane reads degraded, never 'no envelopes'", () => {
    const d = D({ degraded: { adj: true, vl: false, wire: false } })
    expect(stageFacts(d, "kernel")[0]).toContain("degraded")
  })

  it("responder: carries the reply text; send: surfaces the reply.sent fields", () => {
    const d = D({
      llm: [call({ persona: "ibatexas/responder.grounded@c", completion: "olá!" })],
      vl: [vl({ fields: { event: "reply.sent", disposition: "delivered", deliveredText: "true" } })],
    })
    expect(stageFacts(d, "responder").some((f) => f.startsWith("reply: olá!"))).toBe(true)
    expect(stageFacts(d, "send")).toEqual(["disposition: delivered", "deliveredText: true"])
  })

  it("returns [] for an unknown stage key — never throws", () => {
    expect(stageFacts(D(), "nope")).toEqual([])
  })
})

// ── LE2-031: the rail's grouped shape ───────────────────────────────────────
// Grouping itself is a SERVER concern (apps/api qa-rca-grouping.ts, pinned
// there). What the client owns is the degradation: an API build that does not
// group must not make the rail lie about identity.

describe("groupsOrFallback", () => {
  const rows: RcaConversation[] = [
    {
      sessionId: "sess-1",
      chatCuid: null,
      channel: "whatsapp",
      startedAt: T0,
      lastAt: T2,
      lastText: null,
      lastRole: null,
      turnCount: 2,
    },
  ]

  it("passes the server's groups through untouched when they are present", () => {
    const groups: RcaConversationGroup[] = [
      {
        groupKey: "customer:cus_1",
        kind: "customer",
        label: "cus_1",
        customerId: "cus_1",
        phoneHash: null,
        staffId: null,
        sessionIds: ["sess-1"],
        channels: ["whatsapp"],
        sessionCount: 1,
        turnCount: 2,
        startedAt: T0,
        lastAt: T2,
      },
    ]
    expect(groupsOrFallback(rows, groups)).toEqual({ groups, ungrouped: false })
  })

  it("falls back to one row per session — and NEVER calls them unidentified", () => {
    const out = groupsOrFallback(rows, undefined)
    expect(out.ungrouped).toBe(true)
    expect(out.groups).toHaveLength(1)
    // "unidentified" is a server finding about the data; "ungrouped" is a fact
    // about this API build. Conflating them would fabricate a finding.
    expect(out.groups[0]!.kind).toBe("ungrouped")
    expect(out.groups[0]!.groupKey).toBe("session:sess-1")
    expect(out.groups[0]!.sessionIds).toEqual(["sess-1"])
    expect(out.groups[0]!.customerId).toBeNull()
  })

  it("keeps the fallback key stable across refreshes (it is the session id)", () => {
    const a = groupsOrFallback(rows, undefined).groups.map((g) => g.groupKey)
    const b = groupsOrFallback([{ ...rows[0]!, turnCount: 9 }], undefined).groups.map((g) => g.groupKey)
    expect(b).toEqual(a)
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

// ── RCA-legibility: reply provenance / draft-vs-shipped / claims flow ───────
// Live-anchored: the fixtures mirror the 2026-07-29 forensic pair — the
// menu-dump turn (validated MENU_OVERVIEW render superseding a correct draft)
// and the lasagna turn (out-of-enum "MENU_ITEALLEGENS" → forced CLARIFY →
// the record-disambiguation safe template as a non-sequitur).

describe("parseTypesField", () => {
  it("parses a pre-stringified array field", () => {
    expect(parseTypesField('["MENU_OVERVIEW","STORE_INFO"]')).toEqual(["MENU_OVERVIEW", "STORE_INFO"])
  })

  it("keeps null ≠ empty-list: absent field is null, present-empty is []", () => {
    expect(parseTypesField(undefined)).toBeNull()
    expect(parseTypesField(null)).toBeNull()
    expect(parseTypesField("")).toBeNull()
    expect(parseTypesField("[]")).toEqual([])
  })

  it("degrades a non-JSON scalar (legacy/flattened encoding) to a one-element list", () => {
    expect(parseTypesField("MENU_OVERVIEW")).toEqual(["MENU_OVERVIEW"])
  })
})

// The VL lines of the live menu-dump turn (dab47ee8…), minimally.
const MENU_TURN_VL = [
  vl({ component: "claim-planner", fields: { event: "claim_planner.classify_only", candidateTypes: '["MENU_OVERVIEW"]' } }),
  vl({
    component: "claims",
    fields: {
      event: "claims.terminal",
      posture: "VALIDATED_RENDER",
      kernelTerminal: "RENDER",
      degradedFromRender: "false",
      candidateTypes: '["MENU_OVERVIEW"]',
      validatedTypes: '["MENU_OVERVIEW"]',
      droppedClaimTypes: "[]",
      renderedCount: "1",
    },
  }),
  vl({ component: "conductor", fields: { event: "turn", decisionKind: "REFUSE", response: "No nosso cardápio: …" } }),
]

// The lasagna turn (54151723…): BOTH claims.terminal lines fire (collapse-seam
// safe_degraded + render-path CLARIFY) — the render-path one must win.
const LASAGNA_TURN_VL = [
  vl({ component: "claims", fields: { event: "claims.terminal", posture: "safe_degraded", reason: "ungrounded_question" } }),
  vl({
    component: "claims",
    fields: {
      event: "claims.terminal",
      posture: "CLARIFY",
      kernelTerminal: "CLARIFY",
      degradedFromRender: "false",
      candidateTypes: "[]",
      validatedTypes: "[]",
      droppedClaimTypes: "[]",
      renderedCount: "0",
    },
  }),
  vl({
    component: "claim-planner",
    fields: { event: "claim_planner.proposal_summary", candidateTypes: "[]", droppedClaimTypes: '["MENU_ITEALLEGENS"]', forcedTerminal: "CLARIFY" },
  }),
  vl({
    component: "claims",
    fields: { event: "claims.template_selected", terminal: "CLARIFY", templateId: "__SAFE_CLARIFY__", degradedFromRender: "false" },
  }),
  vl({ component: "conductor", fields: { event: "turn", decisionKind: "REFUSE", response: "Tenho mais de um registro possível…" } }),
]

describe("replyProvenance", () => {
  it("attributes a validated render, naming the claim types and the classify-only path", () => {
    const p = replyProvenance(
      D({
        llm: [call()],
        vl: [...MENU_TURN_VL, vl({ component: "claims", fields: { event: "claims.render_precedence", decision: "render", mechanism: "validated_render" } })],
      }),
    )
    expect(p.author).toBe("validated_render")
    expect(p.detail).toContain("MENU_OVERVIEW")
    expect(p.detail).toContain("classify-only")
    expect(p.confidence).toBe("proven")
    expect(p.mechanism).toBe("validated_render")
  })

  it("attributes a safe template by id, with the forcing wall, when the new events are present", () => {
    const p = replyProvenance(D({ llm: CLAIMS_ON_CALLS, vl: [...LASAGNA_TURN_VL, vl({ component: "claims", fields: { event: "claims.render_precedence", decision: "render", mechanism: "safe_degrade" } })] }))
    expect(p.author).toBe("safe_template")
    expect(p.detail).toContain("__SAFE_CLARIFY__")
    expect(p.detail).toContain("forced CLARIFY")
    expect(p.confidence).toBe("proven")
  })

  it("degrades to 'inferred' from claims.terminal alone (older API, no precedence/template events)", () => {
    const p = replyProvenance(D({ llm: [call()], vl: [MENU_TURN_VL[1]!] }))
    expect(p.author).toBe("validated_render")
    expect(p.confidence).toBe("inferred")
  })

  it("keep_draft attributes responder prose, proven", () => {
    const p = replyProvenance(
      D({
        llm: CLAIMS_ON_CALLS,
        vl: [vl({ component: "claims", fields: { event: "claims.render_precedence", decision: "keep_draft", mechanism: "conversational_prose" } })],
      }),
    )
    expect(p.author).toBe("responder_prose")
    expect(p.confidence).toBe("proven")
  })

  it("funnel L0/L1 turns attribute funnel_canned from the conductor line", () => {
    const p = replyProvenance(D({ vl: [vl({ fields: { event: "turn", funnelTier: "L0", funnelReason: "exact_key" } })] }))
    expect(p.author).toBe("funnel_canned")
    expect(p.detail).toContain("L0")
  })

  it("prose_preserved collapse attributes responder prose", () => {
    const p = replyProvenance(
      D({ llm: CLAIMS_ON_CALLS, vl: [vl({ component: "claims", fields: { event: "claims.terminal", posture: "prose_preserved", kernelTerminal: "RENDER", reason: "no_candidates" } })] }),
    )
    expect(p.author).toBe("responder_prose")
  })

  it("never mints an attribution from a degraded VL lane — unknowable, not prose", () => {
    const p = replyProvenance(D({ llm: CLAIMS_ON_CALLS, vl: [], degraded: { adj: false, vl: true, wire: false } }))
    expect(p.confidence).toBe("unknowable")
  })

  it("tolerates an older API that sends no degraded flags at all", () => {
    const d = D({ llm: [call()], vl: [] })
    // simulate the pre-flag wire shape
    delete (d as { degraded?: unknown }).degraded
    expect(() => replyProvenance(d)).not.toThrow()
  })
})

describe("draftVsShipped", () => {
  const draftCall = call({ callIndex: 2, persona: "ibatexas/responder.grounded@c", outputTokens: 9, completion: "Sim, o menu está disponível!" })

  it("render_superseded: the shipped text is the render, not the draft", () => {
    const v = draftVsShipped(
      D({
        llm: [draftCall],
        vl: [
          vl({ fields: { event: "turn", response: "No nosso cardápio: Batata Rústica…" } }),
          vl({ component: "claims", fields: { event: "claims.render_precedence", decision: "render", mechanism: "validated_render" } }),
        ],
      }),
    )
    expect(v.verdict).toBe("render_superseded")
    expect(v.rule).toBe("validated_render")
    expect(v.draft).toContain("menu está disponível")
  })

  it("draft_kept: the precedence verdict wins even without text to compare", () => {
    const v = draftVsShipped(
      D({ llm: [draftCall], vl: [vl({ component: "claims", fields: { event: "claims.render_precedence", decision: "keep_draft", mechanism: "conversational_prose" } })] }),
    )
    expect(v.verdict).toBe("draft_kept")
  })

  it("identical_prefix: normalized prefix equality is the strongest provable match", () => {
    const v = draftVsShipped(
      D({ llm: [draftCall], vl: [vl({ fields: { event: "turn", response: "Sim,  o menu está disponível!" } })] }),
    )
    expect(v.verdict).toBe("identical_prefix")
  })

  it("unknowable: no shipped text (web turn without a turn-line response)", () => {
    const v = draftVsShipped(D({ llm: [draftCall], vl: [] }))
    expect(v.verdict).toBe("unknowable")
  })
})

describe("claimsFlow", () => {
  it("surfaces the out-of-enum drop and the forced terminal from proposal_summary", () => {
    const f = claimsFlow(D({ vl: LASAGNA_TURN_VL }))
    expect(f.outOfEnum).toEqual(["MENU_ITEALLEGENS"])
    expect(f.forcedTerminal).toBe("CLARIFY")
    expect(f.classifyOnly).toBe(false)
  })

  it("classify-only turns report the skip and the candidate types", () => {
    const f = claimsFlow(D({ vl: MENU_TURN_VL }))
    expect(f.classifyOnly).toBe(true)
    expect(f.candidateTypes).toEqual(["MENU_OVERVIEW"])
    expect(f.validatedTypes).toEqual(["MENU_OVERVIEW"])
  })

  it("absent events stay null — never conflated with a present-but-empty list", () => {
    const f = claimsFlow(D({}))
    expect(f.candidateTypes).toBeNull()
    expect(f.outOfEnum).toBeNull()
    expect(f.plannerDemoted).toBeNull()
    expect(f.suppressedTypes).toBeNull()
  })

  it("prefers the render-path claims.terminal line over the collapse-seam line", () => {
    const f = claimsFlow(D({ vl: LASAGNA_TURN_VL }))
    // the collapse line has no type fields; the render-path line's empty sets must win
    expect(f.validatedTypes).toEqual([])
  })
})

describe("conductorDecision — the synthetic empty-plan REFUSE", () => {
  const refuseTurnLine = vl({ fields: { event: "turn", decisionKind: "REFUSE" } })

  it("relabels a zero-envelope REFUSE as READ-ONLY (fail-closed adjudicatePlan([]))", () => {
    const c = conductorDecision(D({ vl: [refuseTurnLine], adj: [adj({ kind: "conversation.message.append" })] }))
    expect(c.synthetic).toBe(true)
    expect(c.label).toBe("READ-ONLY")
  })

  it("a REFUSE with a real refused envelope stays REFUSE", () => {
    const c = conductorDecision(D({ vl: [refuseTurnLine], adj: [adj({ kind: "order.item.add", decisionKind: "REFUSE" })] }))
    expect(c.synthetic).toBe(false)
    expect(c.label).toBe("REFUSE")
  })

  it("never relabels under a degraded ADJ lane — absence of envelopes is not a signal there", () => {
    const c = conductorDecision(D({ vl: [refuseTurnLine], adj: [], degraded: { adj: true, vl: false, wire: false } }))
    expect(c.synthetic).toBe(false)
    expect(c.label).toContain("REFUSE")
  })

  it("non-REFUSE kinds pass through", () => {
    const c = conductorDecision(D({ vl: [vl({ fields: { event: "turn", decisionKind: "EXECUTE" } })], adj: [adj()] }))
    expect(c.synthetic).toBe(false)
    expect(c.label).toBe("EXECUTE")
  })
})

describe("templateRef", () => {
  it("maps every __SAFE_*__ id the slot grammar exports, and only those", () => {
    expect(templateRef("__SAFE_CLARIFY__")?.ticket).toContain("BKL-170")
    expect(templateRef("__SAFE_UNKNOWN_ALLERGEN__")?.ticket).toBe("BKL-184")
    expect(templateRef("__SAFE_ESCALATE_EMERGENCY__")?.ticket).toBe("BKL-209")
    expect(templateRef("__SAFE_CLARIFY_DELIVERY_CEP__")?.ticket).toBe("LE2-002")
    expect(templateRef("__SAFE_CLARIFY_COUPON_CODE__")?.ticket).toBe("LE2-019")
    expect(templateRef("not-a-template")).toBeNull()
  })
})

describe("stageFacts — claims drill-down carries the flow walls", () => {
  it("flags the out-of-enum drop loudly", () => {
    const facts = stageFacts(D({ llm: CLAIMS_ON_CALLS, vl: LASAGNA_TURN_VL }), "claims")
    expect(facts.some((f) => f.includes("OUT-OF-ENUM DROPPED: MENU_ITEALLEGENS"))).toBe(true)
    expect(facts.some((f) => f.includes("FORCED TERMINAL: CLARIFY"))).toBe(true)
  })

  it("names the classify-only skip when there is no claim-planner call", () => {
    const facts = stageFacts(D({ llm: [call()], vl: MENU_TURN_VL }), "claims")
    expect(facts.some((f) => f.includes("classify-only read path"))).toBe(true)
    expect(facts.some((f) => f.includes("no claim-planner call (deterministic path)"))).toBe(true)
  })
})

describe("claims.terminal line selection — collapse-only turns (live turn bf0e874e)", () => {
  // The claim-planner collapse (prose_preserved) fires on the draft, then the
  // responder's ungrounded gate (safe_degraded) replaces the prose with a safe
  // line — with NO render-path emission, the LATEST collapse line is the final
  // disposition, and the reply is the gate's safe template, not model prose.
  const COLLAPSE_ONLY_VL = [
    vl({ component: "claims", fields: { event: "claims.terminal", posture: "prose_preserved", reason: "demoted_to_empty", candidateTypes: '["MENU_OVERVIEW"]', droppedClaimTypes: '["MENU_OVERVIEW"]' } }),
    vl({ component: "claims", fields: { event: "claims.terminal", posture: "safe_degraded", reason: "ungrounded_question" } }),
  ]

  it("attributes the safe-degraded gate (latest collapse line), not preserved prose", () => {
    const p = replyProvenance(D({ llm: CLAIMS_ON_CALLS, vl: COLLAPSE_ONLY_VL }))
    expect(p.author).toBe("safe_template")
    expect(p.detail).toContain("safe_degraded")
  })

  it("a lone prose_preserved collapse still attributes responder prose", () => {
    const p = replyProvenance(D({ llm: CLAIMS_ON_CALLS, vl: [COLLAPSE_ONLY_VL[0]!] }))
    expect(p.author).toBe("responder_prose")
  })
})
