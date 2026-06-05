// Audit-2026-05-24 P0-5 / P0-6 / P1-2 regression tests.
//
// Three findings from the 2026-05-24 audit live here:
//
//   F-5 (P0-5): the per-intent-kind rule for the WhatsApp handover used the
//     taxonomy-doc kind `"whatsapp.handoff.request"` — a kind that does NOT
//     exist in pack-whatsapp's `WhatsAppIntentKind` union. The real kind is
//     `"whatsapp.session.handover"`. The typo silently disabled redaction
//     for the entire WhatsApp handover surface, AND the rule field name was
//     `"variables"` while the real payload field is `templateVariables`.
//
//   F-6 (P0-6): 14 intent kinds across pack-payments, pack-orders,
//     pack-reservations, pack-whatsapp ship free-form text fields
//     (`reason`, `comment`, `body`, `note`, `specialRequests`) that the
//     global PII regex catches CPF/email/phone/card for — but NOT customer
//     names buried mid-sentence. Explicit per-kind rules now scrub these.
//
//   C-1 (P1-2): the redactor's main `redact()` did not walk
//     `audit-record.decision.rewritten.payload`. After a REWRITE decision,
//     the rewritten envelope's payload was published to NATS unredacted.
//     Adopters wire sanitizers like pack-whatsapp's `sanitizeCustomerString`
//     into the REWRITE path, but those sanitizers do NOT do PII detection.
//
// Each test below is a self-contained, byte-level assertion against the
// authoritative redactor. The contract test
// (`audit-redaction-contract.test.ts`) is the CI gate; this file documents
// the audit findings in code form so reviewers can map findings → tests.

import { describe, it, expect, vi } from "vitest"
import {
  buildAuditRecord,
  buildEnvelope,
  type AuditRecord,
  type IntentEnvelope,
} from "@adjudicate/core"
// claustrum-on-dev WS1: the audit redactor relocated to @ibatexas/audit-sink.
// KNOWN_INTENT_KINDS stays in llm-provider (brain — composes Pack intent
// surfaces), so this conformance test stays here and imports the redactor
// from its new home.
import { createAuditRedactor } from "@ibatexas/audit-sink"
import { KNOWN_INTENT_KINDS } from "../intent-kinds.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnvelope(kind: string, payload: unknown): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "user", sessionId: "sess_2026_05_24" },
    taint: "UNTRUSTED",
    nonce: `n_2026_05_24_${kind}`,
    createdAt: "2026-05-24T00:00:00.000Z",
  })
}

function makeRecord(kind: string, payload: unknown): AuditRecord {
  return buildAuditRecord({
    envelope: makeEnvelope(kind, payload),
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
    at: "2026-05-24T00:00:00.001Z",
  })
}

function jsonOf(rec: AuditRecord): string {
  return JSON.stringify(rec)
}

// ── F-5: WhatsApp session.handover + templateVariables ───────────────────────

describe("audit-2026-05-24 F-5 (P0-5) — whatsapp.session.handover + templateVariables", () => {
  it("redacts whatsapp.session.handover.reason free-form text", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("whatsapp.session.handover", {
      sessionId: "sess_42",
      fromActor: "customer",
      toActor: "staff",
      customerPhoneHash: "phash_abc",
      reason: "Cliente Maria Souza pediu cancelamento urgente",
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.reason).toBe("[REDACTED]")
  })

  it("redacts whatsapp.session.handover.lastMessage when adopters attach it", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("whatsapp.session.handover", {
      sessionId: "sess_42",
      fromActor: "customer",
      toActor: "staff",
      customerPhoneHash: "phash_abc",
      lastMessage: "meu cpf é 123.456.789-00",
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.lastMessage).toBe("[REDACTED]")
    expect(jsonOf(out)).not.toMatch(/123\.456\.789-00/)
  })

  it("redacts whatsapp.template.send.templateVariables (the real field name)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("whatsapp.template.send", {
      to: "+5511999998888",
      templateName: "reservation_reminder",
      templateVariables: {
        // The rendered template values carry customer-typed text. Pre-fix,
        // the rule keyed on `variables` so this entire object escaped.
        customerName: "João Silva",
        cpfHint: "123.456.789-00",
      },
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.templateVariables).toEqual({
      customerName: "[REDACTED]",
      cpfHint: "[REDACTED]",
    })
    // Template name remains so operators can see WHICH template fired.
    expect(payload.templateName).toBe("reservation_reminder")
  })

  it("redacts whatsapp.message.send.templateVariables when present", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("whatsapp.message.send", {
      to: "+5511999998888",
      body: "Olá Maria",
      senderRole: "system",
      templateName: "order_confirmation_v3",
      templateVariables: { name: "Maria Souza", orderId: "ord_42" },
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.templateVariables).toEqual({
      name: "[REDACTED]",
      orderId: "[REDACTED]",
    })
  })

  it("redacts the legacy `variables` field name as defense-in-depth", () => {
    // Some HTTP routes / older fixtures still pass `variables`. The rule
    // covers both the canonical pack-whatsapp `templateVariables` AND the
    // legacy alias so neither escapes.
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("whatsapp.template.send", {
      to: "+5511999998888",
      templateName: "tpl_x",
      variables: { name: "Alice", email: "alice@example.com" },
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.variables).toEqual({
      name: "[REDACTED]",
      email: "[REDACTED]",
    })
  })
})

