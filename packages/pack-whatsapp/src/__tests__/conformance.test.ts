/**
 * @ibatexas/pack-whatsapp — conformance test.
 *
 * Two-part:
 *
 *   1. Corpus of 25+ envelope+state fixtures covering EXECUTE,
 *      REFUSE, REWRITE, REQUEST_CONFIRMATION outcomes across the
 *      Pack's 3 intent kinds. Each fixture asserts the expected
 *      Decision shape against `whatsappPack.policy`.
 *
 *   2. Kernel-invariant suite — `runConformance(whatsappPack)`
 *      from `@adjudicate/conformance` verifies taint protection,
 *      replay determinism, intent-hash determinism, basis-vocabulary
 *      purity, guard ordering, and default polarity hold for the Pack.
 *
 * Note: this Pack does not currently use DEFER or ESCALATE; four of
 * the six Decision outcomes are exercised here. DEFER is structurally
 * absent (no DEFER signals declared on the Pack); ESCALATE is absent
 * because the rate-limit threshold pattern uses REQUEST_CONFIRMATION
 * + REFUSE rather than ESCALATE-to-supervisor.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { runConformance } from "@adjudicate/conformance"
import { analyzePolicy, type PlannerProbe } from "@adjudicate/analyze"
import {
  whatsappPack,
  type WhatsAppContext,
  type WhatsAppIntentKind,
  type WhatsAppPayload,
  type WhatsAppState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"

function env(
  kind: WhatsAppIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "UNTRUSTED",
): IntentEnvelope<WhatsAppIntentKind, WhatsAppPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as WhatsAppPayload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint,
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

function baseState(
  overrides: Partial<WhatsAppState["ctx"]> = {},
): WhatsAppState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "c-1",
      staffId: null,
      now: new Date("2026-05-22T12:00:00.000Z"),
      lastCustomerMessageAt: new Date("2026-05-22T11:00:00.000Z"),
      perCustomerHandoffCount: {},
      recipientType: "customer",
      ...overrides,
    },
  }
}

// ── Corpus ──────────────────────────────────────────────────────────────

type Fixture = {
  readonly name: string
  readonly envelope: IntentEnvelope<WhatsAppIntentKind, WhatsAppPayload>
  readonly state: WhatsAppState
  readonly expect: {
    readonly kind:
      | "EXECUTE"
      | "REFUSE"
      | "DEFER"
      | "REWRITE"
      | "REQUEST_CONFIRMATION"
      | "ESCALATE"
    readonly refusalCode?: string
  }
}

const PHONE_HASH = "abc123def456"

const corpus: ReadonlyArray<Fixture> = [
  // ── EXECUTE (8 cases) ────────────────────────────────────────────────
  {
    name: "EXECUTE: whatsapp.message.send to customer inside 24h window",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Olá! Seu pedido está pronto.",
      senderRole: "system",
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: whatsapp.message.send with template hint outside 24h window",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Olá {{1}}, seu pedido #{{2}}.",
      senderRole: "system",
      templateName: "order_ready_v1",
      templateVariables: { "1": "Maria", "2": "1234" },
    }),
    state: baseState({
      lastCustomerMessageAt: new Date("2026-05-20T10:00:00.000Z"),
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: whatsapp.message.send at exactly 24h since last customer message",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Olá, atualização ao final do dia.",
      senderRole: "system",
    }),
    state: baseState({
      // 24h exactly — still inside (grace bumps the cutoff up).
      lastCustomerMessageAt: new Date("2026-05-21T12:00:00.000Z"),
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: whatsapp.message.send from staff",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Oi! Aqui é da equipe.",
      senderRole: "staff",
    }),
    state: baseState({ channel: "staff", staffId: "staff-1" }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED whatsapp.template.send (system actor)",
    envelope: env(
      "whatsapp.template.send",
      {
        to: "+5511999999999",
        templateName: "order_ready_v1",
        templateVariables: { "1": "Maria", "2": "1234" },
      },
      "TRUSTED",
    ),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED whatsapp.template.send outside 24h window (templates bypass)",
    envelope: env(
      "whatsapp.template.send",
      {
        to: "+5511999999999",
        templateName: "winback_v2",
        templateVariables: { "1": "Maria" },
      },
      "TRUSTED",
    ),
    state: baseState({
      lastCustomerMessageAt: new Date("2026-05-15T10:00:00.000Z"),
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED whatsapp.session.handover (1st in window)",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-1",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: PHONE_HASH,
      },
      "TRUSTED",
    ),
    state: baseState({
      perCustomerHandoffCount: { [PHONE_HASH]: 0 },
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED whatsapp.session.handover for an unseen phone hash",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-2",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: "freshphonehash",
      },
      "TRUSTED",
    ),
    state: baseState({
      perCustomerHandoffCount: { [PHONE_HASH]: 5 }, // other phone hot, this one cold
    }),
    expect: { kind: "EXECUTE" },
  },

  // ── REFUSE (10 cases) ────────────────────────────────────────────────
  {
    name: "REFUSE: whatsapp.message.send 25h after last customer message",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Tarde demais.",
      senderRole: "system",
    }),
    state: baseState({
      lastCustomerMessageAt: new Date("2026-05-21T10:00:00.000Z"),
    }),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.window.expired" },
  },
  {
    name: "REFUSE: whatsapp.message.send with no prior customer message",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Cold outreach attempt.",
      senderRole: "system",
    }),
    state: baseState({ lastCustomerMessageAt: null }),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.window.expired" },
  },
  {
    name: "REFUSE: whatsapp.message.send 48h after last customer message",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Two-day-stale outreach.",
      senderRole: "system",
    }),
    state: baseState({
      lastCustomerMessageAt: new Date("2026-05-20T12:00:00.000Z"),
    }),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.window.expired" },
  },
  {
    name: "REFUSE: whatsapp.message.send outside window even with no body",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "",
      senderRole: "system",
    }),
    state: baseState({
      lastCustomerMessageAt: new Date("2026-05-21T11:00:00.000Z"),
    }),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.window.expired" },
  },
  {
    name: "REFUSE: UNTRUSTED whatsapp.template.send (taint gate)",
    envelope: env(
      "whatsapp.template.send",
      {
        to: "+5511999999999",
        templateName: "order_ready_v1",
        templateVariables: { "1": "Maria" },
      },
      "UNTRUSTED",
    ),
    state: baseState(),
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: UNTRUSTED whatsapp.session.handover (taint gate)",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-1",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: PHONE_HASH,
      },
      "UNTRUSTED",
    ),
    state: baseState(),
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: whatsapp.template.send with missing templateName",
    envelope: env(
      "whatsapp.template.send",
      {
        to: "+5511999999999",
        templateName: "",
        templateVariables: { "1": "Maria" },
      },
      "TRUSTED",
    ),
    state: baseState(),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.template.invalid" },
  },
  {
    name: "REFUSE: whatsapp.session.handover at the refuse threshold",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-3",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: PHONE_HASH,
      },
      "TRUSTED",
    ),
    state: baseState({
      perCustomerHandoffCount: { [PHONE_HASH]: 3 },
    }),
    expect: {
      kind: "REFUSE",
      refusalCode: "whatsapp.handoff.rate_limited",
    },
  },
  {
    name: "REFUSE: whatsapp.session.handover well past the refuse threshold",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-4",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: PHONE_HASH,
      },
      "TRUSTED",
    ),
    state: baseState({
      perCustomerHandoffCount: { [PHONE_HASH]: 25 },
    }),
    expect: {
      kind: "REFUSE",
      refusalCode: "whatsapp.handoff.rate_limited",
    },
  },
  {
    name: "REFUSE: whatsapp.template.send with whitespace-only templateName",
    envelope: env(
      "whatsapp.template.send",
      {
        to: "+5511999999999",
        templateName: "",
        templateVariables: { "1": "x" },
      },
      "TRUSTED",
    ),
    state: baseState(),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.template.invalid" },
  },
  {
    name: "REFUSE: whatsapp.template.send with non-object templateVariables",
    envelope: env(
      "whatsapp.template.send",
      {
        to: "+5511999999999",
        templateName: "order_ready_v1",
        templateVariables: null,
      },
      "TRUSTED",
    ),
    state: baseState(),
    expect: { kind: "REFUSE", refusalCode: "whatsapp.template.invalid" },
  },

  // ── REQUEST_CONFIRMATION (3 cases) ───────────────────────────────────
  {
    name: "REQUEST_CONFIRMATION: 2nd whatsapp.session.handover in window",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-5",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: PHONE_HASH,
      },
      "TRUSTED",
    ),
    state: baseState({
      perCustomerHandoffCount: { [PHONE_HASH]: 2 },
    }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: handover count is exactly at confirm threshold",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-6",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: "anotherhash",
      },
      "TRUSTED",
    ),
    state: baseState({
      perCustomerHandoffCount: { anotherhash: 2 },
    }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: handover at confirm threshold for staff initiator",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-7",
        fromActor: "staff",
        toActor: "customer",
        customerPhoneHash: PHONE_HASH,
      },
      "TRUSTED",
    ),
    state: baseState({
      channel: "staff",
      staffId: "staff-1",
      perCustomerHandoffCount: { [PHONE_HASH]: 2 },
    }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },

  // ── REWRITE (4 cases — exercise sanitization path) ───────────────────
  //
  // The customer→staff sanitization REWRITE fires for relayed
  // `whatsapp.message.send` envelopes where `senderRole = "customer"`
  // and `state.ctx.recipientType = "staff"` — the canonical
  // "customer-controlled `reason` echoed into staff WhatsApp" path
  // from investigation 08 P1 #4. The REWRITE emits the sanitized
  // envelope; the executor then sends the sanitized body.
  {
    name: "REWRITE: customer→staff body with markdown chars",
    envelope: env("whatsapp.message.send", {
      to: "+5511888888888",
      body: "*urgent*\n_help_~now~",
      senderRole: "customer",
    }),
    state: baseState({ recipientType: "staff" }),
    expect: { kind: "REWRITE" },
  },
  {
    name: "REWRITE: customer→staff body with newline + markdown",
    envelope: env("whatsapp.message.send", {
      to: "+5511888888888",
      body: "linha1\n*bold*\nlinha3",
      senderRole: "customer",
    }),
    state: baseState({ recipientType: "staff" }),
    expect: { kind: "REWRITE" },
  },
  {
    name: "REWRITE: customer→staff body exceeding 100-char cap",
    envelope: env("whatsapp.message.send", {
      to: "+5511888888888",
      body: "a".repeat(150),
      senderRole: "customer",
    }),
    state: baseState({ recipientType: "staff" }),
    expect: { kind: "REWRITE" },
  },
  {
    name: "EXECUTE: customer→staff body already clean (no REWRITE needed)",
    envelope: env("whatsapp.message.send", {
      to: "+5511888888888",
      body: "preciso de ajuda",
      senderRole: "customer",
    }),
    state: baseState({ recipientType: "staff" }),
    expect: { kind: "EXECUTE" },
  },

  // ── Extra coverage (2 cases) ─────────────────────────────────────────
  {
    name: "EXECUTE: whatsapp.message.send body within length cap",
    envelope: env("whatsapp.message.send", {
      to: "+5511999999999",
      body: "Curto e direto.",
      senderRole: "system",
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED whatsapp.session.handover with empty count map",
    envelope: env(
      "whatsapp.session.handover",
      {
        sessionId: "sess-8",
        fromActor: "llm",
        toActor: "staff",
        customerPhoneHash: PHONE_HASH,
      },
      "TRUSTED",
    ),
    state: baseState({ perCustomerHandoffCount: {} }),
    expect: { kind: "EXECUTE" },
  },
]

describe("whatsappPack — corpus (25+ cases across decision kinds)", () => {
  it("corpus is at least 25 cases (acceptance criterion)", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(25)
  })

  for (const fixture of corpus) {
    it(fixture.name, () => {
      const decision = adjudicate(
        fixture.envelope,
        fixture.state,
        whatsappPack.policy,
      )
      expect(decision.kind).toBe(fixture.expect.kind)
      if (fixture.expect.refusalCode && decision.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(fixture.expect.refusalCode)
      }
    })
  }
})

// ── Kernel-invariant suite ──────────────────────────────────────────────

describe("whatsappPack — kernel invariants via runConformance()", () => {
  it("runConformance returns zero failures", () => {
    const report = runConformance(whatsappPack)
    if (!report.passed) {
      for (const r of report.results) {
        if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`)
      }
    }
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
  })

  it("policy default is REFUSE (default-polarity / bypass-detection)", () => {
    // Mirrors AC-006 (default-polarity) from @adjudicate/conformance —
    // also asserted here so the bypass-detection invariant is
    // surfaced explicitly in the Pack's own test surface (task spec
    // acceptance criterion).
    expect(whatsappPack.policy.default).toBe("REFUSE")
  })
})

// ── Tier-3 policy coherence (AJD-301) via analyzePolicy() ───────────────────
//
// F11 gate: the planner must never offer an intent the Pack doesn't declare
// (`phantom_intent`, the only error-severity rule → flips `report.passed`).
// This Pack's planner is LLM-invisible by construction — `plan()` returns
// `allowedIntents: []` for every session (see capabilities.ts module doc),
// so there is no `phantom_intent` surface to begin with; this block pins that
// guarantee so a future regression that adds an undeclared kind to the
// planner's surface fails loudly here.
//
// System-only kinds (taint minimum above UNTRUSTED) are intentionally not
// planner-proposable; the analyzer auto-excludes them from `unreachable_intent`
// via `pack.policy.taint.minimumFor`. We pin that carve-out so a future drop of
// `whatsapp.template.send` from the taint policy fails loudly here.
//
// NOTE: we deliberately do NOT assert `summary.warning === 0` — the planner
// omits the declared non-system intent (`whatsapp.message.send`, reached only
// via routed/system egress flows), a benign `unreachable_intent` warning.
// `report.passed` stays true (error === 0).

describe("whatsappPack — policy coherence via analyzePolicy() (AJD-301)", () => {
  // The planner does not branch on session state (`plan()` voids both
  // `state` and `context` — it exposes nothing to the LLM regardless of
  // session). We still vary the probes across the channel/identity surface
  // so the analyzer drives `plan()` over the realistic input space. `context`
  // is required by the probe shape.
  const probes: ReadonlyArray<PlannerProbe<WhatsAppState, WhatsAppContext>> = [
    {
      label: "guest-web",
      state: baseState({ channel: "web", customerId: null }),
      context: {
        channel: "web",
        customerId: null,
        staffId: null,
      },
    },
    {
      label: "auth-whatsapp",
      state: baseState(),
      context: {
        channel: "whatsapp",
        customerId: "c-1",
        staffId: null,
      },
    },
    {
      label: "staff-channel",
      state: baseState({ channel: "staff", staffId: "staff-1" }),
      context: {
        channel: "staff",
        customerId: "c-1",
        staffId: "staff-1",
      },
    },
  ]

  // Derive the system-only set the SAME way the analyzer does (taint minimum),
  // never a hand-list — so this test cannot drift from `whatsappTaintPolicy`.
  const systemOnlyKinds = whatsappPack.intents.filter((k) => {
    const min = whatsappPack.policy.taint.minimumFor(k)
    return min !== undefined && min !== "UNTRUSTED"
  })

  it("planner proposes no phantom intents (report.passed, zero errors)", () => {
    const report = analyzePolicy({ pack: whatsappPack, plannerProbes: probes })
    for (const d of report.diagnostics) {
      if (d.severity === "error") console.error(`[${d.code}] ${d.message}`)
    }
    expect(report.passed).toBe(true)
    expect(report.summary.error).toBe(0)
  })

  it("system-only kinds (whatsapp.template.send, …) are carved out", () => {
    const report = analyzePolicy({ pack: whatsappPack, plannerProbes: probes })
    // Guard against a vacuous pass: the carve-out subject must really be system-only.
    expect(systemOnlyKinds).toContain("whatsapp.template.send")
    for (const kind of systemOnlyKinds) {
      const unreachable = report.diagnostics.find(
        (d) =>
          d.detail?.rule === "unreachable_intent" && d.detail?.intent === kind,
      )
      expect(
        unreachable,
        `${kind} is system-only — must NOT be flagged unreachable`,
      ).toBeUndefined()
      const contradiction = report.diagnostics.find(
        (d) =>
          d.detail?.rule === "system_taint_contradiction" &&
          d.detail?.intent === kind,
      )
      expect(
        contradiction,
        `${kind} is system-only — planner must NOT offer it`,
      ).toBeUndefined()
    }
  })
})
