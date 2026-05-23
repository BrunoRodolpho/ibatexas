// Unit tests for audit-redactor.ts (Task 18 — PII redaction).
//
// Exercises the rule engine in isolation. The companion contract test
// (audit-redaction-contract.test.ts) is the CI gate over the full audit
// corpus; this file enforces the invariants spelled out in the module
// header.

import { describe, it, expect, vi } from "vitest"
import { buildAuditRecord, buildEnvelope } from "@adjudicate/core"
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
  it("redacts whatsapp.message.send body even when content has no PII regex hit", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("whatsapp.message.send", {
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

  it("redacts whatsapp.handoff.request.reason free-form text", () => {
    const r = createAuditRedactor({ hashSecret: "salt", warn: vi.fn() })
    const record = makeRecord("whatsapp.handoff.request", {
      reason: "Cliente João Silva pediu cancelamento urgente",
      lastMessage: "quero cancelar agora",
    })
    const out = r.redact(record)
    const payload = out.envelope.payload as Record<string, unknown>
    expect(payload.reason).toBe("[REDACTED]")
    expect(payload.lastMessage).toBe("[REDACTED]")
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
