/**
 * Task 11 — `@adjudicate/locales-pt-BR` + `localizeDecision` adoption.
 *
 * Verifies that the responder boundary localizes kernel-emitted REFUSE
 * decisions in pt-BR and leaves EXECUTE / DEFER / REWRITE decisions
 * untouched.
 *
 * Also exercises the `resolveLocalizedRefusalText` policy: kernel codes
 * use the canonical dictionary; Pack-emitted codes that aren't in the
 * canonical dictionary keep their inline pt-BR text rather than degrading
 * to the generic `fallback`.
 */

import { describe, expect, it } from "vitest"
import {
  buildEnvelope,
  decisionDefer,
  decisionExecute,
  decisionRefuse,
  decisionRewrite,
  localizeDecision,
  refuse,
  type Decision,
} from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"
import { resolveLocalizedRefusalText } from "../localizer.js"

describe("localizeDecision — kernel REFUSE", () => {
  it("localizes a kernel REFUSE decision via the canonical dictionary", () => {
    const decision: Decision = decisionRefuse(
      refuse("SECURITY", "default_deny", "stub English"),
      [],
    )
    const localized = localizeDecision(decision, portugueseRefusalMessages)
    expect(localized.kind).toBe("REFUSE")
    if (localized.kind !== "REFUSE") throw new Error("unreachable")
    expect(localized.refusal.userFacing).toBe(
      portugueseRefusalMessages.byCode["default_deny"],
    )
    // code + kind are preserved (only userFacing changes).
    expect(localized.refusal.code).toBe("default_deny")
    expect(localized.refusal.kind).toBe("SECURITY")
  })

  it("falls back for unknown codes", () => {
    const decision = decisionRefuse(
      refuse("BUSINESS_RULE", "nonexistent_xyz", "stub English"),
      [],
    )
    const localized = localizeDecision(decision, portugueseRefusalMessages)
    if (localized.kind !== "REFUSE") throw new Error("unreachable")
    expect(localized.refusal.userFacing).toBe(
      portugueseRefusalMessages.fallback,
    )
  })

  it("covers the kernel-emitted refusal codes", () => {
    const codes = Object.keys(portugueseRefusalMessages.byCode)
    expect(codes).toContain("kill_switch_active")
    expect(codes).toContain("taint_level_insufficient")
    expect(codes).toContain("default_deny")
    expect(codes).toContain("kernel_deadline_exceeded")
  })
})

describe("localizeDecision — non-REFUSE pass-through", () => {
  const envelope = buildEnvelope({
    kind: "test.tool.propose",
    payload: { foo: "bar" },
    actor: { principal: "user", sessionId: "test-session" },
    taint: "UNTRUSTED",
    nonce: "test-nonce-1",
    createdAt: "2024-01-01T00:00:00.000Z",
  })

  it("leaves EXECUTE unchanged", () => {
    const decision = decisionExecute([])
    const out = localizeDecision(decision, portugueseRefusalMessages)
    expect(out).toEqual(decision)
  })

  it("leaves DEFER unchanged", () => {
    const decision: Decision = decisionDefer(
      "payment.pix.confirmed",
      60_000,
      [],
    )
    const out = localizeDecision(decision, portugueseRefusalMessages)
    expect(out).toEqual(decision)
  })

  it("leaves REWRITE unchanged", () => {
    const decision = decisionRewrite(envelope, "sanitized", [])
    const out = localizeDecision(decision, portugueseRefusalMessages)
    expect(out).toEqual(decision)
  })
})

describe("resolveLocalizedRefusalText — Pack-emitted vs kernel codes", () => {
  it("uses the canonical dictionary for kernel-emitted codes", () => {
    const original: Decision = decisionRefuse(
      refuse("SECURITY", "kill_switch_active", "stub English"),
      [],
    )
    const localized = localizeDecision(original, portugueseRefusalMessages)
    const text = resolveLocalizedRefusalText(original, localized)
    expect(text).toBe(portugueseRefusalMessages.byCode["kill_switch_active"])
  })

  it("keeps the Pack-emitted pt-BR text when the code is missing from the canonical dictionary", () => {
    // `auth.required` is Pack-specific and not in portugueseRefusalMessages.byCode.
    // The naive `localizeDecision` output would degrade to the generic
    // fallback ("Essa ação não é permitida neste momento."), which is worse
    // than the Pack's hand-tuned string. The policy keeps the original.
    const packText =
      "Preciso confirmar seu cadastro antes de continuar — me diz seu número de WhatsApp."
    const original: Decision = decisionRefuse(
      refuse("AUTH", "auth.required", packText),
      [],
    )
    const localized = localizeDecision(original, portugueseRefusalMessages)
    expect(localized.kind).toBe("REFUSE")
    if (localized.kind !== "REFUSE") throw new Error("unreachable")
    // localizeDecision itself returns the fallback…
    expect(localized.refusal.userFacing).toBe(
      portugueseRefusalMessages.fallback,
    )
    // …but the policy restores the Pack's original text.
    expect(resolveLocalizedRefusalText(original, localized)).toBe(packText)
  })

  it("matches the canonical dictionary for kernel taint refusals", () => {
    const original: Decision = decisionRefuse(
      refuse("SECURITY", "taint_level_insufficient", "stub English"),
      [],
    )
    const localized = localizeDecision(original, portugueseRefusalMessages)
    expect(resolveLocalizedRefusalText(original, localized)).toBe(
      portugueseRefusalMessages.byCode["taint_level_insufficient"],
    )
  })
})
