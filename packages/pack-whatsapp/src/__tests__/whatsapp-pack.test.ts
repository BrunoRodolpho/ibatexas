/**
 * @ibatexas/pack-whatsapp — per-guard unit tests.
 *
 * Each guard tested in isolation: input → expected decision.
 *
 * Companion to `conformance.test.ts` (kernel invariants + 25+ corpus
 * fixtures). This file targets readability of each guard's behaviour
 * for future Pack maintainers; the conformance file targets the
 * cross-outcome / kind matrix.
 *
 * # Coverage map (task spec §"Implementation requirements" item 7)
 *
 *   - Message inside 24h window → EXECUTE.
 *   - Message outside 24h window → REFUSE (`whatsapp.window.expired`).
 *   - Template outside 24h window → EXECUTE (bypasses window).
 *   - Customer→staff message with adversarial chars → REWRITE.
 *   - 2nd handover in 10 min → REQUEST_CONFIRMATION.
 *   - 3rd handover in 10 min → REFUSE (`whatsapp.handoff.rate_limited`).
 *   - Auth / taint / default-deny invariants.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  WHATSAPP_24H_WINDOW_MS,
  whatsappPack,
  whatsappPolicyBundle,
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
      // 1 hour ago — comfortably inside the 24h window.
      now: new Date("2026-05-22T12:00:00.000Z"),
      lastCustomerMessageAt: new Date("2026-05-22T11:00:00.000Z"),
      perCustomerHandoffCount: {},
      recipientType: "customer",
      ...overrides,
    },
  }
}

// ── 24-hour window enforcement ──────────────────────────────────────────

describe("whatsappPolicyBundle — 24h customer-initiated window", () => {
  it("EXECUTE whatsapp.message.send to customer inside the 24h window", () => {
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511999999999",
        body: "Olá! Seu pedido está pronto.",
        senderRole: "system",
      }),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE whatsapp.message.send outside the 24h window", () => {
    // 25 hours since last customer message — strictly outside the
    // 24h + grace window.
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511999999999",
        body: "Olá! Atualização tardia.",
        senderRole: "system",
      }),
      baseState({
        now: new Date("2026-05-22T12:00:00.000Z"),
        lastCustomerMessageAt: new Date("2026-05-21T10:00:00.000Z"),
      }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("whatsapp.window.expired")
  })

  it("REFUSE whatsapp.message.send with no prior customer message", () => {
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511999999999",
        body: "Cold outreach attempt.",
        senderRole: "system",
      }),
      baseState({ lastCustomerMessageAt: null }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("whatsapp.window.expired")
  })

  it("EXECUTE whatsapp.message.send with templateName/Variables outside the window", () => {
    // Templated outbound bypasses the window per Meta/Twilio policy.
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511999999999",
        body: "Olá {{1}}, seu pedido #{{2}}.",
        senderRole: "system",
        templateName: "order_ready_v1",
        templateVariables: { "1": "Maria", "2": "1234" },
      }),
      baseState({
        lastCustomerMessageAt: new Date("2026-05-20T10:00:00.000Z"),
      }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE whatsapp.template.send outside the window (SYSTEM-only kind)", () => {
    const decision = adjudicate(
      env(
        "whatsapp.template.send",
        {
          to: "+5511999999999",
          templateName: "order_ready_v1",
          templateVariables: { "1": "Maria", "2": "1234" },
        },
        "TRUSTED",
      ),
      baseState({
        lastCustomerMessageAt: new Date("2026-05-20T10:00:00.000Z"),
      }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Customer→staff REWRITE / sanitization ───────────────────────────────

describe("whatsappPolicyBundle — customer→staff sanitization (REWRITE)", () => {
  it("REWRITE customer→staff whatsapp.message.send with adversarial markdown body", () => {
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511888888888",
        body: "*urgent* _help_ ~now~",
        senderRole: "customer",
      }),
      baseState({ recipientType: "staff" }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REWRITE")
    if (decision.kind !== "REWRITE") return
    // Sanitized body strips markdown chars. Words separated by spaces
    // remain separated; word-adjacent markdown chars are deleted
    // without inserting a space (matches `sanitizeCustomerString`
    // semantics — newlines/line-separators are the ones that become
    // spaces, all other strip targets are deleted).
    const newPayload = decision.rewritten.payload as { body: string }
    expect(newPayload.body).toBe("urgent help now")
    // Reason is pt-BR.
    expect(decision.reason).toMatch(/equipe/i)
  })

  it("REWRITE customer→staff whatsapp.message.send truncates oversized body", () => {
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511888888888",
        body: "a".repeat(200),
        senderRole: "customer",
      }),
      baseState({ recipientType: "staff" }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REWRITE")
    if (decision.kind !== "REWRITE") return
    const newPayload = decision.rewritten.payload as { body: string }
    expect(newPayload.body.length).toBe(100)
  })

  it("EXECUTE customer→staff whatsapp.message.send when body has no adversarial chars", () => {
    // No REWRITE needed — body is already clean, the guard returns null
    // and the executor producer fires.
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511888888888",
        body: "preciso de ajuda",
        senderRole: "customer",
      }),
      baseState({ recipientType: "staff" }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE customer→customer whatsapp.message.send (REWRITE guard skips)", () => {
    // REWRITE guard fires only when recipientType=staff; customer→customer
    // is a legitimate path that doesn't need sanitization.
    const decision = adjudicate(
      env("whatsapp.message.send", {
        to: "+5511999999999",
        body: "*follow-up question*",
        senderRole: "customer",
      }),
      baseState({ recipientType: "customer" }),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Staff-handover rate limit ───────────────────────────────────────────

describe("whatsappPolicyBundle — staff-handover rate limit", () => {
  const HASH = "abc123def456"

  function handover(count: number) {
    return adjudicate(
      env(
        "whatsapp.session.handover",
        {
          sessionId: "sess-1",
          fromActor: "llm",
          toActor: "staff",
          customerPhoneHash: HASH,
        },
        "TRUSTED",
      ),
      baseState({
        perCustomerHandoffCount: { [HASH]: count },
      }),
      whatsappPolicyBundle,
    )
  }

  it("EXECUTE 1st handover in the rolling window", () => {
    const decision = handover(0) // counter starts at 0 before increment
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REQUEST_CONFIRMATION 2nd handover in the rolling window", () => {
    // 2nd handover — counter is 2 (post-increment for 1st) → threshold met.
    const decision = handover(2)
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toMatch(/atendimento humano/i)
  })

  it("REFUSE 3rd+ handover in the rolling window", () => {
    const decision = handover(3)
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("whatsapp.handoff.rate_limited")
  })

  it("REFUSE 10th handover (clearly abusive)", () => {
    const decision = handover(10)
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("whatsapp.handoff.rate_limited")
  })
})

// ── Taint policy ────────────────────────────────────────────────────────

describe("whatsappPolicyBundle — taint policy for system-only kinds", () => {
  it("system-only kinds require TRUSTED taint", () => {
    expect(
      whatsappPolicyBundle.taint.minimumFor("whatsapp.template.send"),
    ).toBe("TRUSTED")
    expect(
      whatsappPolicyBundle.taint.minimumFor("whatsapp.session.handover"),
    ).toBe("TRUSTED")
    expect(
      whatsappPolicyBundle.taint.minimumFor("whatsapp.message.send"),
    ).toBe("UNTRUSTED")
  })

  it("REFUSE UNTRUSTED whatsapp.template.send (taint gate)", () => {
    const decision = adjudicate(
      env(
        "whatsapp.template.send",
        {
          to: "+5511999999999",
          templateName: "order_ready_v1",
          templateVariables: { "1": "Maria" },
        },
        "UNTRUSTED",
      ),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("REFUSE UNTRUSTED whatsapp.session.handover (taint gate)", () => {
    const decision = adjudicate(
      env(
        "whatsapp.session.handover",
        {
          sessionId: "sess-1",
          fromActor: "llm",
          toActor: "staff",
          customerPhoneHash: "abc",
        },
        "UNTRUSTED",
      ),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Template validation ─────────────────────────────────────────────────

describe("whatsappPolicyBundle — template validation", () => {
  it("REFUSE whatsapp.template.send with missing templateName", () => {
    const decision = adjudicate(
      env(
        "whatsapp.template.send",
        {
          to: "+5511999999999",
          templateName: "",
          templateVariables: { "1": "Maria" },
        },
        "TRUSTED",
      ),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("whatsapp.template.invalid")
  })
})

// ── Default-deny invariant ──────────────────────────────────────────────

describe("whatsappPolicyBundle — default-deny invariant", () => {
  it("policy.default is REFUSE (fail-safe — master plan #4)", () => {
    expect(whatsappPolicyBundle.default).toBe("REFUSE")
  })

  it("whatsappPack.policy.default mirrors the bundle default", () => {
    expect(whatsappPack.policy.default).toBe("REFUSE")
  })
})

// ── PackV0 shape ────────────────────────────────────────────────────────

describe("whatsappPack — PackV0 shape", () => {
  it("declares v0 contract", () => {
    expect(whatsappPack.contract).toBe("v0")
  })

  it("id matches the org convention", () => {
    expect(whatsappPack.id).toBe("ibatexas/pack-whatsapp")
  })

  it("version is 1.0.0 (first stable release of pack-whatsapp)", () => {
    expect(whatsappPack.version).toBe("1.0.0")
  })

  it("declares non-empty unique intents", () => {
    expect(whatsappPack.intents.length).toBeGreaterThan(0)
    const unique = new Set(whatsappPack.intents)
    expect(unique.size).toBe(whatsappPack.intents.length)
  })

  it("declares no DEFER signals (this Pack does not currently DEFER)", () => {
    expect(whatsappPack.signals).toEqual([])
  })

  it("planner exposes zero MUTATING tools to the LLM", () => {
    const plan = whatsappPack.planner.plan(baseState(), {
      channel: "whatsapp",
      customerId: "c-1",
      staffId: null,
    })
    expect(plan.visibleReadTools).toEqual([])
    expect(plan.allowedIntents).toEqual([])
  })

  it("24h window constant is at least 24h", () => {
    // The window is 24h + grace; the lower bound (no grace) is 24h.
    expect(WHATSAPP_24H_WINDOW_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})

// ── Rehydrator ──────────────────────────────────────────────────────────

describe("rehydrateWhatsAppState", () => {
  it("returns a default state for malformed input", () => {
    const out = whatsappPack.rehydrateState?.(null)
    expect(out).toBeDefined()
    expect(out!.ctx.customerId).toBeNull()
  })

  it("promotes ISO-string Date fields back to Date", () => {
    const raw = {
      ctx: {
        channel: "whatsapp",
        customerId: "c-1",
        staffId: null,
        now: "2026-05-22T12:00:00.000Z",
        lastCustomerMessageAt: "2026-05-22T11:00:00.000Z",
        perCustomerHandoffCount: {},
        recipientType: "customer",
      },
    }
    const out = whatsappPack.rehydrateState?.(raw)
    expect(out?.ctx.now).toBeInstanceOf(Date)
    expect(out?.ctx.lastCustomerMessageAt).toBeInstanceOf(Date)
  })
})
