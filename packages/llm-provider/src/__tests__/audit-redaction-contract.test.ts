// CI gate: this test MUST pass before any merge.
//
// Contract test for Task 18 audit redactor. Builds a corpus of 50+
// representative AuditRecord fixtures spanning every PII-bearing intent kind
// the IbateXas surface emits, runs each through the redactor, and asserts:
//
//   1. No CPF regex match survives in the JSON-stringified record.
//   2. No email pattern survives.
//   3. No Brazilian-phone pattern survives.
//   4. No 13-19 digit card-like pattern survives.
//   5. `intentHash` and `auditHash` are preserved verbatim (replay invariant).
//   6. Envelope `actor`, `taint`, `kind`, `nonce`, `createdAt`, `version` are
//      preserved (governance invariant).
//
// Plus a bypass-detection assertion: every audit-emit call site in the
// llm-provider tree routes through `getAuditSink()`, never directly to
// multiSink or a sink primitive.
//
// See investigation 08 §"P0 #1" for the threat model. See
// docs/adjudicate-migration/tasks/18-audit-redactor.md for the spec.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect, vi } from "vitest"
import { buildAuditRecord, buildEnvelope } from "@adjudicate/core"
import type { AuditRecord, IntentEnvelope } from "@adjudicate/core"
import { createAuditRedactor } from "../audit-redactor.js"

// ── Detection patterns ───────────────────────────────────────────────────────
//
// These are the patterns the redactor MUST defeat. They are intentionally
// tighter than the regex defenses inside the redactor — the redactor uses
// looser patterns to over-redact; the contract test uses strict patterns to
// catch real PII shapes only. False positives in the contract test would
// flag the redactor as broken when it is in fact correct.

