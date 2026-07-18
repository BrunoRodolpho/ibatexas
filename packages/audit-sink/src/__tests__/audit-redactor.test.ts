// Unit tests for audit-redactor.ts (Task 18 — PII redaction).
//
// Exercises the rule engine in isolation. The companion contract test
// (audit-redaction-contract.test.ts) is the CI gate over the full audit
// corpus; this file enforces the invariants spelled out in the module
// header.

import { describe, it, expect, vi } from "vitest"
import {
  buildAuditRecord,
  buildEnvelope,
  sha256Canonical,
  verifyAuditRecord,
} from "@adjudicate/core"
import type { AuditRecord } from "@adjudicate/core"
import { createAuditRedactor } from "../audit-redactor.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal AuditRecord for tests. We only care about `envelope.payload`
 * and `envelope.kind`; the rest of the shape comes from a canned EXECUTE
 * decision. `intentHash` and `auditHash` are derived by `buildAuditRecord` —
 * the test then asserts they survive the redaction round-trip unchanged.
 */
function makeRecord(
  kind: string,
  payload: unknown,
  metadata?: Record<string, unknown>,
): AuditRecord {
  const envelope = buildEnvelope({
    kind,
    payload,
    actor: { principal: "llm", sessionId: "sess_test_01" },
    taint: "UNTRUSTED",
    nonce: `n_test_${kind}`,
    createdAt: "2025-01-01T00:00:00.000Z",
  })
  return buildAuditRecord({
    envelope,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
    at: "2025-01-01T00:00:00.001Z",
    ...(metadata === undefined ? {} : { metadata }),
  })
}

// ── Field-name REDACT rules ───────────────────────────────────────────────────

describe("audit-redactor — field-name REDACT", () => {
  it("redacts cpf field", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({ cpf: "12345678900" })
    expect(out).toEqual({ cpf: "[REDACTED]" })
  })

  it("redacts email field", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({ email: "user@example.com" })
    expect(out).toEqual({ email: "[REDACTED]" })
  })

  it("redacts phone, cellphone, whatsapp, telefone, celular field aliases", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      phone: "+5511999999999",
      cellphone: "11888888888",
      whatsapp: "11777777777",
      telefone: "+5511666666666",
      celular: "11555555555",
    })
    expect(out).toEqual({
      phone: "[REDACTED]",
      cellphone: "[REDACTED]",
      whatsapp: "[REDACTED]",
      telefone: "[REDACTED]",
      celular: "[REDACTED]",
    })
  })

  it("redacts card primitives (cardNumber, cvv, cvc, pan, securityCode)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      cardNumber: "4111111111111111",
      cvv: "123",
      cvc: "456",
      pan: "5500000000000004",
      securityCode: "999",
    })
    expect(out).toEqual({
      cardNumber: "[REDACTED]",
      cvv: "[REDACTED]",
      cvc: "[REDACTED]",
      pan: "[REDACTED]",
      securityCode: "[REDACTED]",
    })
  })

  it("redacts case-insensitively (CPF, Cpf, CpF)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    expect(r.redactPayload({ CPF: "12345678900" })).toEqual({
      CPF: "[REDACTED]",
    })
    expect(r.redactPayload({ Cpf: "12345678900" })).toEqual({
      Cpf: "[REDACTED]",
    })
    expect(r.redactPayload({ CpF: "12345678900" })).toEqual({
      CpF: "[REDACTED]",
    })
  })

  it("nested object inside a REDACT field collapses to sentinel leaves", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      email: { value: "user@example.com", verified: true },
    })
    // Sub-tree: string → sentinel, boolean preserved (no PII risk).
    expect(out).toEqual({
      email: { value: "[REDACTED]", verified: true },
    })
  })
})

// ── Field-name HASH rules ─────────────────────────────────────────────────────

