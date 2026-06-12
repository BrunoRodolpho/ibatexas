// T1a-5 LIVE contract test — ChatClient against the REAL ephemeral test stack
// (real Conductor turn, real ANTHROPIC_API_KEY from .env.test — never printed).
// Proves the stub in chat-client.test.ts equals the route's actual contract:
//
//   • guest two-turn conversation completes with session reuse (the dealt
//     sessionSecret is echoed on POST #2 + both SSE GETs — the route 403s
//     otherwise, chat.ts:200-209/:388-398, which is exactly where the
//     `ibx api chat` reference breaks);
//   • authenticated conversation (T1a-4 minted cookie) — after a turn whose
//     utterance PROPOSES (an authenticated cart add), the run's audit trail
//     carries the turn's envelope.
//
// ── What the audit row carries (the recorded T1a-5 choice) ──────────────────
// A smalltalk turn dispatches NO envelope — `intent_audit` gets no row at all
// for it, so the audit row cannot carry request.customerId for smalltalk.
// The chat-plane planner pins `actor: { principal: "llm", sessionId:
// state.conversationId }` (apps/api/src/claustrum/ibatexas-planner.ts:263),
// so even for a proposing turn `intent_audit.session_id` is the CHAT
// sessionId (the conversation handle this client minted), NOT the
// customerId; `payload.customerId` is whatever the LLM emitted — NOT
// guaranteed (the P0-2/D-008 documented recall gap). The cheapest CORRECT
// assertions are therefore BOTH of:
//   1. customerId binding — the SUT mints `sessionToken` ONLY when
//      request.customerId is set (chat.ts:249-251), and the token IS the
//      signed sessionId↔customerId binding of the chat session store
//      (signed-claims.ts:63-67). We verify it offline with the test stack's
//      SESSION_HMAC_SECRET — this is the "chat session store binding"
//      alternative the plan names.
//   2. envelope presence — an `order.cart.ensure`/`order.item.add` row in
//      intent_audit scoped via the read-only oracle reader (T1a-7/T1a-9).
//      LIVE FINDING (binding for T1a-13/T1b-1 scoping): the audit sink's
//      redactor HASHES actor.sessionId before the row lands —
//      `hashed:<sha256(sessionId + AUDIT_REDACT_SECRET).hex.slice(0,8)>`
//      (packages/audit-sink/src/audit-redactor.ts:847,:1106-1111; secret
//      wired at intent-audit-wiring.ts:210). The run's intent_audit
//      namespace for chat acts is therefore the HASHED form of the chat
//      sessionId, which this test computes the same way.
//
// GATED twice (T1a-4 idiom): IBX_LIVE_CONTRACT=1 + the /health
// testFingerprint handshake against .env.test.
//
// How to run (serialize with other agents via /tmp/ibx-test-stack.lock.d):
//   ./scripts/test-stack-up.sh
//   IBX_LIVE_CONTRACT=1 pnpm --filter @ibatexas/journeys exec vitest run \
//     src/clients/__tests__/chat-client.live.test.ts
//   ./scripts/test-stack-down.sh   # ALWAYS — including after failures
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { verifySessionToken } from "@ibatexas/tools"
import type { AuditRecord } from "@adjudicate/core"
import { mintCustomerToken, cookieHeader } from "../auth-fixture.js"
import { ChatClient } from "../chat-client.js"
import { createAuditReader, type AuditReader } from "../../oracle/audit-reader.js"
import { requireOracleDatabaseUrl } from "../../oracle/oracle-database-url.js"

const LIVE = process.env["IBX_LIVE_CONTRACT"] === "1"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const ENV_TEST_PATH = path.join(REPO_ROOT, ".env.test")

/** Test-profile api base (process-compose.test.yaml binds :3001). */
const API_BASE = process.env["IBX_TEST_API_URL"] ?? "http://localhost:3001"

/** Kinds an authenticated cart-add utterance can propose (pack-orders capabilities.ts:78-81). */
const CART_KINDS = new Set(["order.cart.ensure", "order.item.add"])

/**
 * The audit sink's salted-hash for actor.sessionId — byte-for-byte mirror of
 * `hashValue` (packages/audit-sink/src/audit-redactor.ts:1106-1111):
 * `hashed:` + sha256(value || secret) hex, first 8 chars. The secret is
 * AUDIT_REDACT_SECRET (intent-audit-wiring.ts:210; "" tolerated with a warn).
 */
function hashedSessionId(sessionId: string, redactSecret: string): string {
  const h = createHash("sha256")
  h.update(sessionId)
  h.update(redactSecret)
  return `hashed:${h.digest("hex").slice(0, 8)}`
}

/** Minimal KEY=VALUE parser for the gitignored .env.test (no dotenv dep). */
function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function requireVar(env: Record<string, string>, name: string): string {
  const value = env[name]
  if (value === undefined || value === "") {
    throw new Error(`.env.test is missing ${name} — regenerate with ./scripts/gen-env-test.sh`)
  }
  return value
}

