// Tests for schema/scaffold.ts — `ibx journey from-audit <sessionId>` (T2-3).
//
// No DB, no network (CLAUDE.md test discipline): the pure scaffolder gets
// fixture transcript + observed tuples; the fetch orchestrator gets an
// injected OracleQueryable double that answers both the transcript SQL and
// the AuditReader's intent_audit SELECT with writer-shaped rows.

import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { lintJourneys } from "../../gates/lint.js"
import { parseJourneyYaml } from "../load.js"
import {
  FromAuditScaffoldError,
  observedDecisionsFromRecords,
  SCAFFOLD_PLACEHOLDER_ID,
  SCAFFOLD_REVIEW_BLOCKER,
  scaffoldFromAuditSession,
  scaffoldJourneyFromAudit,
  transcriptFromChatDumpJson,
  type ScaffoldTranscript,
} from "../scaffold.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RAW_SESSION_ID = "web:sess-fixture-0001"
const REDACT_SECRET = "test-redact-secret"

/** Independent re-derivation of the D-012 hash (sha256(raw + secret)[0..8]). */
function expectedHashed(raw: string, secret: string): string {
  return `hashed:${createHash("sha256").update(raw).update(secret).digest("hex").slice(0, 8)}`
}

/** An authenticated production-ish transcript (user fumbles, then succeeds). */
const TRANSCRIPT: ScaffoldTranscript = {
  customerId: "cus-fixture-001",
  messages: [
    { role: "user", content: "Oi, quero uma costela bovina defumada de 1kg" },
    { role: "assistant", content: "Claro! Vou adicionar a costela bovina defumada (1kg) ao seu pedido." },
    { role: "user", content: "Pode fechar o pedido, pago em dinheiro na retirada" },
    { role: "assistant", content: "Pedido fechado! Retirada no balcão, pagamento em dinheiro." },
    { role: "user", content: "Mudei de ideia, quero cancelar o pedido variant_01HFIXTUREID9999" },
    { role: "assistant", content: "Posso cancelar sim — você confirma o cancelamento?" },
  ],
}

/**
 * Observed audit tuples (trajectory order): an item-add fumble (REFUSE,
 * repeated) before the same kind EXECUTEs — the retry-noise shape — then the
 * money tuples. All kinds are chat-drivable registered kinds, exactly what a
 * hashed-chat-namespace slice contains (llm-principal planner envelopes).
 */
const OBSERVED = [
  { intentKind: "order.item.add", decision: "REFUSE" },
  { intentKind: "order.item.add", decision: "REFUSE" }, // duplicate → deduped
  { intentKind: "order.cart.ensure", decision: "EXECUTE" },
  { intentKind: "order.item.add", decision: "EXECUTE" }, // makes the REFUSE optional
  { intentKind: "order.checkout.create", decision: "EXECUTE" },
  // LE2-024 — was `order.cancel`. It left the chat tier with the ad-hoc
  // paid-cancel retirement, and the journey lint correctly began reporting
  // `expectation_unreachable` ("not producible by any declared act surface")
  // for a chat journey expecting it — the gate doing its job. Re-pointed at a
  // kind that is still chat-producible; nothing here is about cancel semantics,
  // this row exists to give the scaffolder a REQUEST_CONFIRMATION tuple.
  { intentKind: "order.item.update", decision: "REQUEST_CONFIRMATION" },
]

// ── Pure scaffolder ──────────────────────────────────────────────────────────