describe("audit-redactor — field-name HASH", () => {
  it("hashes name field deterministically", () => {
    const r = createAuditRedactor({ hashSecret: "test-salt", warn: vi.fn() })
    const out1 = r.redactPayload({ name: "João Silva" }) as Record<
      string,
      unknown
    >
    const out2 = r.redactPayload({ name: "João Silva" }) as Record<
      string,
      unknown
    >
    expect(out1.name).toMatch(/^hashed:[a-f0-9]{8}$/)
    expect(out1.name).toBe(out2.name) // determinism
  })

  it("different salts produce different hashes for same value", () => {
    const r1 = createAuditRedactor({ hashSecret: "salt-A", warn: vi.fn() })
    const r2 = createAuditRedactor({ hashSecret: "salt-B", warn: vi.fn() })
    const a = (r1.redactPayload({ name: "Maria" }) as Record<string, unknown>)
      .name
    const b = (r2.redactPayload({ name: "Maria" }) as Record<string, unknown>)
      .name
    expect(a).not.toBe(b)
  })

  it("hashes customerName, fullName, addressLine1, customer_id aliases", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      customerName: "Ana",
      fullName: "Carlos",
      addressLine1: "Rua X 100",
      customer_id: "cust_abc_123",
    }) as Record<string, string>
    for (const k of ["customerName", "fullName", "addressLine1", "customer_id"]) {
      expect(out[k]).toMatch(/^hashed:[a-f0-9]{8}$/)
    }
  })

  it("hashes nested objects under a HASH field by JSON-stringifying", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      name: { first: "João", last: "Silva" },
    }) as Record<string, unknown>
    expect(out.name).toMatch(/^hashed:[a-f0-9]{8}$/)
  })
})

// ── Regex defense ─────────────────────────────────────────────────────────────

describe("audit-redactor — regex defense for unmatched field names", () => {
  it("redacts CPF embedded in a free-form notes field", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      notes: "meu cpf é 123.456.789-00 obrigado",
    }) as Record<string, string>
    expect(out.notes).not.toMatch(/123\.456\.789-00/)
    expect(out.notes).toContain("[REDACTED:CPF]")
  })

  it("redacts CPF in unseparated 11-digit form", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      notes: "registro 12345678900 pendente",
    }) as Record<string, string>
    // 11 digits with no separators is ambiguous (CPF vs mobile); we accept
    // either CPF or PHONE sentinel — both scrub the underlying digits.
    expect(out.notes).not.toMatch(/12345678900/)
    expect(out.notes).toMatch(/\[REDACTED:(CPF|PHONE)\]/)
  })

  // ── NEW-P1-CPF: CPF-followed-by-`-` regression ───────────────────────
  //
  // Audit hidden bug #7. The previous lookahead `(?![\d.-])` rejected a
  // trailing `-`, so a bare-digit CPF concatenated with a hyphenated
  // suffix (`12345678900-foo`) slipped past redaction. The new lookahead
  // is `(?!\d)` so non-digit boundary characters (including `-` and `.`)
  // are now valid CPF terminators.

  it("[P1-CPF] redacts bare-digit CPF followed by hyphen-tag (12345678900-foo)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      notes: "12345678900-foo",
    }) as Record<string, string>
    expect(out.notes).not.toMatch(/12345678900/)
    // Either CPF or PHONE sentinel — both scrub the digits.
    expect(out.notes).toMatch(/\[REDACTED:(CPF|PHONE)\]/)
  })

  it("[P1-CPF] redacts CPF prefixed by 'cpf:' followed by hyphen-bar", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      notes: "cpf:12345678900-bar",
    }) as Record<string, string>
    expect(out.notes).not.toMatch(/12345678900/)
    expect(out.notes).toMatch(/\[REDACTED:(CPF|PHONE)\]/)
  })

  it("[P1-CPF] redacts dotted-CPF followed by hyphen-tag (123.456.789-00-x)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      notes: "123.456.789-00-x",
    }) as Record<string, string>
    expect(out.notes).not.toMatch(/123\.456\.789-00/)
    expect(out.notes).toContain("[REDACTED:CPF]")
  })

  it("[P1-CPF] fuzz: each of the 4 audit-spec shapes is redacted", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const cases = [
      "12345678900-foo",
      "cpf:12345678900-bar",
      "id=12345678900-tag",
      "12345678900-",
    ]
    for (const input of cases) {
      const out = r.redactPayload({ notes: input }) as Record<string, string>
      expect(out.notes, `case=${input}`).not.toMatch(/12345678900/)
    }
  })

  it("[P1-CPF] does NOT match when CPF is followed by another digit (longer run)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    // 12 digits — not a CPF, it's a longer number. The regex must NOT
    // produce a partial-CPF redaction here. Either the redactor catches
    // it as a card-shape or it leaves the run alone — both are fine; the
    // assertion is "no PARTIAL match producing `[REDACTED:CPF]` inside
    // a longer number".
    const out = r.redactPayload({
      notes: "code 123456789001 reference",
    }) as Record<string, string>
    expect(out.notes).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}\[REDACTED:CPF\]/)
  })

  it("redacts email embedded in description", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      description: "Contact us at support@ibatexas.com.br for help",
    }) as Record<string, string>
    expect(out.description).not.toMatch(/support@ibatexas/)
    expect(out.description).toContain("[REDACTED:EMAIL]")
  })

  it("redacts +55 Brazilian phone in a comment field", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      comment: "Ligar para +55 11 99999-9999 depois das 18h",
    }) as Record<string, string>
    expect(out.comment).not.toMatch(/99999-9999/)
    expect(out.comment).toContain("[REDACTED:PHONE]")
  })

  it("redacts 16-digit card-like sequence", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      memo: "tentei 4111 1111 1111 1111 mas deu erro",
    }) as Record<string, string>
    expect(out.memo).not.toMatch(/4111[\s-]?1111[\s-]?1111[\s-]?1111/)
    expect(out.memo).toContain("[REDACTED:CARD]")
  })

  it("does NOT redact innocuous numeric values (order id, price)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      orderId: 12345,
      priceCentavos: 8900,
      shortId: "ord_42",
    }) as Record<string, unknown>
    expect(out.orderId).toBe(12345)
    expect(out.priceCentavos).toBe(8900)
    expect(out.shortId).toBe("ord_42")
  })
})