// ── F-6: 14 free-form-field kinds ────────────────────────────────────────────

describe("audit-2026-05-24 F-6 (P0-6) — free-form fields per intent kind", () => {
  it("redacts payment.refund.issue.reason (admin free-form)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("payment.refund.issue", {
      paymentId: "pay_42",
      refundAmountCentavos: 5000,
      refundableBalanceCentavos: 5000,
      amountInCentavos: 5000,
      currentRefundedCentavos: 0,
      actor: "admin",
      adminId: "admin_1",
      reason: "Cliente João Silva reclamou da qualidade do pedido",
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.reason).toBe("[REDACTED]")
  })

  it("redacts payment.waive.reason", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("payment.waive", {
      paymentId: "pay_42",
      reason: "Cliente Maria Souza, problema de cobrança duplicada",
      adminId: "admin_1",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).reason).toBe(
      "[REDACTED]",
    )
  })

  it("redacts payment.status.force.reason", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("payment.status.force", {
      paymentId: "pay_42",
      newStatus: "paid",
      reason: "Cliente Ana Beatriz pagou em dinheiro",
      adminId: "admin_1",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).reason).toBe(
      "[REDACTED]",
    )
  })

  it("redacts order.cancel.reason", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("order.cancel", {
      orderId: "ord_42",
      reason: "Cliente Pedro Lima pediu remoção, contato: pedro@x.com",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).reason).toBe(
      "[REDACTED]",
    )
  })

  it("redacts order.note.add.body (free-form note attached to an order)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("order.note.add", {
      orderId: "ord_42",
      body: "Cliente Roberto pediu para ligar no 11 99999-9999",
      isInternal: true,
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).body).toBe(
      "[REDACTED]",
    )
  })

  it("redacts order.review.submit.comment (customer-typed review text)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("order.review.submit", {
      orderId: "ord_42",
      productId: "prod_42",
      rating: 5,
      comment: "Adorei! Sou Maria, telefone 11999998888 para retorno",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).comment).toBe(
      "[REDACTED]",
    )
  })

  it("redacts order.status.transition.reason", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("order.status.transition", {
      orderId: "ord_42",
      newStatus: "cancelled",
      actor: "admin",
      reason: "Cliente Carlos Almeida reclamou da entrega",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).reason).toBe(
      "[REDACTED]",
    )
  })

  it("redacts reservation.create.specialRequests array", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("reservation.create", {
      timeSlotId: "slot_42",
      partySize: 4,
      specialRequests: [
        "Aniversariante: Ana Beatriz Silva",
        "Mesa perto da janela, contato: ana@x.com",
      ],
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.specialRequests).toEqual(["[REDACTED]", "[REDACTED]"])
  })

  it("redacts reservation.modify.specialRequests array", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("reservation.modify", {
      reservationId: "res_42",
      specialRequests: ["Mudou: agora é o aniversário do João, 11999998888"],
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.specialRequests).toEqual(["[REDACTED]"])
  })

  it("redacts reservation.cancel.reason", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("reservation.cancel", {
      reservationId: "res_42",
      reason: "Cliente Bruno Henrique não vai mais comparecer",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).reason).toBe(
      "[REDACTED]",
    )
  })

  it("redacts conversation.message.append.body (the acute leak)", () => {
    // This is the most severe of the F-6 group: the conversation archiver
    // passes the literal inbound customer message body to the kernel as
    // an envelope payload. Without redaction the audit topic carries
    // verbatim customer language including any PII the customer typed.
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("conversation.message.append", {
      sessionId: "sess_42",
      direction: "inbound",
      recipientPhoneHash: "phash_abc",
      body: "Oi sou a Maria Souza, meu CPF é 123.456.789-00",
    })
    const out = r.redact(rec)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.body).toBe("[REDACTED]")
    // Belt-and-suspenders: even if the rule were inert, the CPF regex
    // would still scrub the digits. After the fix BOTH layers fire.
    expect(jsonOf(out)).not.toMatch(/123\.456\.789-00/)
    expect(jsonOf(out)).not.toMatch(/Maria Souza/)
  })

  it("redacts customer.anonymize.reason (when adopters attach one)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("customer.anonymize", {
      customerId: "cust_42",
      otpToken: "tok_42",
      scope: "lgpd_art_18",
      reason: "Cliente Ana solicitou remoção dos dados",
    })
    const out = r.redact(rec)
    expect((out.envelope.payload as Record<string, unknown>).reason).toBe(
      "[REDACTED]",
    )
  })
})