describe("scaffoldJourneyFromAudit", () => {
  const scaffolded = scaffoldJourneyFromAudit({
    sessionId: RAW_SESSION_ID,
    transcript: TRANSCRIPT,
    observed: OBSERVED,
    hashedSessionId: expectedHashed(RAW_SESSION_ID, REDACT_SECRET),
  })

  it("is born blocked on scaffold-review with the placeholder id + provenance", () => {
    expect(scaffolded.journey.id).toBe(SCAFFOLD_PLACEHOLDER_ID)
    expect(scaffolded.journey.status).toBe("blocked")
    expect(scaffolded.journey.blocked_by).toEqual([SCAFFOLD_REVIEW_BLOCKER])
    expect(scaffolded.journey.source).toBe(`from-audit:${RAW_SESSION_ID}`)
    expect(scaffolded.journey.params?.["authenticated"]).toBe(true) // customerId non-null
  })

  it("derives chat acts from the USER side of the transcript only", () => {
    expect(scaffolded.journey.acts).toHaveLength(3)
    for (const act of scaffolded.journey.acts) {
      expect(act.kind).toBe("chat")
    }
    const first = scaffolded.journey.acts[0]
    expect(first).toMatchObject({
      kind: "chat",
      utterance: "Oi, quero uma costela bovina defumada de 1kg",
    })
    // Assistant replies surface as review notes, never as acts.
    expect((first as { note?: string }).note).toContain("assistant replied:")
  })

  it("scrubs raw Medusa entity ids out of utterances (handle-only governance)", () => {
    const cancelAct = scaffolded.journey.acts[2] as { utterance?: string }
    expect(cancelAct.utterance).toBe("Mudei de ideia, quero cancelar o pedido <medusa-id>")
    expect(scaffolded.yaml).not.toContain("variant_01HFIXTUREID9999")
  })

  it("derives expects[] as deduped trajectory tuples with the noise heuristic", () => {
    expect(scaffolded.journey.expects).toEqual([
      // REFUSE before a same-kind success → optional allowance (T1b-1)
      { intentKind: "order.item.add", decision: "REFUSE", optional: true },
      { intentKind: "order.cart.ensure", decision: "EXECUTE" },
      { intentKind: "order.item.add", decision: "EXECUTE" },
      { intentKind: "order.checkout.create", decision: "EXECUTE" },
      { intentKind: "order.item.update", decision: "REQUEST_CONFIRMATION" },
    ])
  })

  it("emits the verify skeleton (trajectory + tamper-evidence + TODO goal-state markers)", () => {
    expect(scaffolded.journey.verify.map((v) => v.invariant)).toEqual([
      "audit.trajectory.in_order",
      "audit.record.verified",
    ])
    expect(scaffolded.yaml).toContain("TODO(scaffold-review): add goal-state invariants")
  })

  it("emits schema-valid YAML (the emitted text itself round-trips)", () => {
    const reparsed = parseJourneyYaml(scaffolded.yaml, "scaffold.test.ts")
    expect(reparsed.id).toBe(SCAFFOLD_PLACEHOLDER_ID)
    expect(reparsed.expects).toEqual(scaffolded.journey.expects)
  })

  it("matches the snapshot", () => {
    expect(scaffolded.yaml).toMatchSnapshot()
  })

  it("marks REFUSE without a later same-kind success as REQUIRED (pinned-negative shape)", () => {
    const negative = scaffoldJourneyFromAudit({
      sessionId: RAW_SESSION_ID,
      transcript: { customerId: null, messages: [{ role: "user", content: "quero finalizar" }] },
      observed: [{ intentKind: "order.checkout.create", decision: "REFUSE" }],
    })
    expect(negative.journey.expects).toEqual([
      { intentKind: "order.checkout.create", decision: "REFUSE" },
    ])
    expect(negative.journey.params?.["authenticated"]).toBe(false) // guest until review
  })

  it("marks inner *.status.transition tuples optional (JOURNEY-001 precedent)", () => {
    const withInner = scaffoldJourneyFromAudit({
      sessionId: RAW_SESSION_ID,
      transcript: TRANSCRIPT,
      observed: [
        { intentKind: "order.item.update", decision: "EXECUTE" },
        { intentKind: "order.status.transition", decision: "EXECUTE" },
      ],
    })
    expect(withInner.journey.expects).toEqual([
      { intentKind: "order.item.update", decision: "EXECUTE" },
      { intentKind: "order.status.transition", decision: "EXECUTE", optional: true },
    ])
  })

  it("rejects a transcript with no user-side utterances with a clear error", () => {
    expect(() =>
      scaffoldJourneyFromAudit({
        sessionId: RAW_SESSION_ID,
        transcript: { customerId: null, messages: [{ role: "assistant", content: "Olá!" }] },
        observed: OBSERVED,
      }),
    ).toThrowError(/no user-side utterances/)
  })
})

// ── Scaffold → `ibx journey lint` (the acceptance seam) ──────────────────────