// ── Per-intent-kind rules ────────────────────────────────────────────────────

describe("audit-redactor — per-intent-kind field rules", () => {
  it("redacts twilio.message.send body even when content has no PII regex hit", () => {
    // BKL-177: whatsapp.message.send retired; twilio.message.send is the live
    // WhatsApp egress wrapper carrying the identical body/variable redaction.
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("twilio.message.send", {
      to: "+5511999999999",
      template: "order_confirmation_v2",
      body: "Olá Maria, seu pedido está pronto.",
      variables: { name: "Maria", orderNumber: "ord_42" },
    })
    const out = r.redact(record)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.body).toBe("[REDACTED]")
    // Template name is preserved — operator needs to see WHICH template fired.
    expect(payload.template).toBe("order_confirmation_v2")
    // Variables are scrubbed by the kind-rule path match (subtree REDACT).
    expect(payload.variables).toEqual({
      name: "[REDACTED]",
      orderNumber: "[REDACTED]",
    })
  })

  // Audit-2026-05-24 F-5: the historical kind here was the typo'd
  // `whatsapp.handoff.request` — a taxonomy-doc kind that never appeared
  // in pack-whatsapp's `WhatsAppIntentKind` union. The real kind is
  // `whatsapp.session.handover` (pack-whatsapp/src/types.ts). The
  // assertion now exercises the corrected rule.
  it("[F-5] redacts whatsapp.session.handover free-form reason text", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("whatsapp.session.handover", {
      reason: "Cliente João Silva pediu cancelamento urgente",
      lastMessage: "quero cancelar agora",
    })
    const out = r.redact(record)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.reason).toBe("[REDACTED]")
    expect(payload.lastMessage).toBe("[REDACTED]")
  })

  // AUT-038 — staff pay data. hourlyRateCentavos is a NUMBER (the deep walk
  // passes numbers by identity), so ONLY the kind-scoped rule protects it;
  // phone/name ride the global field rules. staff.* is deliberately off
  // KNOWN_INTENT_KINDS, so the per-intent conformance corpus never checks
  // these kinds — this pin is the guard.
  it("redacts staff.create / staff.update hourlyRateCentavos (pay data); phone REDACTED, name hashed, role preserved", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redact(
      makeRecord("staff.create", {
        phone: "+5511999990001",
        name: "Ana Souza",
        role: "MANAGER",
        hourlyRateCentavos: 2500,
      }),
    )
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.hourlyRateCentavos).toBe("[REDACTED]")
    expect(payload.phone).toBe("[REDACTED]")
    expect(payload.name).not.toBe("Ana Souza") // hashed by global HASH_FIELDS
    expect(payload.role).toBe("MANAGER") // closed enum — operator needs it

    const upd = r.redact(
      makeRecord("staff.update", { staffId: "staff_1", hourlyRateCentavos: 9900 }),
    )
    const updPayload = upd.envelope.payload as Record<string, unknown>
    expect(updPayload.hourlyRateCentavos).toBe("[REDACTED]")
    expect(updPayload.staffId).toBe("staff_1") // opaque id preserved
  })
})

