// signing-sink.test.ts — AUT-025: proves the sink signs AFTER redaction (so
// the signature commits to the FINAL persisted audit_hash) and fails CLOSED
// when the signer throws. Uses the REAL redactor (which recomputes audit_hash
// + drops any earlier signature) so the ordering is exercised end to end.

import { afterEach, describe, expect, it } from "vitest"
import { createInMemorySpillStorage } from "@adjudicate/audit"
import {
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto"
import {
  buildAuditRecord,
  buildEnvelope,
  verifyAuditRecord,
  type AuditRecord,
} from "@adjudicate/core"
import {
  __resetAuditSink,
  __resetAuditSigner,
  __setAuditSigner,
  __setAuditSinkDependencies,
  buildEd25519AuditSigner,
  createAuditRedactor,
  getAuditSink,
  makeEd25519SignatureVerifier,
  type AuditSinkDependencies,
  type AuditSinkLogger,
} from "../index.js"

function keypair(): { priv: KeyObject; pub: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return { priv: privateKey, pub: publicKey }
}

// A REAL record (correct envelope intentHash + auditHash). The actor uses the
// STRICT managed-agent namespace (`agent:<id>@<semver>:entity:<...>`), which the
// redactor preserves verbatim, and the payload carries no PII — so redaction is
// a content no-op and the recomputed auditHash equals the original, letting the
// FULL verifyAuditRecord chain (envelope + hash + signature) pass through the
// real redactor. (Rows whose actor/payload IS redacted legitimately fail the
// envelope axis — the CLI verifier checks the signature independently of it.)
function realAuditRecord(): AuditRecord {
  const envelope = buildEnvelope({
    kind: "order.cart.ensure",
    payload: { cartId: "cart_fake" },
    actor: {
      principal: "system",
      sessionId: "agent:cart-bot@1.0.0:entity:order-123",
    },
    taint: "SYSTEM",
    nonce: "nonce-fake",
  })
  return buildAuditRecord({
    envelope,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
  })
}

function makeDeps(
  capture: (r: AuditRecord) => void,
): AuditSinkDependencies {
  const logger: AuditSinkLogger = { warn() {}, error() {} }
  return {
    spillStorage: createInMemorySpillStorage(),
    postgresWriter: { async insertAudit() {} },
    natsPublisher: { async publish() {} },
    // REAL redactor — recomputes audit_hash post-redaction and drops signatures.
    redactor: createAuditRedactor({ hashSecret: "test-salt" }),
    logger,
    onAuditRecord: capture,
  }
}

afterEach(() => {
  __resetAuditSink()
  __resetAuditSigner()
})

describe("getAuditSink() post-redaction signing (AUT-025)", () => {
  it("emits a record whose signature verifies against the FINAL (post-redaction) audit_hash", async () => {
    const { priv, pub } = keypair()
    let captured: AuditRecord | undefined
    __setAuditSinkDependencies(makeDeps((r) => (captured = r)))
    __setAuditSigner(buildEd25519AuditSigner(priv, "ibx-audit-test"))

    await getAuditSink().emit(realAuditRecord())

    expect(captured).toBeDefined()
    const rec = captured!
    // Signature attached, correct shape.
    expect(rec.signature).toBeDefined()
    expect(rec.signature!.alg).toBe("ed25519")
    expect(rec.signature!.keyId).toBe("ibx-audit-test")
    expect(rec.auditHash).toBeDefined()
    // The signature verifies against the emitted (post-redaction) audit_hash.
    expect(makeEd25519SignatureVerifier(pub)(rec.auditHash!, rec.signature!)).toBe(true)
    // Full chain: envelope + hash + signature axes all pass (what the CLI checks).
    const v = verifyAuditRecord(rec, {
      verifySignature: makeEd25519SignatureVerifier(pub),
    })
    expect(v.verified).toBe(true)
  })

  it("leaves records UNSIGNED when no signer is configured", async () => {
    let captured: AuditRecord | undefined
    __setAuditSinkDependencies(makeDeps((r) => (captured = r)))
    __setAuditSigner(undefined)

    await getAuditSink().emit(realAuditRecord())
    expect(captured).toBeDefined()
    expect(captured!.signature).toBeUndefined()
  })

  it("fails CLOSED: a throwing signer propagates out of emit (not swallowed by the fail-open sink)", async () => {
    __setAuditSinkDependencies(makeDeps(() => {}))
    __setAuditSigner({
      keyId: "boom",
      sign() {
        throw new Error("signer exploded")
      },
    })

    await expect(getAuditSink().emit(realAuditRecord())).rejects.toThrow(
      /signer exploded/,
    )
  })
})