describe("scaffold passes `ibx journey lint` (as blocked)", () => {
  let dir: string

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  it("lints green straight out of the scaffolder", async () => {
    const { yaml } = scaffoldJourneyFromAudit({
      sessionId: RAW_SESSION_ID,
      transcript: TRANSCRIPT,
      observed: OBSERVED,
      hashedSessionId: expectedHashed(RAW_SESSION_ID, REDACT_SECRET),
    })
    dir = await mkdtemp(join(tmpdir(), "journeys-from-audit-"))
    await writeFile(join(dir, "JOURNEY-000-from-audit-scaffold.yaml"), yaml)

    const report = await lintJourneys({ dir })
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.journeys).toHaveLength(1)
    expect(report.journeys[0]).toMatchObject({
      id: SCAFFOLD_PLACEHOLDER_ID,
      status: "blocked",
      personaContext: "authed-customer", // params.authenticated from conversations.customer_id
    })
  })
})

// ── Record + chat-dump projections ───────────────────────────────────────────

describe("observedDecisionsFromRecords", () => {
  it("projects envelope.kind × decision.kind in order", () => {
    const records = [
      { envelope: { kind: "order.item.update" }, decision: { kind: "REQUEST_CONFIRMATION" } },
      { envelope: { kind: "order.item.update" }, decision: { kind: "EXECUTE" } },
    ] as unknown as Parameters<typeof observedDecisionsFromRecords>[0]
    expect(observedDecisionsFromRecords(records)).toEqual([
      { intentKind: "order.item.update", decision: "REQUEST_CONFIRMATION" },
      { intentKind: "order.item.update", decision: "EXECUTE" },
    ])
  })
})

describe("transcriptFromChatDumpJson", () => {
  it("parses `ibx chat dump --json` output (customerId unknown → guest)", () => {
    const dump = JSON.stringify([
      { role: "user", content: "oi", sentAt: "2026-06-01T00:00:00Z", metadata: null },
      { role: "assistant", content: "olá!" },
    ])
    expect(transcriptFromChatDumpJson(dump)).toEqual({
      customerId: null,
      messages: [
        { role: "user", content: "oi" },
        { role: "assistant", content: "olá!" },
      ],
    })
  })

  it("rejects non-array JSON with a clear error", () => {
    expect(() => transcriptFromChatDumpJson('{"role":"user"}')).toThrowError(/ARRAY/)
    expect(() => transcriptFromChatDumpJson("not json")).toThrowError(/not valid JSON/)
  })
})

// ── Fetch orchestrator (injected oracle double) ──────────────────────────────

interface QueryCall {
  text: string
  values: unknown[]
}

/** Minimal writer-shaped intent_audit row (record_version 1 — rowToRecord-compatible). */
function auditRow(hashed: string, kind: string, decision: string, at: string): Record<string, unknown> {
  return {
    intent_hash: `hash-${kind}-${decision}-${at}`,
    session_id: hashed,
    kind,
    principal: "llm",
    taint: "LLM",
    decision_kind: decision,
    refusal_kind: null,
    refusal_code: null,
    decision_basis: null,
    resource_version: null,
    envelope_jsonb: {
      version: 1,
      kind,
      payload: {},
      createdAt: at,
      nonce: "nonce-1",
      actor: { principal: "llm", sessionId: hashed },
      taint: "LLM",
      intentHash: `hash-${kind}-${decision}-${at}`,
    },
    decision_jsonb: { kind: decision, basis: [] },
    recorded_at: new Date(at),
    duration_ms: 5,
    partition_month: at.slice(0, 7),
    record_version: 1,
    plan_jsonb: null,
    nonce: null,
    supersedes_jsonb: null,
    kernel_identity_jsonb: null,
    policy_version: null,
    kernel_version: null,
    audit_hash: null,
    signature_jsonb: null,
  }
}

function oracleDouble(answers: {
  auditRows: Record<string, unknown>[]
  transcriptRows: Record<string, unknown>[]
}): { calls: QueryCall[]; pool: { query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> } } {
  const calls: QueryCall[] = []
  return {
    calls,
    pool: {
      async query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
        calls.push({ text, values })
        if (text.includes("FROM intent_audit")) return { rows: answers.auditRows }
        if (text.includes("ibx_domain.conversations")) return { rows: answers.transcriptRows }
        throw new Error(`oracle double got an unexpected query: ${text}`)
      },
    },
  }
}

