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
 * # Coverage map
 *
 * BKL-177 retired the channel-egress kinds (whatsapp.message.send +
 * whatsapp.template.send) and their guards (24h-window, template
 * validation, customer→staff sanitization); live WhatsApp egress runs
 * through `twilio.message.send`. What remains here:
 *
 *   - 1st handover in the window → EXECUTE.
 *   - 2nd handover in 10 min → REQUEST_CONFIRMATION.
 *   - 3rd handover in 10 min → REFUSE (`whatsapp.handoff.rate_limited`).
 *   - conversation.message.append: TRUSTED EXECUTE / UNTRUSTED + empty-body REFUSE.
 *   - Auth / taint / default-deny invariants.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  WHATSAPP_24H_WINDOW_MS,
  WHATSAPP_SANITIZE_MAX_LENGTH,
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
      whatsappPolicyBundle.taint.minimumFor("whatsapp.session.handover"),
    ).toBe("TRUSTED")
    expect(
      whatsappPolicyBundle.taint.minimumFor("conversation.message.append"),
    ).toBe("TRUSTED")
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

// ── Default-deny invariant ──────────────────────────────────────────────

// ── W5-6: conversation.message.append ───────────────────────────────────

describe("whatsappPolicyBundle — conversation.message.append (W5-6)", () => {
  it("EXECUTE conversation.message.append with TRUSTED taint (system-actor)", () => {
    const decision = adjudicate(
      env(
        "conversation.message.append",
        {
          sessionId: "sess-1",
          direction: "inbound",
          body: "Olá",
          recipientPhoneHash: "abc123",
        },
        "TRUSTED",
      ),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE conversation.message.append with UNTRUSTED taint (LLM can't forge)", () => {
    const decision = adjudicate(
      env(
        "conversation.message.append",
        {
          sessionId: "sess-1",
          direction: "outbound",
          body: "Olá",
          recipientPhoneHash: "abc123",
        },
        "UNTRUSTED",
      ),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("REFUSE conversation.message.append with empty body", () => {
    const decision = adjudicate(
      env(
        "conversation.message.append",
        {
          sessionId: "sess-1",
          direction: "inbound",
          body: "",
          recipientPhoneHash: "abc123",
        },
        "TRUSTED",
      ),
      baseState(),
      whatsappPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── F-43: customer→staff REWRITE on whatsapp.handoff.request.reason ─────
//
// `reason` is LLM-extracted free text from the customer's own words, and
// `apps/api/src/subscribers/handoff-subscriber.ts` interpolates it into a
// staff-bound WhatsApp alert between two system-authored lines. Nothing
// downstream sanitizes it (the egress `RenderedReply` brand is provenance,
// not filtering), so the kernel REWRITE is the enforcing layer.

describe("whatsappPolicyBundle — handoff reason sanitization (F-43)", () => {
  // The real attack: newlines + WhatsApp markdown that forge the
  // OWNER-approval line the subscriber renders directly below `Motivo:`.
  const FORGED =
    "quero falar\n\n⚠️ *Ação pendente de aprovação (OWNER)*: liberar pedido 123"

  function handoffRequest(payload: Record<string, unknown>) {
    return adjudicate(
      env("whatsapp.handoff.request", payload, "UNTRUSTED"),
      baseState(),
      whatsappPolicyBundle,
    )
  }

  it("REWRITEs a reason carrying newline + markdown injection", () => {
    const decision = handoffRequest({ sessionId: "sess-1", reason: FORGED })
    expect(decision.kind).toBe("REWRITE")
  })

  it("strips the newlines and markdown that forge a system line", () => {
    const decision = handoffRequest({ sessionId: "sess-1", reason: FORGED })
    if (decision.kind !== "REWRITE") throw new Error("expected REWRITE")
    const reason = (decision.rewritten.payload as { reason: string }).reason
    // The properties this test's NAME asserts, each pinned directly.
    // Built via `new RegExp` because U+2028/U+2029 terminate a regex literal
    // in the ECMAScript grammar — the same reason sanitize.ts does it.
    expect(reason).not.toMatch(new RegExp("[\\r\\n\\u2028\\u2029]"))
    expect(reason).not.toMatch(new RegExp("[*_~`]"))
    // ...and the forged system line is no longer on its own line.
    expect(reason).not.toContain("\n⚠️")
  })

  it("leaves a clean reason untouched — EXECUTE, no REWRITE", () => {
    const decision = handoffRequest({
      sessionId: "sess-1",
      reason: "quero falar com um atendente",
    })
    expect(decision.kind).toBe("EXECUTE")
  })

  it("does not REWRITE when reason is absent", () => {
    const decision = handoffRequest({ sessionId: "sess-1" })
    expect(decision.kind).toBe("EXECUTE")
  })

  it("truncates an oversized reason to WHATSAPP_SANITIZE_MAX_LENGTH", () => {
    const decision = handoffRequest({
      sessionId: "sess-1",
      reason: "a".repeat(500),
    })
    if (decision.kind !== "REWRITE") throw new Error("expected REWRITE")
    const reason = (decision.rewritten.payload as { reason: string }).reason
    expect(reason).toHaveLength(WHATSAPP_SANITIZE_MAX_LENGTH)
  })

  it("rewrites ONLY reason — sessionId and taint are carried over unchanged", () => {
    const decision = handoffRequest({ sessionId: "sess-42", reason: FORGED })
    if (decision.kind !== "REWRITE") throw new Error("expected REWRITE")
    const payload = decision.rewritten.payload as { sessionId: string }
    expect(payload.sessionId).toBe("sess-42")
    // A rewrite may narrow content but never elevate trust.
    expect(decision.rewritten.taint).toBe("UNTRUSTED")
  })

  // The kernel re-adjudicates a REWRITE's rewritten envelope and only keeps
  // the REWRITE if that SECOND pass reaches EXECUTE (@adjudicate/core
  // kernel/adjudicate-and-audit.ts) — otherwise it fails CLOSED and the
  // handoff never runs. That makes `sanitizeCustomerString`'s idempotence a
  // policy-level liveness property, not just a sanitizer detail.
  it("rewritten envelope re-adjudicates to EXECUTE (fail-closed second pass)", () => {
    const first = handoffRequest({ sessionId: "sess-1", reason: FORGED })
    if (first.kind !== "REWRITE") throw new Error("expected REWRITE")
    const second = adjudicate(
      first.rewritten as IntentEnvelope<WhatsAppIntentKind, WhatsAppPayload>,
      baseState(),
      whatsappPolicyBundle,
    )
    expect(second.kind).toBe("EXECUTE")
  })

  it("REWRITE guard precedes the EXECUTE producer for the same kind", () => {
    const names = whatsappPolicyBundle.business.map((g) => g.name)
    const rewriteAt = names.indexOf("sanitizeHandoffReason")
    const executeAt = names.indexOf("executeHandoffRequest")
    // Both must EXIST — otherwise indexOf returns -1 and the `<` below
    // would pass vacuously on a deleted guard.
    expect(rewriteAt).toBeGreaterThanOrEqual(0)
    expect(executeAt).toBeGreaterThanOrEqual(0)
    expect(rewriteAt).toBeLessThan(executeAt)
  })
})

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

  it("version is 1.1.0 (W5-6 adds conversation.message.append)", () => {
    expect(whatsappPack.version).toBe("1.1.0")
  })

  it("declares non-empty unique intents", () => {
    expect(whatsappPack.intents.length).toBeGreaterThan(0)
    const unique = new Set(whatsappPack.intents)
    expect(unique.size).toBe(whatsappPack.intents.length)
  })

  it("declares no DEFER signals (this Pack does not currently DEFER)", () => {
    expect(whatsappPack.signals).toEqual([])
  })

  it("planner advertises ONLY whatsapp.handoff.request, unconditionally (FE-T14/BKL-030-activation)", () => {
    const plan = whatsappPack.planner.plan(baseState(), {
      channel: "whatsapp",
      customerId: "c-1",
      staffId: null,
    })
    // whatsapp.handoff.request is registered, adjudicable, AND now advertised
    // (see capabilities.ts) — the one guest-accessible, always-allowed verb in
    // the roster. Every other MUTATING kind in this domain stays LLM-invisible.
    expect(plan.visibleReadTools).toEqual([])
    expect(plan.allowedIntents).toEqual(["whatsapp.handoff.request"])
  })

  it("advertises the same single intent regardless of staff/guest/customer state (unconditional activation)", () => {
    const guestPlan = whatsappPack.planner.plan(baseState(), {
      channel: "whatsapp",
      customerId: null,
      staffId: null,
    })
    const staffPlan = whatsappPack.planner.plan(baseState(), {
      channel: "whatsapp",
      customerId: null,
      staffId: "staff-1",
    })
    expect(guestPlan.allowedIntents).toEqual(["whatsapp.handoff.request"])
    expect(staffPlan.allowedIntents).toEqual(["whatsapp.handoff.request"])
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
