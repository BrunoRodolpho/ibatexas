// AUT-025 — `ibx kernel audit-verify` command coverage.
//
// Drives the command surface end-to-end (Commander + runAuditVerify) with a
// fake `pg.Client` returning writer-shaped intent_audit rows. Signatures are
// minted with a real ed25519 key over the SAME canonical pre-image the
// production signer uses (`auditSignaturePreimage`), so the verify path is
// exercised against genuine signatures.

import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Command } from "commander"
import {
  auditSignaturePreimage,
  buildAuditRecord,
  buildEnvelope,
  type AuditRecord,
} from "@adjudicate/core"
import { registerKernelCommands } from "../kernel.js"

// ── Stdout capture ────────────────────────────────────────────────────────

function captureStdout(): { restore: () => void; getOutput: () => string } {
  const chunks: string[] = []
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    chunks.push(args.join(" "))
  })
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    chunks.push(args.join(" "))
  })
  return {
    restore: () => {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    },
    getOutput: () => chunks.join("\n"),
  }
}

// ── Fake pg client ────────────────────────────────────────────────────────

const pgFake = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reset() {
    this.rows = []
  },
}))

vi.mock("pg", () => ({
  default: {
    Client: vi.fn(function (this: unknown) {
      const self = this as {
        connect: () => Promise<void>
        end: () => Promise<void>
        query: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      self.connect = vi.fn(async () => undefined)
      self.end = vi.fn(async () => undefined)
      self.query = vi.fn(async (sql: string) => ({
        rows: sql.startsWith("SELECT") ? pgFake.rows : [],
      }))
      return self
    }),
  },
}))

// ── Fixtures ──────────────────────────────────────────────────────────────

function keypair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    priv: privateKey,
    pubB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }
}

function realRecord(nonce: string): AuditRecord {
  const envelope = buildEnvelope({
    kind: "order.cart.ensure",
    payload: { cartId: `cart_${nonce}` },
    actor: { principal: "user", sessionId: "customer:test" },
    taint: "TRUSTED",
    nonce,
  })
  return buildAuditRecord({
    envelope,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
  })
}

function ed25519SignatureJsonb(priv: KeyObject, auditHash: string, keyId: string): string {
  const value = cryptoSign(
    null,
    Buffer.from(auditSignaturePreimage(auditHash, keyId), "utf8"),
    priv,
  ).toString("base64")
  return JSON.stringify({ keyId, alg: "ed25519", value })
}