describe("scaffoldFromAuditSession", () => {
  const HASHED = expectedHashed(RAW_SESSION_ID, REDACT_SECRET)
  const ENV = { AUDIT_REDACT_SECRET: REDACT_SECRET }

  it("refuses to run without AUDIT_REDACT_SECRET (D-012 namespace derivation)", async () => {
    const { pool } = oracleDouble({ auditRows: [], transcriptRows: [] })
    await expect(
      scaffoldFromAuditSession(RAW_SESSION_ID, { env: {}, pool }),
    ).rejects.toThrowError(/AUDIT_REDACT_SECRET is not set/)
  })

  it("scopes the audit fetch to the HASHED namespace and scaffolds the slice", async () => {
    const { pool, calls } = oracleDouble({
      auditRows: [
        auditRow(HASHED, "order.checkout.create", "EXECUTE", "2026-06-01T12:00:00.000Z"),
        auditRow(HASHED, "order.item.update", "REQUEST_CONFIRMATION", "2026-06-01T12:01:00.000Z"),
      ],
      transcriptRows: [
        { customerId: "cus-fixture-001", role: "user", content: "quero fechar o pedido" },
        { customerId: "cus-fixture-001", role: "assistant", content: "fechado!" },
        { customerId: "cus-fixture-001", role: "user", content: "quero cancelar" },
      ],
    })

    const result = await scaffoldFromAuditSession(RAW_SESSION_ID, { env: ENV, pool })

    // D-012: the intent_audit scope is the hashed namespace, never the raw id.
    const auditCall = calls.find((c) => c.text.includes("FROM intent_audit"))
    expect(auditCall?.values[0]).toEqual([HASHED])
    // The transcript lookup uses the RAW session id (conversations stores it raw).
    const transcriptCall = calls.find((c) => c.text.includes("ibx_domain.conversations"))
    expect(transcriptCall?.values[0]).toBe(RAW_SESSION_ID)

    expect(result.hashedSessionId).toBe(HASHED)
    expect(result.auditRows).toBe(2)
    expect(result.chatActs).toBe(2)
    expect(result.journey.status).toBe("blocked")
    expect(result.journey.params?.["authenticated"]).toBe(true)
    expect(result.journey.expects).toEqual([
      { intentKind: "order.checkout.create", decision: "EXECUTE" },
      { intentKind: "order.item.update", decision: "REQUEST_CONFIRMATION" },
    ])
    expect(result.yaml).toContain(HASHED)
    expect(result.yaml).not.toContain(REDACT_SECRET)
  })

  it("fails an unknown session with a clear error naming the hashed namespace", async () => {
    const { pool } = oracleDouble({ auditRows: [], transcriptRows: [] })
    await expect(
      scaffoldFromAuditSession("web:sess-nobody", { env: ENV, pool }),
    ).rejects.toThrowError(
      new RegExp(
        `unknown session "web:sess-nobody".*${expectedHashed("web:sess-nobody", REDACT_SECRET)}`,
      ),
    )
  })

  it("requires a transcript when audit rows exist (acts come from the user side)", async () => {
    const { pool } = oracleDouble({
      auditRows: [auditRow(HASHED, "order.item.update", "EXECUTE", "2026-06-01T12:00:00.000Z")],
      transcriptRows: [],
    })
    await expect(
      scaffoldFromAuditSession(RAW_SESSION_ID, { env: ENV, pool }),
    ).rejects.toThrowError(/no conversation transcript/)
  })

  it("accepts an injected chat-dump transcript (Redis-only sessions)", async () => {
    const { pool } = oracleDouble({
      auditRows: [auditRow(HASHED, "order.item.update", "REQUEST_CONFIRMATION", "2026-06-01T12:00:00.000Z")],
      transcriptRows: [], // Postgres conversation row already expired/never written
    })
    const transcript = transcriptFromChatDumpJson(
      JSON.stringify([{ role: "user", content: "cancela meu pedido por favor" }]),
    )
    const result = await scaffoldFromAuditSession(RAW_SESSION_ID, { env: ENV, pool, transcript })
    expect(result.chatActs).toBe(1)
    expect(result.journey.params?.["authenticated"]).toBe(false)
    expect(result.journey.expects).toEqual([
      { intentKind: "order.item.update", decision: "REQUEST_CONFIRMATION" },
    ])
  })

  it("propagates FromAuditScaffoldError as the named error type", async () => {
    const { pool } = oracleDouble({ auditRows: [], transcriptRows: [] })
    await expect(
      scaffoldFromAuditSession("web:sess-nobody", { env: ENV, pool }),
    ).rejects.toBeInstanceOf(FromAuditScaffoldError)
  })
})