// ── Deep walk ────────────────────────────────────────────────────────────────

describe("audit-redactor — deep recursive walk", () => {
  it("walks nested objects and arrays", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      customer: {
        name: "João",
        addresses: [
          { addressLine1: "Rua X 100", cep: "01000-000" },
          { addressLine1: "Rua Y 200", cep: "02000-000" },
        ],
        contact: { email: "x@y.com", phone: "+5511999999999" },
      },
    }) as { customer: Record<string, unknown> }
    expect(out.customer.name).toMatch(/^hashed:[a-f0-9]{8}$/)
    const addresses = out.customer.addresses as Array<Record<string, string>>
    expect(addresses[0]!.addressLine1).toMatch(/^hashed:[a-f0-9]{8}$/)
    expect(addresses[1]!.addressLine1).toMatch(/^hashed:[a-f0-9]{8}$/)
    const contact = out.customer.contact as Record<string, string>
    expect(contact.email).toBe("[REDACTED]")
    expect(contact.phone).toBe("[REDACTED]")
  })

  it("preserves array structure (length, ordering)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const out = r.redactPayload({
      items: [
        { sku: "A", qty: 1 },
        { sku: "B", qty: 2 },
        { sku: "C", qty: 3 },
      ],
    }) as { items: Array<Record<string, unknown>> }
    expect(out.items).toHaveLength(3)
    expect(out.items[0]!.sku).toBe("A")
    expect(out.items[1]!.qty).toBe(2)
  })
})

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("audit-redactor — idempotency", () => {
  it("redact(redact(payload)) equals redact(payload) for cpf+email+name", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const payload = {
      cpf: "12345678900",
      email: "x@y.com",
      name: "Maria",
      notes: "cpf 123.456.789-00 nas notas",
    }
    const once = r.redactPayload(payload)
    const twice = r.redactPayload(once)
    expect(twice).toEqual(once)
  })

  it("redact(redact(record)) preserves intentHash; auditHash is stable post-redaction (P0-15)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("customer.pix.details.save", {
      name: "João Silva",
      email: "joao@example.com",
      cpf: "12345678900",
    })
    const once = r.redact(record)
    const twice = r.redact(once)
    // intentHash NEVER recomputed — replay invariant.
    expect(once.intentHash).toBe(record.intentHash)
    expect(twice.intentHash).toBe(record.intentHash)
    // P0-15: auditHash is recomputed over the redacted record so
    // verifyAuditRecord works post-redaction. Second pass over an already-
    // redacted record produces the same payload (idempotency) AND the same
    // hash (stable). The hash differs from the original (because payload
    // changed) but is consistent between once and twice.
    expect(once.auditHash).not.toBe(record.auditHash)
    expect(twice.auditHash).toBe(once.auditHash)
    expect(twice).toEqual(once)
  })
})