// ── C-1 (P1-2): walk decision.rewritten.payload ──────────────────────────────

describe("audit-2026-05-24 C-1 (P1-2) — decision.rewritten.payload is walked", () => {
  it("redacts PII inside the REWRITE's rewritten envelope.payload", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })

    // Original envelope: customer-typed inbound message with PII.
    const original = makeEnvelope("whatsapp.message.send", {
      to: "+5511999998888",
      body: "olá",
      senderRole: "customer",
    })

    // The kernel produces a REWRITE that swaps the body for a sanitized
    // version. Pack-whatsapp's `sanitizeCustomerString` strips newlines /
    // template-injection shapes but does NOT do PII detection (see the
    // pack-whatsapp/src/sanitize.ts header). So the rewritten body still
    // carries the customer's CPF/email/phone.
    const rewritten = makeEnvelope("whatsapp.message.send", {
      to: "+5511999998888",
      body: "meu cpf é 123.456.789-00 e email é maria@example.com",
      senderRole: "customer",
    })

    const recordPre: AuditRecord = buildAuditRecord({
      envelope: original,
      decision: {
        kind: "REWRITE",
        rewritten,
        reason: "customer-string-sanitized",
        basis: [],
      },
      durationMs: 1,
      at: "2026-05-24T00:00:00.001Z",
    })

    const out = r.redact(recordPre)

    // The envelope payload was redacted (original body was the canonical
    // free-form path).
    const envPayload = out.envelope.payload as Record<string, unknown>
    expect(envPayload.body).toBe("[REDACTED]")

    // The DECISION's rewritten payload must ALSO be redacted. Pre-fix this
    // assertion failed — the rewritten body kept the CPF and email.
    expect(out.decision.kind).toBe("REWRITE")
    if (out.decision.kind === "REWRITE") {
      const rPayload = out.decision.rewritten.payload as Record<string, unknown>
      expect(rPayload.body).toBe("[REDACTED]")
    }

    // Belt-and-suspenders: no PII surfaces in the JSON-serialised record.
    const json = jsonOf(out)
    expect(json).not.toMatch(/123\.456\.789-00/)
    expect(json).not.toMatch(/maria@example\.com/)
  })

  it("redacts PII inside a REWRITE for conversation.message.append (the acute path)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const original = makeEnvelope("conversation.message.append", {
      sessionId: "sess_42",
      direction: "inbound",
      recipientPhoneHash: "phash_abc",
      body: "Original",
    })
    const rewritten = makeEnvelope("conversation.message.append", {
      sessionId: "sess_42",
      direction: "inbound",
      recipientPhoneHash: "phash_abc",
      body: "sanitized body but CPF 123.456.789-00 still here",
    })
    const recordPre: AuditRecord = buildAuditRecord({
      envelope: original,
      decision: {
        kind: "REWRITE",
        rewritten,
        reason: "newline-stripped",
        basis: [],
      },
      durationMs: 1,
      at: "2026-05-24T00:00:00.001Z",
    })
    const out = r.redact(recordPre)
    if (out.decision.kind === "REWRITE") {
      const rPayload = out.decision.rewritten.payload as Record<string, unknown>
      expect(rPayload.body).toBe("[REDACTED]")
    } else {
      throw new Error("expected REWRITE")
    }
    expect(jsonOf(out)).not.toMatch(/123\.456\.789-00/)
  })

  it("non-REWRITE decisions are untouched (EXECUTE / REFUSE / DEFER pass-through)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const rec = makeRecord("customer.profile.update", { name: "Ana" })
    const out = r.redact(rec)
    // Decision shape preserved verbatim for non-REWRITE kinds.
    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.decision.basis).toEqual([])
  })

  it("REWRITE auditHash verifies cleanly post-redaction (P0-15 + P1-2 interplay)", async () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const { verifyAuditRecord } = await import("@adjudicate/core")
    const original = makeEnvelope("whatsapp.message.send", {
      to: "+5511999998888",
      body: "olá",
      senderRole: "customer",
    })
    const rewritten = makeEnvelope("whatsapp.message.send", {
      to: "+5511999998888",
      body: "cpf 123.456.789-00",
      senderRole: "customer",
    })
    const rec: AuditRecord = buildAuditRecord({
      envelope: original,
      decision: {
        kind: "REWRITE",
        rewritten,
        reason: "sanitization",
        basis: [],
      },
      durationMs: 1,
      at: "2026-05-24T00:00:00.001Z",
    })
    const out = r.redact(rec)
    const verification = verifyAuditRecord(out)
    expect(verification.verified).toBe(true)
  })

  it("REWRITE redaction is idempotent (second pass produces identical output)", () => {
    const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
    const original = makeEnvelope("whatsapp.message.send", {
      to: "+5511999998888",
      body: "olá",
      senderRole: "customer",
    })
    const rewritten = makeEnvelope("whatsapp.message.send", {
      to: "+5511999998888",
      body: "cpf 123.456.789-00 e email m@x.com",
      senderRole: "customer",
    })
    const rec: AuditRecord = buildAuditRecord({
      envelope: original,
      decision: {
        kind: "REWRITE",
        rewritten,
        reason: "sanitization",
        basis: [],
      },
      durationMs: 1,
      at: "2026-05-24T00:00:00.001Z",
    })
    const once = r.redact(rec)
    const twice = r.redact(once)
    expect(twice).toEqual(once)
  })

  it("REWRITE fail-open path stubs both envelope.payload AND decision.rewritten.payload", () => {
    const warn = vi.fn()
    const r = createAuditRedactor({ hashSecret: "s", warn })

    // buildAuditRecord canonicalises the envelope at build time, so the
    // cycle has to be attached AFTER the fixture is built — same pattern
    // as the existing cyclic-fail-open test in audit-redactor.test.ts.
    const original = makeEnvelope("customer.profile.update", {
      name: { first: "X" },
    })
    const rewritten = makeEnvelope("customer.profile.update", {
      name: { first: "X" },
    })
    const baseRecord: AuditRecord = buildAuditRecord({
      envelope: original,
      decision: {
        kind: "REWRITE",
        rewritten,
        reason: "test",
        basis: [],
      },
      durationMs: 1,
      at: "2026-05-24T00:00:00.001Z",
    })

    // Attach a cycle to the envelope's `name` HASH field. The redactor's
    // hash path JSON.stringify-s sub-objects under HASH_FIELDS, so a cycle
    // blows up the walker and trips the fail-open clause.
    const cyclicName: Record<string, unknown> = { first: "X" }
    cyclicName.self = cyclicName
    const cyclicRecord: AuditRecord = {
      ...baseRecord,
      envelope: {
        ...baseRecord.envelope,
        payload: { name: cyclicName },
      },
    }

    const out = r.redact(cyclicRecord)
    expect(out.envelope.payload).toEqual({ __redactor_error: true })
    // The fail-open path also stubs the decision-level rewritten payload
    // as a defense-in-depth measure — even though THIS test's rewritten
    // payload didn't itself blow up, the stub keeps the failed-record
    // shape consistent.
    if (out.decision.kind === "REWRITE") {
      expect(out.decision.rewritten.payload).toEqual({ __redactor_error: true })
    } else {
      throw new Error("expected REWRITE")
    }
    expect(warn).toHaveBeenCalled()
  })
})