const CPF_DETECT = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g
const EMAIL_DETECT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_DETECT_55 = /(?:\+?55)?\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/g
const CARD_DETECT = /(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g

// ── Fixture builder ──────────────────────────────────────────────────────────

interface Fixture {
  readonly label: string
  readonly kind: string
  readonly payload: unknown
}

function makeRecord(fx: Fixture, i: number): AuditRecord {
  const envelope: IntentEnvelope = buildEnvelope({
    kind: fx.kind,
    payload: fx.payload,
    actor: { principal: "llm", sessionId: `sess_corpus_${i}` },
    taint: "UNTRUSTED",
    nonce: `n_corpus_${i}`,
    createdAt: "2025-01-01T00:00:00.000Z",
  })
  return buildAuditRecord({
    envelope,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
    at: "2025-01-01T00:00:00.001Z",
  })
}

// ── The corpus — 50+ fixtures across every PII-bearing intent kind ───────────
//
// Coverage map (per task spec):
//   - customer.pix.details.save     (name, email, CPF)
//   - customer.profile.update       (name, email)
//   - customer.create               (phone)
//   - customer.anonymize            (customerId)
//   - whatsapp.handoff.request      (reason text)
//   - whatsapp.message.send         (body, variables — template preserved)
//   - whatsapp.template.send        (variables)
//   - validation.text.rewrite       (originalText)
//   - validation.text.refuse        (originalText)
//   - order.checkout.create         (customer object with email/cpf)
//   - order.cancel                  (customerId)
//   - reservation.create            (customerName, phone, customer notes)
//   - pix.charge.create             (customer block)
//   - customer.address.add          (address lines)
//   - customer.preferences.update   (free-form preferences)
//
// Plus stress fixtures for nested arrays, deeply nested objects, and
// adversarial payloads (PII embedded in description fields, mixed locales,
// formatted vs. unformatted CPF, etc).

const CORPUS: Fixture[] = [
  // ── customer.pix.details.save (the canonical leak case) ────────────────
  {
    label: "pix-details-save: full PII",
    kind: "customer.pix.details.save",
    payload: {
      name: "João da Silva",
      email: "joao@example.com",
      cpf: "123.456.789-00",
    },
  },
  {
    label: "pix-details-save: unseparated CPF",
    kind: "customer.pix.details.save",
    payload: {
      name: "Maria Souza",
      email: "maria.souza@gmail.com",
      cpf: "12345678900",
    },
  },
  {
    label: "pix-details-save: partial (name only)",
    kind: "customer.pix.details.save",
    payload: { name: "Ana Beatriz" },
  },
  {
    label: "pix-details-save: with extra metadata block",
    kind: "customer.pix.details.save",
    payload: {
      name: "Carlos Almeida",
      email: "carlos@empresa.com.br",
      cpf: "987.654.321-00",
      metadata: { source: "whatsapp", retryCount: 0 },
    },
  },

  // ── customer.profile.update ────────────────────────────────────────────
  {
    label: "profile-update: name + email",
    kind: "customer.profile.update",
    payload: { name: "Pedro Lima", email: "pedro@test.com" },
  },
  {
    label: "profile-update: name only",
    kind: "customer.profile.update",
    payload: { name: "Lucia Mendes" },
  },
  {
    label: "profile-update: email only",
    kind: "customer.profile.update",
    payload: { email: "lucia@example.org" },
  },

  // ── customer.create (phone-bearing) ────────────────────────────────────
  {
    label: "customer.create: phone +55 13-digit",
    kind: "customer.create",
    payload: { phone: "+5511999998888" },
  },
  {
    label: "customer.create: phone (11) 9xxxx-xxxx",
    kind: "customer.create",
    payload: { phone: "(11) 99999-8888" },
  },
  {
    label: "customer.create: phone unformatted 11-digit",
    kind: "customer.create",
    payload: { phone: "11999998888" },
  },
  {
    label: "customer.create: phone + name",
    kind: "customer.create",
    payload: { phone: "+5511999998888", name: "Fernanda Costa" },
  },

  // ── customer.anonymize ─────────────────────────────────────────────────
  {
    label: "anonymize: customerId",
    kind: "customer.anonymize",
    payload: { customerId: "cust_abc123_def456" },
  },
  {
    label: "anonymize: customerId + reason",
    kind: "customer.anonymize",
    payload: {
      customerId: "cust_xyz789",
      reason: "Cliente João pediu remoção de dados (LGPD)",
    },
  },

  // ── whatsapp.handoff.request ───────────────────────────────────────────
  {
    label: "whatsapp.handoff.request: reason with name",
    kind: "whatsapp.handoff.request",
    payload: {
      reason: "Cliente Pedro Henrique solicitou cancelamento de pedido",
      sessionId: "sess_42",
    },
  },
  {
    label: "whatsapp.handoff.request: reason quoting customer CPF",
    kind: "whatsapp.handoff.request",
    payload: {
      reason: "Cliente forneceu CPF 123.456.789-00 mas sistema rejeitou",
      lastMessage: "meu cpf é 123.456.789-00",
    },
  },

  // ── whatsapp.message.send (template name preserved, body redacted) ─────
  {
    label: "whatsapp.message.send: order confirmation",
    kind: "whatsapp.message.send",
    payload: {
      to: "+5511999998888",
      template: "order_confirmation_v3",
      body: "Olá Maria, seu pedido #1234 está pronto. Total: R$89,00.",
      variables: { name: "Maria", orderId: "1234", total: "R$89,00" },
    },
  },
  {
    label: "whatsapp.message.send: PIX QR payload",
    kind: "whatsapp.message.send",
    payload: {
      to: "+5511777776666",
      template: "pix_qr",
      body: "Olá João, segue o PIX: 00020126...",
      variables: { name: "João", cpf: "123.456.789-00" },
    },
  },

  // ── whatsapp.template.send ─────────────────────────────────────────────
  {
    label: "whatsapp.template.send: reservation reminder",
    kind: "whatsapp.template.send",
    payload: {
      to: "+5511888887777",
      templateName: "reservation_reminder",
      variables: { name: "Carla", time: "20:00", partySize: "4" },
    },
  },

  // ── validation.text.rewrite (LLM hallucinated PII in user-facing text) ──
  {
    label: "validation.text.rewrite: LLM emitted CPF in response",
    kind: "validation.text.rewrite",
    payload: {
      stateValue: "collecting_pix",
      originalText: "Confirmo seu CPF 123.456.789-00 no sistema.",
      rewritten: "Confirmo seus dados no sistema.",
      originalLength: 47,
    },
  },
  {
    label: "validation.text.refuse: LLM tried to leak email",
    kind: "validation.text.refuse",
    payload: {
      stateValue: "browsing",
      originalText: "Seu email cadastrado é user@example.com — confirma?",
      originalLength: 56,
    },
  },

  // ── order.checkout.create (nested customer block) ───────────────────────
  {
    label: "order.checkout.create: customer with cpf",
    kind: "order.checkout.create",
    payload: {
      cartId: "cart_01",
      customer: {
        name: "Roberto Lima",
        email: "roberto@example.com",
        cpf: "111.222.333-44",
        phone: "+5511555554444",
      },
      paymentMethod: "pix",
    },
  },
  {
    label: "order.checkout.create: card path with cardNumber",
    kind: "order.checkout.create",
    payload: {
      cartId: "cart_02",
      customer: { name: "Sofia Andrade", email: "sofia@example.com" },
      paymentMethod: "card",
      cardNumber: "4111111111111111",
      cvv: "123",
    },
  },

  // ── order.cancel ───────────────────────────────────────────────────────
  {
    label: "order.cancel: customerId + orderId",
    kind: "order.cancel",
    payload: {
      customerId: "cust_def_789",
      orderId: "ord_42",
      reason: "duplicate order",
    },
  },

  // ── reservation.create ─────────────────────────────────────────────────
  {
    label: "reservation.create: full PII",
    kind: "reservation.create",
    payload: {
      customerName: "Patricia Mendes",
      phone: "+5511444443333",
      partySize: 4,
      date: "2025-03-15",
      time: "20:00",
      notes: "Aniversariante: Patricia. Contato: patricia@example.com",
    },
  },
  {
    label: "reservation.create: minimal",
    kind: "reservation.create",
    payload: {
      customerName: "Marcos Silva",
      phone: "+5511333332222",
      partySize: 2,
      date: "2025-04-01",
      time: "19:30",
    },
  },

  // ── pix.charge.create ──────────────────────────────────────────────────
  {
    label: "pix.charge.create: customer block",
    kind: "pix.charge.create",
    payload: {
      orderId: "ord_55",
      amountCentavos: 12500,
      customer: {
        name: "Beatriz Cardoso",
        email: "beatriz@example.com",
        cpf: "555.666.777-88",
      },
    },
  },

  // ── customer.address.add ───────────────────────────────────────────────
  {
    label: "address.add: full",
    kind: "customer.address.add",
    payload: {
      customerId: "cust_xyz",
      addressLine1: "Rua das Flores 123 apt 45",
      addressLine2: "Bloco B",
      city: "São Paulo",
      cep: "01000-000",
    },
  },

  // ── customer.preferences.update (free-form text) ───────────────────────
  {
    label: "preferences.update: free-form note with PII",
    kind: "customer.preferences.update",
    payload: {
      customerId: "cust_aaa",
      preferences: {
        dietaryNotes:
          "Sem lactose. Alergia a amendoim. Contato emergência: 11999998888",
        favoriteDish: "Costela bovina defumada",
      },
    },
  },

  // ── Stress fixtures: nested arrays + adversarial shapes ────────────────
  {
    label: "nested arrays: multiple addresses",
    kind: "customer.profile.update",
    payload: {
      customerId: "cust_arr",
      addresses: [
        { addressLine1: "Rua A 1", cep: "01000-000" },
        { addressLine1: "Rua B 2", cep: "02000-000" },
        { addressLine1: "Rua C 3", cep: "03000-000" },
      ],
    },
  },
  {
    label: "deeply nested: 4 levels of objects",
    kind: "customer.profile.update",
    payload: {
      level1: {
        level2: {
          level3: {
            level4: {
              name: "Andre Souza",
              email: "deep@example.com",
              cpf: "999.888.777-66",
            },
          },
        },
      },
    },
  },
  {
    label: "adversarial: PII in description (no field-name hint)",
    kind: "customer.profile.update",
    payload: {
      description:
        "Cliente novo: Luana Rocha, email luana@test.com, cpf 444.555.666-77, fone +5511222221111",
    },
  },
  {
    label: "adversarial: comma-separated PII string",
    kind: "customer.create",
    payload: {
      raw: "João,joao@x.com,11999999999,12345678900",
    },
  },
  {
    label: "adversarial: PII in array of strings",
    kind: "customer.preferences.update",
    payload: {
      tags: ["loyal_customer", "joao@example.com", "+5511999998888"],
    },
  },
  {
    label: "adversarial: empty strings + nulls",
    kind: "customer.profile.update",
    payload: { name: "", email: "", cpf: null, phone: undefined },
  },
  {
    label: "adversarial: numeric CPF as number (not string)",
    kind: "customer.pix.details.save",
    payload: { cpf: 12345678900 }, // number — should still get sentinel
  },

  // ── Multi-occurrence: same PII type appearing multiple times ──────────
  {
    label: "multi-occurrence: two emails in one note",
    kind: "customer.profile.update",
    payload: {
      note: "Antes era ana@old.com, mudou para ana@new.com semana passada",
    },
  },
  {
    label: "multi-occurrence: two CPFs in one note",
    kind: "whatsapp.handoff.request",
    payload: {
      reason:
        "Cliente forneceu dois CPFs: 111.222.333-44 e 555.666.777-88, qual usar?",
    },
  },
  {
    label: "multi-occurrence: phone + CPF + email in one field",
    kind: "customer.preferences.update",
    payload: {
      customerId: "cust_mix",
      preferences: {
        contact:
          "Para urgências: 11999998888 ou contato@example.com (CPF na ficha: 333.444.555-66)",
      },
    },
  },

  // ── Card-format variants ───────────────────────────────────────────────
  {
    label: "card-format: 16 digits with spaces",
    kind: "order.checkout.create",
    payload: {
      cartId: "cart_x",
      cardNumber: "4111 1111 1111 1111",
      paymentMethod: "card",
    },
  },
  {
    label: "card-format: 16 digits with dashes",
    kind: "order.checkout.create",
    payload: {
      cartId: "cart_y",
      cardNumber: "4111-1111-1111-1111",
      paymentMethod: "card",
    },
  },
  {
    label: "card-format: AmEx 15 digits",
    kind: "order.checkout.create",
    payload: {
      cartId: "cart_z",
      cardNumber: "378282246310005",
      paymentMethod: "card",
    },
  },
  {
    label: "card-format: card-shape in memo",
    kind: "customer.preferences.update",
    payload: {
      preferences: { memo: "Tentei usar 4111 1111 1111 1111 mas falhou" },
    },
  },

  // ── Phone-format variants ──────────────────────────────────────────────
  {
    label: "phone-format: +55 spaced",
    kind: "customer.create",
    payload: { phone: "+55 11 99999-8888" },
  },
  {
    label: "phone-format: ddi 13 digits",
    kind: "customer.create",
    payload: { phone: "5511999998888" },
  },
  {
    label: "phone-format: 10-digit landline (11) 3xxx-xxxx",
    kind: "customer.create",
    payload: { phone: "(11) 3333-4444" },
  },

  // ── Mixed-language and accent variants ──────────────────────────────────
  {
    label: "mixed-locale: pt-BR PII descriptors",
    kind: "customer.profile.update",
    payload: {
      nome: "José", // pt-BR alias — covered by HASH_FIELDS
      observacao: "telefone do cliente: 11999998888",
    },
  },

  // ── Bypass attempts ─────────────────────────────────────────────────────
  {
    label: "bypass: PII in object key (not value)",
    kind: "customer.profile.update",
    payload: {
      // The key itself looks like a CPF — we don't redact keys, only values.
      // The contract assertion is on JSON output; if a key looked like PII
      // and the test passed, our regex would flag the JSON string. Good test.
      annotations: { "12345678900_was_processed": true },
    },
  },
  {
    label: "bypass: PII in nested array of objects",
    kind: "customer.preferences.update",
    payload: {
      history: [
        { actor: "user", text: "meu cpf é 123.456.789-00" },
        { actor: "agent", text: "obrigado" },
        { actor: "user", text: "email é teste@example.com" },
      ],
    },
  },
  {
    label: "bypass: PII in deeply nested validation event",
    kind: "validation.text.rewrite",
    payload: {
      stateValue: "checkout",
      originalText: "Confirmo CPF 123.456.789-00 e email a@b.com",
      rewritten: "Confirmo seus dados",
      meta: { confidence: 0.95, source: "claude" },
    },
  },

  // ── Empty / edge ────────────────────────────────────────────────────────
  {
    label: "edge: empty object",
    kind: "customer.profile.update",
    payload: {},
  },
  {
    label: "edge: empty array",
    kind: "customer.preferences.update",
    payload: { tags: [] },
  },
  {
    label: "edge: deeply nested empties",
    kind: "customer.profile.update",
    payload: { a: { b: { c: { d: {} } } } },
  },

  // ── Specific intent surfaces from the M3 routes (per task description) ─
  {
    label: "customer.welcome_credit (future Pack — generic PII shape)",
    kind: "customer.welcome_credit.grant",
    payload: {
      customerId: "cust_credit_1",
      email: "newuser@example.com",
      amountCentavos: 1500,
    },
  },
  {
    label: "customer.address.remove",
    kind: "customer.address.remove",
    payload: {
      customerId: "cust_rm_1",
      addressId: "addr_42",
      address: { addressLine1: "Rua Antiga 99" },
    },
  },
  {
    label: "customer.anonymize.cancel",
    kind: "customer.anonymize.cancel",
    payload: {
      customerId: "cust_def_789",
      reason: "Cliente João Henrique reverteu o pedido de exclusão",
    },
  },
]

// ── PII detection helper ─────────────────────────────────────────────────────

interface PIIFinding {
  readonly fixture: string
  readonly patterns: ReadonlyArray<{ type: string; match: string }>
}

function detectPII(record: AuditRecord, label: string): PIIFinding {
  // Serialize ONLY the redactor-controlled surface: `envelope.payload`.
  //
  // We deliberately exclude:
  //   - `record.intentHash` / `record.auditHash` — sha256 hex (64 chars). A
  //     uniform random 64-hex string has a ~50% chance of containing a
  //     10-digit-run substring that the BR phone regex would flag — those
  //     are not PII, they are hash collisions. Replay invariant requires
  //     these hashes survive redaction unchanged (see task spec).
  //   - `record.envelope.intentHash` — same.
  //   - `record.envelope.nonce` / `record.envelope.createdAt` — adopter-
  //     controlled metadata (the fixture builder uses fixed shapes that
  //     are PII-free; production nonces are UUIDs).
  //   - `record.envelope.actor.sessionId` — adopter-controlled. Sessions in
  //     IbateXas are SHA-256 hashed phone numbers (see apps/api/src/whatsapp/
  //     session.ts); the hash is PII-free.
  //   - The sentinel sub-strings `[REDACTED:CPF|EMAIL|PHONE|CARD]` and the
  //     `hashed:xxxxxxxx` prefix — these are the redactor's authorised
  //     output and must not flag.
  //
  // What remains is exactly the surface the redactor is responsible for.
  const payloadJson = JSON.stringify(record.envelope.payload)
  // Strip all sentinel sub-strings so a stray "REDACTED:PHONE" wrapper
  // cannot trip the phone regex if a digit happens to live nearby.
  const stripped = payloadJson
    .replace(/\[REDACTED(?::[A-Z]+)?\]/g, "")
    .replace(/hashed:[a-f0-9]{8}/g, "")

  const findings: Array<{ type: string; match: string }> = []
  for (const match of stripped.matchAll(CPF_DETECT)) {
    findings.push({ type: "CPF", match: match[0] })
  }
  for (const match of stripped.matchAll(EMAIL_DETECT)) {
    findings.push({ type: "EMAIL", match: match[0] })
  }
  for (const match of stripped.matchAll(PHONE_DETECT_55)) {
    findings.push({ type: "PHONE", match: match[0] })
  }
  for (const match of stripped.matchAll(CARD_DETECT)) {
    findings.push({ type: "CARD", match: match[0] })
  }
  return { fixture: label, patterns: findings }
}

// ── The contract assertion ───────────────────────────────────────────────────

describe("audit-redaction CONTRACT (CI gate)", () => {
  const redactor = createAuditRedactor({
    hashSecret: "contract-test-salt-32-chars-xxxxxx",
    warn: vi.fn(),
  })

  it("corpus must have 50+ representative fixtures", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(50)
  })

  it("every fixture produces a record whose JSON contains ZERO PII patterns", () => {
    const findings: PIIFinding[] = []
    for (let i = 0; i < CORPUS.length; i++) {
      const fx = CORPUS[i]!
      const record = makeRecord(fx, i)
      const redacted = redactor.redact(record)
      const result = detectPII(redacted, fx.label)
      if (result.patterns.length > 0) {
        findings.push(result)
      }
    }
    if (findings.length > 0) {
      // Build a human-readable failure report so CI logs show exactly which
      // fixture leaked which pattern.
      const report = findings
        .map(
          (f) =>
            `  - ${f.fixture}:\n` +
            f.patterns
              .map((p) => `      ${p.type}: ${JSON.stringify(p.match)}`)
              .join("\n"),
        )
        .join("\n")
      throw new Error(
        `PII leak detected in ${findings.length}/${CORPUS.length} fixtures:\n${report}`,
      )
    }
    expect(findings).toEqual([])
  })

  it("every fixture preserves intentHash + auditHash through redaction", () => {
    for (let i = 0; i < CORPUS.length; i++) {
      const fx = CORPUS[i]!
      const record = makeRecord(fx, i)
      const redacted = redactor.redact(record)
      expect(redacted.intentHash).toBe(record.intentHash)
      expect(redacted.auditHash).toBe(record.auditHash)
    }
  })

  it("every fixture preserves envelope governance fields (actor, taint, kind, nonce, createdAt, version)", () => {
    for (let i = 0; i < CORPUS.length; i++) {
      const fx = CORPUS[i]!
      const record = makeRecord(fx, i)
      const redacted = redactor.redact(record)
      expect(redacted.envelope.actor).toEqual(record.envelope.actor)
      expect(redacted.envelope.taint).toBe(record.envelope.taint)
      expect(redacted.envelope.kind).toBe(record.envelope.kind)
      expect(redacted.envelope.nonce).toBe(record.envelope.nonce)
      expect(redacted.envelope.createdAt).toBe(record.envelope.createdAt)
      expect(redacted.envelope.version).toBe(record.envelope.version)
    }
  })

  it("every fixture is idempotent (redact ∘ redact === redact)", () => {
    for (let i = 0; i < CORPUS.length; i++) {
      const fx = CORPUS[i]!
      const record = makeRecord(fx, i)
      const once = redactor.redact(record)
      const twice = redactor.redact(once)
      expect(twice).toEqual(once)
    }
  })
})