// ── Audit-record shape preservation ──────────────────────────────────────────

describe("audit-redactor — audit-record shape preservation", () => {
  it("preserves decision, decision_basis, at, durationMs, version", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("customer.profile.update", {
      name: "x",
      email: "y@z.com",
    })
    const out = r.redact(record)
    expect(out.decision).toEqual(record.decision)
    expect(out.decision_basis).toEqual(record.decision_basis)
    expect(out.at).toBe(record.at)
    expect(out.durationMs).toBe(record.durationMs)
    expect(out.version).toBe(record.version)
  })

  it("preserves envelope actor.principal, taint, kind, nonce, createdAt, version, intentHash (P0-10 hashes sessionId)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("customer.profile.update", {
      name: "x",
      email: "y@z.com",
    })
    const out = r.redact(record)
    // P0-10: actor.principal is preserved verbatim, actor.sessionId is
    // hashed to prevent HTTP-route customerId leakage.
    expect(out.envelope.actor.principal).toBe(record.envelope.actor.principal)
    expect(out.envelope.actor.sessionId).toMatch(/^hashed:[a-f0-9]{8}$/)
    expect(out.envelope.taint).toBe(record.envelope.taint)
    expect(out.envelope.kind).toBe(record.envelope.kind)
    expect(out.envelope.nonce).toBe(record.envelope.nonce)
    expect(out.envelope.createdAt).toBe(record.envelope.createdAt)
    expect(out.envelope.version).toBe(record.envelope.version)
    expect(out.envelope.intentHash).toBe(record.envelope.intentHash)
  })

  // D-017 / T3-6: managed-agent sessionIds stay UNHASHED so the agent-namespace
  // exclusion filters (kernel-replay --ci, impact graph, drift baseline) work on
  // the stored row. A FORGED agent-ish sessionId that doesn't match the strict
  // `agent:<kebab>@<x.y.z>:entity:<id>` shape is still hashed (no PII bypass).
  it("preserves a properly-minted agent: sessionId unhashed but hashes a forged one", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })

    function agentRecord(sessionId: string): AuditRecord {
      const envelope = buildEnvelope({
        kind: "payment.pix.regenerate",
        payload: { orderId: "ord_456" },
        actor: { principal: "system", sessionId },
        taint: "SYSTEM",
        nonce: "n_agent_redact",
        createdAt: "2026-06-12T00:00:00.000Z",
      })
      return buildAuditRecord({
        envelope,
        decision: { kind: "EXECUTE", basis: [] },
        durationMs: 1,
        at: "2026-06-12T00:00:00.001Z",
      })
    }

    const minted = "agent:pix-payment-failure-remediation@0.1.0:entity:ord_456"
    const ok = r.redact(agentRecord(minted))
    expect(ok.envelope.actor.sessionId).toBe(minted) // UNHASHED — operational id

    // Forged shapes that must NOT bypass the hash:
    for (const forged of [
      "agent:not a real namespace with pii user@example.com",
      "agent:badid:entity:x", // no @version
      "agent:UPPER@1.0.0:entity:x", // not kebab
    ]) {
      const out = r.redact(agentRecord(forged))
      expect(out.envelope.actor.sessionId).toMatch(/^hashed:[a-f0-9]{8}$/)
    }
  })

  it("does not mutate the input record (returns a fresh object)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const payload = { cpf: "12345678900", email: "x@y.com" }
    const record = makeRecord("customer.pix.details.save", payload)
    const out = r.redact(record)
    expect(record.envelope.payload).toEqual({
      cpf: "12345678900",
      email: "x@y.com",
    })
    expect(out.envelope.payload).not.toBe(record.envelope.payload)
  })
})

// ── Configuration boot warning ───────────────────────────────────────────────