// ── Contract sweep — every KNOWN_INTENT_KINDS kind that has a rule fires ─────

describe("audit-2026-05-24 — contract sweep over INTENT_KIND_FIELD_RULES", () => {
  // Map of intent kind → a representative free-form field with a test value
  // whose redaction proves the rule is reachable. Kinds NOT in this map are
  // not asserted; presence in the map IS the assertion that the rule fires.
  const PROBES: ReadonlyArray<{
    readonly kind: string
    readonly field: string
    readonly value: string
  }> = [
    { kind: "whatsapp.message.send", field: "body", value: "test body" },
    {
      kind: "whatsapp.template.send",
      field: "templateVariables",
      value: "rendered",
    },
    { kind: "whatsapp.session.handover", field: "reason", value: "test r" },
    { kind: "conversation.message.append", field: "body", value: "test" },
    { kind: "payment.refund.issue", field: "reason", value: "test" },
    { kind: "payment.waive", field: "reason", value: "test" },
    { kind: "payment.status.force", field: "reason", value: "test" },
    { kind: "payment.charge.fail", field: "reason", value: "test" },
    { kind: "payment.charge.cancel", field: "reason", value: "test" },
    { kind: "payment.status.transition", field: "reason", value: "test" },
    { kind: "order.cancel", field: "reason", value: "test" },
    { kind: "order.note.add", field: "body", value: "test" },
    { kind: "order.review.submit", field: "comment", value: "test" },
    { kind: "order.status.transition", field: "reason", value: "test" },
    { kind: "reservation.create", field: "specialRequests", value: "test" },
    { kind: "reservation.modify", field: "specialRequests", value: "test" },
    { kind: "reservation.cancel", field: "reason", value: "test" },
    { kind: "customer.anonymize", field: "reason", value: "test" },
    { kind: "customer.anonymize.cancel", field: "reason", value: "test" },
  ]

  for (const probe of PROBES) {
    const { kind, field, value } = probe
    it(`${kind}.${field} is scrubbed to [REDACTED]`, () => {
      const r = createAuditRedactor({ hashSecret: "s", warn: vi.fn() })
      const payload: Record<string, unknown> =
        field === "specialRequests" ? { [field]: [value] } : { [field]: value }
      // templateVariables / variables are objects, not strings.
      if (field === "templateVariables" || field === "variables") {
        payload[field] = { customerName: value }
      }
      const rec = makeRecord(kind, payload)
      const out = r.redact(rec)
      const outPayload = out.envelope.payload as Record<string, unknown>

      if (field === "specialRequests") {
        expect(outPayload[field]).toEqual(["[REDACTED]"])
      } else if (field === "templateVariables" || field === "variables") {
        expect(outPayload[field]).toEqual({ customerName: "[REDACTED]" })
      } else {
        expect(outPayload[field]).toBe("[REDACTED]")
      }
    })
  }

  // Cross-check the brief's claim that the 14 newly-covered kinds live
  // in KNOWN_INTENT_KINDS (so a regression that drops a kind from a Pack
  // surfaces here, not silently). The probe map above is the source of
  // truth for the "covered" set; this assertion ensures every covered kind
  // is also a known kind (no orphans).
  //
  // Validation kinds (`validation.text.rewrite`, `validation.text.refuse`)
  // are synthesised — they are NOT in KNOWN_INTENT_KINDS, which is why
  // they're not in PROBES.
  it("every probe kind is in KNOWN_INTENT_KINDS (no orphan rules)", () => {
    for (const { kind } of PROBES) {
      expect(
        KNOWN_INTENT_KINDS.has(kind),
        `kind ${kind} is in INTENT_KIND_FIELD_RULES probes but not in KNOWN_INTENT_KINDS`,
      ).toBe(true)
    }
  })
})