/** Writer-shaped intent_audit row from a record + optional signature. */
function rowFrom(
  record: AuditRecord,
  signatureJsonb: string | null,
): Record<string, unknown> {
  return {
    intent_hash: record.intentHash,
    session_id: record.envelope.actor.sessionId,
    kind: record.envelope.kind,
    principal: record.envelope.actor.principal,
    taint: record.envelope.taint,
    decision_kind: record.decision.kind,
    refusal_kind: null,
    refusal_code: null,
    decision_basis: [],
    resource_version: null,
    envelope_jsonb: JSON.stringify(record.envelope),
    decision_jsonb: JSON.stringify(record.decision),
    recorded_at: record.at ?? new Date().toISOString(),
    duration_ms: 1,
    partition_month: new Date().toISOString().slice(0, 7),
    record_version: record.version ?? 4,
    plan_jsonb: null,
    nonce: record.envelope.nonce,
    supersedes_jsonb: null,
    kernel_identity_jsonb: null,
    policy_version: null,
    kernel_version: null,
    audit_hash: record.auditHash,
    signature_jsonb: signatureJsonb,
    metadata_jsonb: null,
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────

let cmd: Command
let stdout: ReturnType<typeof captureStdout>
let savedEnv: Record<string, string | undefined>
let key: ReturnType<typeof keypair>

beforeEach(() => {
  cmd = new Command()
  cmd.exitOverride()
  registerKernelCommands(cmd)
  stdout = captureStdout()
  pgFake.reset()
  key = keypair()
  savedEnv = {
    IBX_AUDIT_POSTGRES_ENABLED: process.env.IBX_AUDIT_POSTGRES_ENABLED,
    DATABASE_URL: process.env.DATABASE_URL,
    AUDIT_SIGNING_PUBLIC_KEY: process.env.AUDIT_SIGNING_PUBLIC_KEY,
  }
  process.env.IBX_AUDIT_POSTGRES_ENABLED = "true"
  process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock"
  process.env.AUDIT_SIGNING_PUBLIC_KEY = key.pubB64
})

afterEach(() => {
  stdout.restore()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.exitCode = 0
})

function parseJsonOut(): {
  counts: Record<string, number>
  exitCode: number
  publicKeyLoaded: boolean
  status?: string
} {
  return JSON.parse(stdout.getOutput())
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ibx kernel audit-verify (AUT-025)", () => {
  it("classifies signed-valid / signed-invalid / unsigned and exits 2 on a forged signature", async () => {
    const valid = realRecord("n1")
    const invalid = realRecord("n2")
    const unsigned = realRecord("n3")
    const other = keypair()
    pgFake.rows = [
      rowFrom(valid, ed25519SignatureJsonb(key.priv, valid.auditHash!, "k1")),
      // Signed with a DIFFERENT key than AUDIT_SIGNING_PUBLIC_KEY → invalid.
      rowFrom(invalid, ed25519SignatureJsonb(other.priv, invalid.auditHash!, "k1")),
      rowFrom(unsigned, null),
    ]

    await cmd.parseAsync(["audit-verify", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()

    expect(out.publicKeyLoaded).toBe(true)
    expect(out.counts.scanned).toBe(3)
    expect(out.counts.signedValid).toBe(1)
    expect(out.counts.signedInvalid).toBe(1)
    expect(out.counts.unsigned).toBe(1)
    expect(out.exitCode).toBe(2)
    expect(process.exitCode).toBe(2)
  })

  it("exit 0 when every row is signed-valid", async () => {
    const a = realRecord("a")
    const b = realRecord("b")
    pgFake.rows = [
      rowFrom(a, ed25519SignatureJsonb(key.priv, a.auditHash!, "k1")),
      rowFrom(b, ed25519SignatureJsonb(key.priv, b.auditHash!, "k1")),
    ]
    await cmd.parseAsync(["audit-verify", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.counts.signedValid).toBe(2)
    expect(out.counts.signedInvalid).toBe(0)
    expect(out.counts.hashTampered).toBe(0)
    expect(out.exitCode).toBe(0)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it("--ci fails (exit 2) when unsigned rows are present", async () => {
    const a = realRecord("a")
    const u = realRecord("u")
    pgFake.rows = [
      rowFrom(a, ed25519SignatureJsonb(key.priv, a.auditHash!, "k1")),
      rowFrom(u, null),
    ]
    await cmd.parseAsync(["audit-verify", "--since=24h", "--json", "--ci"], { from: "user" })
    const out = parseJsonOut()
    expect(out.counts.unsigned).toBe(1)
    expect(out.exitCode).toBe(2)
  })

  it("without --ci, unsigned rows are reported but do NOT fail (rollout-tolerant)", async () => {
    const u = realRecord("u")
    pgFake.rows = [rowFrom(u, null)]
    await cmd.parseAsync(["audit-verify", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.counts.unsigned).toBe(1)
    expect(out.exitCode).toBe(0)
  })

  it("--ci with no AUDIT_SIGNING_PUBLIC_KEY is a hard failure (exit 1)", async () => {
    delete process.env.AUDIT_SIGNING_PUBLIC_KEY
    const a = realRecord("a")
    pgFake.rows = [rowFrom(a, ed25519SignatureJsonb(key.priv, a.auditHash!, "k1"))]
    await cmd.parseAsync(["audit-verify", "--since=24h", "--json", "--ci"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("no-public-key")
    expect(process.exitCode).toBe(1)
  })

  it("without a public key (non-ci), signed rows are counted unverified", async () => {
    delete process.env.AUDIT_SIGNING_PUBLIC_KEY
    const a = realRecord("a")
    pgFake.rows = [rowFrom(a, ed25519SignatureJsonb(key.priv, a.auditHash!, "k1"))]
    await cmd.parseAsync(["audit-verify", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.publicKeyLoaded).toBe(false)
    expect(out.counts.unverifiedNoPubkey).toBe(1)
    expect(out.exitCode).toBe(0)
  })
})