describe("audit-redactor — configuration", () => {
  it("emits warn when hashSecret is empty", () => {
    const warn = vi.fn()
    createAuditRedactor({ hashSecret: "", warn })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain("AUDIT_REDACT_SECRET")
  })

  it("does not warn when hashSecret is set", () => {
    const warn = vi.fn()
    createAuditRedactor({ hashSecret: "32-char-secret-xxxxxxxxxxxxxxxxx", warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it("accepts extraRedactFields", () => {
    const r = createAuditRedactor({
      hashSecret: "s",
      warn: vi.fn(),
      extraRedactFields: new Set(["customField"]),
    })
    const out = r.redactPayload({ customField: "sensitive-value-x" })
    expect(out).toEqual({ customField: "[REDACTED]" })
  })

  it("accepts extraHashFields", () => {
    const r = createAuditRedactor({
      hashSecret: "s",
      warn: vi.fn(),
      extraHashFields: new Set(["nickname"]),
    })
    const out = r.redactPayload({ nickname: "joao_42" }) as Record<
      string,
      string
    >
    expect(out.nickname).toMatch(/^hashed:[a-f0-9]{8}$/)
  })

  it("accepts custom fieldRulesForKind", () => {
    const r = createAuditRedactor({
      hashSecret: "s",
      warn: vi.fn(),
      fieldRulesForKind: (k) =>
        k === "custom.kind" ? ["secretField"] : [],
    })
    const record = makeRecord("custom.kind", {
      secretField: "abc",
      visibleField: "ok",
    })
    const out = r.redact(record)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.secretField).toBe("[REDACTED]")
    expect(payload.visibleField).toBe("ok")
  })
})

// ── Fail-open behaviour ──────────────────────────────────────────────────────

describe("audit-redactor — fail-open on cyclic input", () => {
  it("returns __redactor_error stub on cyclic payload (no throw)", () => {
    const warn = vi.fn()
    const r = createAuditRedactor({ hashSecret: "s", warn })
    // Build a record with a non-cyclic payload first so buildAuditRecord can
    // canonicalise it, then attach a cyclic substructure post-hoc to a HASH
    // field (`name`). The redactor's hash path calls JSON.stringify(...) on
    // sub-objects, which explodes on cycles — exactly the failure mode the
    // fail-open clause exists to defend against.
    const baseRecord = makeRecord("customer.profile.update", {
      name: { first: "X" },
    })
    const cyclicName: Record<string, unknown> = { first: "X" }
    cyclicName.self = cyclicName
    const cyclicRecord: AuditRecord = {
      ...baseRecord,
      envelope: {
        ...baseRecord.envelope,
        payload: { name: cyclicName },
      },
    }
    // Must not throw.
    const out = r.redact(cyclicRecord)
    expect(out.envelope.payload).toEqual({ __redactor_error: true })
    expect(warn).toHaveBeenCalled()
  })
})

// ── FE-T05 review (MAJOR-1a) — record.metadata redaction ────────────────────
//
// `record.metadata` (the ADR-124 v5 governance/observability sidecar — e.g.
// the Language Engine's materialized ExtractionIR/HydratedIntentIR,
// apps/api/src/claustrum/language-engine/audit-metadata.ts) previously rode
// through `redact()` UNTOUCHED (a plain `...record` spread) — a synthetic-
// or model-smuggled PII value landing in metadata would have reached NATS/
// Postgres/console in cleartext. This suite pins the fix: metadata is walked
// through the SAME global REDACT/HASH/regex defenses as the payload, the
// fail-open path stubs it too, and — the load-bearing safety property —
// redacting metadata can NEVER invalidate tamper-evidence, because metadata
// is EXCLUDED from the `auditHash` pre-image (v5+, ADR-124).

describe("audit-redactor — record.metadata (FE-T05 review MAJOR-1a)", () => {
  it("redacts PII nested anywhere inside metadata (field-name REDACT + regex defense)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord(
      "order.status.transition",
      { orderId: "order_1", newStatus: "ready" },
      {
        languageEngine: {
          hydratedIntentIR: {
            payload: {
              orderId: "order_1",
              newStatus: "ready",
              // Synthetic: a field name the global REDACT set catches.
              cpf: "12345678900",
              // Synthetic: no matching field name, but the regex defense
              // still catches the EMAIL SHAPE inside a free-form string.
              notes: "contate joao@example.com para confirmar",
            },
          },
        },
      },
    )
    const out = r.redact(record)
    const hydrated = (
      out.metadata as {
        languageEngine: { hydratedIntentIR: { payload: Record<string, unknown> } }
      }
    ).languageEngine.hydratedIntentIR.payload

    expect(hydrated.orderId).toBe("order_1")
    expect(hydrated.newStatus).toBe("ready")
    expect(hydrated.cpf).not.toBe("12345678900")
    expect(String(hydrated.notes)).not.toContain("joao@example.com")
  })

  it("redacting metadata NEVER invalidates OUTER tamper-evidence (auditHash still round-trips; the only PERMITTED verifyAuditRecord miss is the pre-existing, documented envelope_intent_mismatch from the actor.sessionId hash — never `tampered`)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord(
      "order.status.transition",
      { orderId: "order_1", newStatus: "ready" },
      { languageEngine: { hydratedIntentIR: { payload: { cpf: "12345678900" } } } },
    )
    const out = r.redact(record)
    // The OUTER auditHash pre-image (record minus auditHash/signature/
    // metadata — mirrors recomputeAuditHash exactly) must round-trip. This
    // is the property that would break if metadata redaction leaked into
    // the pre-image.
    const { auditHash, signature: _sig, metadata: _meta, ...rest } = out as AuditRecord & {
      signature?: unknown
    }
    void _sig
    void _meta
    expect(sha256Canonical(rest)).toBe(auditHash)
    // Same documented pattern as audit-redaction-contract.test.ts's P0-15
    // suite: a plain (non-agent) actor.sessionId is legitimately hashed by
    // redaction, which `verifyAuditRecord`'s envelope.intentHash leg
    // correctly flags — that is the ONLY permitted non-`true` outcome.
    const verification = verifyAuditRecord(out)
    if (verification.verified !== true) {
      expect(verification.reason).toBe("envelope_intent_mismatch")
    }
  })

  it("PROVES metadata is excluded from the auditHash pre-image: two otherwise-identical records with DIFFERENT metadata redact to the SAME auditHash", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const payload = { orderId: "order_1", newStatus: "ready" }
    const recordA = makeRecord("order.status.transition", payload, {
      languageEngine: { hydratedIntentIR: { payload: { note: "A" } } },
    })
    const recordB: AuditRecord = {
      ...recordA,
      metadata: { languageEngine: { hydratedIntentIR: { payload: { note: "B — completely different" } } } },
    }
    const outA = r.redact(recordA)
    const outB = r.redact(recordB)
    expect(outA.metadata).not.toEqual(outB.metadata)
    expect(outA.auditHash).toBe(outB.auditHash)
  })

  it("idempotent — redact(redact(record)) with metadata equals redact(record)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord(
      "order.status.transition",
      { orderId: "order_1", newStatus: "ready" },
      { languageEngine: { hydratedIntentIR: { payload: { cpf: "12345678900" } } } },
    )
    const once = r.redact(record)
    const twice = r.redact(once)
    expect(twice).toEqual(once)
  })

  it("a record with NO metadata redacts byte-identically to before (metadata key stays absent)", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("order.status.transition", {
      orderId: "order_1",
      newStatus: "ready",
    })
    const out = r.redact(record)
    expect(out.metadata).toBeUndefined()
    expect(Object.hasOwn(out, "metadata")).toBe(false)
  })

  it("fail-open path stubs metadata too (never leaks it on a redactor crash)", () => {
    const warn = vi.fn()
    const r = createAuditRedactor({ hashSecret: "s", warn })
    const baseRecord = makeRecord(
      "customer.profile.update",
      { name: { first: "X" } },
      { languageEngine: { hydratedIntentIR: { payload: { cpf: "12345678900" } } } },
    )
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
    expect(out.metadata).toEqual({ __redactor_error: true })
  })
})