/** Poll the oracle for the session's audited cart envelope (writes land in-turn, before done — small grace anyway). */
async function pollCartRecords(
  reader: AuditReader,
  auditScopeId: string,
  timeoutMs: number,
): Promise<AuditRecord[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const records = await reader.fetchRecords({ sessionIds: [auditScopeId] })
    const matches = records.filter((r) => CART_KINDS.has(r.envelope.kind))
    if (matches.length > 0 || Date.now() >= deadline) return matches
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

describe.skipIf(!LIVE)("ChatClient live contract (IBX_LIVE_CONTRACT=1, test stack up)", () => {
  let testEnv: Record<string, string>
  let jwtSecret: string
  let oracle: pg.Client
  let reader: AuditReader
  let customerId: string

  beforeAll(async () => {
    testEnv = parseEnvFile(await readFile(ENV_TEST_PATH, "utf8"))
    jwtSecret = requireVar(testEnv, "JWT_SECRET")
    const fingerprint = requireVar(testEnv, "IBX_TEST_FINGERPRINT")

    // Minting gate (D-010) + offline sessionToken verification: the harness
    // process carries the same fingerprint AND HMAC secret as the stack.
    vi.stubEnv("IBX_TEST_FINGERPRINT", fingerprint)
    vi.stubEnv("SESSION_HMAC_SECRET", requireVar(testEnv, "SESSION_HMAC_SECRET"))

    // Stack handshake — refuse to drive anything but THIS test stack.
    let health: Response
    try {
      health = await fetch(`${API_BASE}/health`)
    } catch {
      throw new Error(
        `test stack is not up at ${API_BASE} — run ./scripts/test-stack-up.sh first`,
      )
    }
    const body = (await health.json()) as { testFingerprint?: string }
    if (body.testFingerprint !== fingerprint) {
      throw new Error(
        `/health testFingerprint does not match .env.test — refusing (wrong stack?)`,
      )
    }

    // Read-only oracle plane (T1a-9 role): precondition lookups + the
    // intent_audit assertions. Structurally incapable of mutating SUT state.
    oracle = new pg.Client({ connectionString: requireOracleDatabaseUrl(testEnv) })
    await oracle.connect()
    reader = createAuditReader({ env: testEnv })

    const customers = await oracle.query("SELECT id FROM ibx_domain.customers LIMIT 1")
    if (customers.rows.length === 0) {
      throw new Error("no seeded customers — run `ibx test seed` (test-stack-up step 4/4)")
    }
    customerId = (customers.rows[0] as { id: string }).id
  }, 120_000)

  afterAll(async () => {
    await reader?.close().catch(() => undefined)
    await oracle?.end().catch(() => undefined)
    vi.unstubAllEnvs()
  })

  it("guest two-turn conversation completes with session reuse (secret echoed end-to-end)", async () => {
    const client = new ChatClient({ baseUrl: API_BASE, turnTimeoutMs: 150_000 })

    const turn1 = await client.perTurn("Oi! Tudo bem?")
    expect(turn1.replyText.length).toBeGreaterThan(0)
    // The route dealt a guest secret on the first POST (chat.ts:211-214)…
    expect(client.sessionSecret).toBeDefined()

    // …and turn 2 only completes because the client echoes it on the POST
    // (chat.ts:200-209) AND the SSE GET (chat.ts:388-398).
    const turn2 = await client.perTurn("Quais cortes de carne vocês vendem?")
    expect(turn2.replyText.length).toBeGreaterThan(0)
    expect(client.turnsCompleted).toBe(2)
  }, 360_000)

  it("authenticated cart-add turn → sessionToken binds the customerId; intent_audit carries the envelope", async () => {
    const minted = mintCustomerToken({ customerId, jwtSecret })
    const client = new ChatClient({
      baseUrl: API_BASE,
      cookie: cookieHeader(minted),
      turnTimeoutMs: 150_000,
    })

    const turn1 = await client.perTurn(
      "Adicione 2 unidades de Costela Bovina Defumada ao meu carrinho agora, por favor.",
    )
    expect(turn1.replyText.length).toBeGreaterThan(0)

    // ── Assertion 1: chat session store binding (sessionId ↔ customerId) ──
    // sessionToken is minted ONLY when request.customerId is set
    // (chat.ts:249-251) — its presence alone proves the cookie authenticated;
    // verifying it with the stack's SESSION_HMAC_SECRET proves the binding.
    expect(client.sessionToken).toBeDefined()
    const claim = verifySessionToken(client.sessionToken!)
    expect(claim).not.toBeNull()
    expect(claim!.sessionId).toBe(client.sessionId)
    expect(claim!.customerId).toBe(customerId)

    // ── Assertion 2: the proposing turn's audited envelope ─────────────────
    // The planner pins actor.sessionId to the conversationId
    // (ibatexas-planner.ts:263) and the audit sink's redactor then HASHES it
    // (audit-redactor.ts:847) — so the run's intent_audit namespace for chat
    // acts is hashedSessionId(chat sessionId). A smalltalk turn writes no
    // row at all — hence the explicitly-proposing utterance (recorded choice
    // above).
    const auditScopeId = hashedSessionId(
      client.sessionId,
      testEnv["AUDIT_REDACT_SECRET"] ?? "",
    )
    let matches = await pollCartRecords(reader, auditScopeId, 20_000)
    if (matches.length === 0) {
      // Anti-flake nudge: if the model asked a clarifying question instead of
      // proposing on turn 1, confirm once and re-poll.
      await client.perTurn("Sim, pode adicionar ao carrinho agora.")
      matches = await pollCartRecords(reader, auditScopeId, 20_000)
    }

    expect(matches.length).toBeGreaterThan(0)
    const record = matches[0]!
    expect(CART_KINDS.has(record.envelope.kind)).toBe(true)
    expect(record.envelope.actor.sessionId).toBe(auditScopeId)
    expect(record.envelope.actor.principal).toBe("llm")
    // Documented (NOT asserted — D-008 recall gap): payload.customerId is
    // whatever the LLM emitted. Log presence for the record.
    const payload = record.envelope.payload as Record<string, unknown> | undefined
    console.log(
      `[T1a-5 live] audit row: kind=${record.envelope.kind} decision=${record.decision.kind} ` +
        `session_id=${auditScopeId} (hashed chat sessionId) ` +
        `payload.customerId=${String(payload?.["customerId"] ?? "<absent>")}`,
    )
  }, 360_000)
})