// ── Bypass-detection: every audit-emit goes through getAuditSink() ───────────
//
// Anti-regression for invariant: no IbateXas call site in `packages/llm-provider/src`
// builds a sink primitive directly and emits past the redactor. The
// canonical bypass shape is `multiSink(...)` or `createNatsSink({...}).emit`
// or `createConsoleSink({...}).emit` outside `intent-audit-wiring.ts`.
//
// We grep the source tree at test time. Any new file that pulls in
// `multiSink`/`createNatsSink`/`createConsoleSink` and calls `.emit(...)`
// directly will trip this check.

describe("audit-redaction CONTRACT — bypass detection", () => {
  it("no source file in src/ bypasses getAuditSink() to emit directly", () => {
    const srcDir = join(__dirname, "..")
    const offenders: string[] = []
    walkSrc(srcDir, (file, contents) => {
      // Skip the wiring file (it IS the authorised composer) and tests.
      if (file.endsWith("intent-audit-wiring.ts")) return
      if (file.endsWith("audit-redactor.ts")) return
      if (file.includes("/__tests__/")) return
      if (file.endsWith(".test.ts")) return

      // Pattern 1: someone imports a sink primitive AND calls .emit on it.
      const importsRawSink =
        /from\s+["']@adjudicate\/audit["']/.test(contents) &&
        /(multiSink|createNatsSink|createConsoleSink)/.test(contents)
      if (importsRawSink) {
        // Allow imports if the file ALSO routes through getAuditSink — but
        // be strict: the only acceptable consumer is intent-audit-wiring.
        offenders.push(file)
      }
    })
    if (offenders.length > 0) {
      throw new Error(
        `Audit-redactor bypass risk in:\n${offenders.map((f) => `  - ${f}`).join("\n")}\n` +
          `Only intent-audit-wiring.ts may import multiSink / createNatsSink / createConsoleSink directly.`,
      )
    }
    expect(offenders).toEqual([])
  })
})

function walkSrc(
  dir: string,
  visit: (file: string, contents: string) => void,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSrc(full, visit)
      continue
    }
    if (!entry.name.endsWith(".ts")) continue
    if (entry.name.endsWith(".d.ts")) continue
    const contents = readFileSync(full, "utf8")
    visit(full, contents)
  }
}
