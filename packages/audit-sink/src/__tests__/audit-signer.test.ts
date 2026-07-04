// audit-signer.test.ts — AUT-025 unit coverage for the ed25519 signer,
// verifier, key parsing, and the fail-closed boot resolver.

import { afterEach, describe, expect, it, vi } from "vitest"
import { generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto"
import {
  auditSignaturePreimage,
  buildAuditRecord,
  buildEnvelope,
  verifyAuditRecord,
  type AuditRecord,
} from "@adjudicate/core"
import {
  AUDIT_ED25519_ALG,
  attachAuditSignature,
  buildEd25519AuditSigner,
  makeEd25519SignatureVerifier,
  parseEd25519PrivateKey,
  parseEd25519PublicKey,
  resolveAuditSignerFromEnv,
  __resetAuditSigner,
} from "../audit-signer.js"

// ── Fixtures ─────────────────────────────────────────────────────────────

function keypair(): { priv: KeyObject; pub: KeyObject; privB64: string; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    priv: privateKey,
    pub: publicKey,
    privB64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pubB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  }
}

function fakeRecord(overrides?: Partial<AuditRecord>): AuditRecord {
  return {
    at: new Date().toISOString(),
    auditHash: "sha256:deadbeef",
    durationMs: 1,
    intentHash: "intent-hash",
    decision: { kind: "EXECUTE", basis: [] },
    envelope: {
      kind: "order.cart.ensure",
      payload: { cartId: "c1" },
      actor: { principal: "system", sessionId: "test:s" },
      taint: "SYSTEM",
      nonce: "n",
      createdAt: new Date().toISOString(),
      version: 4,
      intentHash: "intent-hash",
    },
    version: 4,
    ...overrides,
  } as unknown as AuditRecord
}

const silentLog = { warn: vi.fn(), info: vi.fn() }

afterEach(() => {
  __resetAuditSigner()
  vi.clearAllMocks()
})

// ── Sign / verify roundtrip ────────────────────────────────────────────────

describe("buildEd25519AuditSigner + makeEd25519SignatureVerifier", () => {
  it("round-trips a signature over auditSignaturePreimage(auditHash, keyId)", () => {
    const { priv, pub } = keypair()
    const signer = buildEd25519AuditSigner(priv, "k1")
    const verify = makeEd25519SignatureVerifier(pub)

    const sig = signer.sign("sha256:abc")
    expect(sig.keyId).toBe("k1")
    expect(sig.alg).toBe(AUDIT_ED25519_ALG)
    expect(typeof sig.value).toBe("string")
    expect(verify("sha256:abc", sig)).toBe(true)
  })

  it("threads keyId into the signature and binds it into the pre-image", () => {
    const { priv, pub } = keypair()
    const signer = buildEd25519AuditSigner(priv, "key-A")
    const verify = makeEd25519SignatureVerifier(pub)
    const sig = signer.sign("sha256:abc")

    // Same bytes, but presented under a different keyId → pre-image differs → invalid.
    expect(verify("sha256:abc", { ...sig, keyId: "key-B" })).toBe(false)
    // Sanity: the pre-image genuinely depends on keyId.
    expect(auditSignaturePreimage("sha256:abc", "key-A")).not.toBe(
      auditSignaturePreimage("sha256:abc", "key-B"),
    )
  })

  it("rejects a tampered auditHash, wrong alg, and wrong key", () => {
    const a = keypair()
    const b = keypair()
    const signer = buildEd25519AuditSigner(a.priv, "k1")
    const verifyA = makeEd25519SignatureVerifier(a.pub)
    const verifyB = makeEd25519SignatureVerifier(b.pub)
    const sig = signer.sign("sha256:abc")

    expect(verifyA("sha256:XXX", sig)).toBe(false) // tampered hash
    expect(verifyA("sha256:abc", { ...sig, alg: "sha256-hashbind" })).toBe(false) // wrong alg
    expect(verifyA("sha256:abc", { ...sig, value: "not-base64!!" })).toBe(false) // malformed value never throws
    expect(verifyB("sha256:abc", sig)).toBe(false) // wrong key
  })
})

// ── attachAuditSignature ───────────────────────────────────────────────────

describe("attachAuditSignature", () => {
  it("attaches a verifiable signature over the record's auditHash", () => {
    const { priv, pub } = keypair()
    const signer = buildEd25519AuditSigner(priv, "k1")
    const signed = attachAuditSignature(fakeRecord({ auditHash: "sha256:h1" }), signer)
    expect(signed.signature).toBeDefined()
    expect(makeEd25519SignatureVerifier(pub)("sha256:h1", signed.signature!)).toBe(true)
  })

  it("is a no-op for a record already carrying a signature", () => {
    const { priv } = keypair()
    const signer = buildEd25519AuditSigner(priv, "k1")
    const pre = fakeRecord({
      signature: { keyId: "old", alg: "ed25519", value: "AAAA" },
    })
    expect(attachAuditSignature(pre, signer)).toBe(pre)
  })

  it("is a no-op for a record with no auditHash (pre-v4)", () => {
    const { priv } = keypair()
    const signer = buildEd25519AuditSigner(priv, "k1")
    const pre = fakeRecord({ auditHash: undefined })
    expect(attachAuditSignature(pre, signer).signature).toBeUndefined()
  })
})

// ── Key parsing (base64 DER + PEM) ─────────────────────────────────────────

describe("key parsing", () => {
  it("parses base64 PKCS8 DER and base64 SPKI DER", () => {
    const { privB64, pubB64 } = keypair()
    expect(parseEd25519PrivateKey(privB64).asymmetricKeyType).toBe("ed25519")
    expect(parseEd25519PublicKey(pubB64).asymmetricKeyType).toBe("ed25519")
  })

  it("parses PEM (including \\n-escaped single-line)", () => {
    const { priv } = keypair()
    const pem = priv.export({ format: "pem", type: "pkcs8" }) as string
    expect(parseEd25519PrivateKey(pem).asymmetricKeyType).toBe("ed25519")
    expect(parseEd25519PrivateKey(pem.replace(/\n/g, "\\n")).asymmetricKeyType).toBe("ed25519")
  })

  it("rejects a non-ed25519 key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const rsaB64 = rsa.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    expect(() => parseEd25519PrivateKey(rsaB64)).toThrow(/not an ed25519/)
  })
})

// ── resolveAuditSignerFromEnv — the fail-closed boot resolver ───────────────

describe("resolveAuditSignerFromEnv", () => {
  it("returns a working signer for a valid key + self-test passes", () => {
    const { privB64, pub } = keypair()
    const signer = resolveAuditSignerFromEnv({
      nodeEnv: "production",
      privateKey: privB64,
      keyId: "k1",
      log: silentLog,
    })
    expect(signer).toBeDefined()
    const sig = signer!.sign("sha256:zzz")
    expect(makeEd25519SignatureVerifier(pub)("sha256:zzz", sig)).toBe(true)
    expect(silentLog.info).toHaveBeenCalled()
  })

  it("THROWS at boot in production when the key is absent", () => {
    expect(() =>
      resolveAuditSignerFromEnv({
        nodeEnv: "production",
        privateKey: undefined,
        keyId: undefined,
        log: silentLog,
      }),
    ).toThrow(/must be set in production/)
  })

  it("THROWS at boot in production when the keyId is absent (partial config)", () => {
    const { privB64 } = keypair()
    expect(() =>
      resolveAuditSignerFromEnv({
        nodeEnv: "production",
        privateKey: privB64,
        keyId: undefined,
        log: silentLog,
      }),
    ).toThrow(/must be set in production/)
  })

  it("THROWS (any env) when a key is PRESENT but invalid — a bad key fails boot", () => {
    expect(() =>
      resolveAuditSignerFromEnv({
        nodeEnv: "development",
        privateKey: "not-a-real-key",
        keyId: "k1",
        log: silentLog,
      }),
    ).toThrow(/FAILED the boot self-test/)
  })

  it("dev + absent key → undefined + a one-shot WARN", () => {
    const first = resolveAuditSignerFromEnv({
      nodeEnv: "development",
      privateKey: undefined,
      keyId: undefined,
      log: silentLog,
    })
    const second = resolveAuditSignerFromEnv({
      nodeEnv: undefined,
      privateKey: "",
      keyId: "",
      log: silentLog,
    })
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    // One-shot: the WARN fires once across calls (until __resetAuditSigner).
    expect(silentLog.warn).toHaveBeenCalledTimes(1)
  })
})

// ── End-to-end: a signed record verifies via verifyAuditRecord's hook ───────
//
// Uses REAL records (buildEnvelope → buildAuditRecord) so BOTH the envelope
// self-consistency axis and the auditHash axis pass — isolating the signature
// axis, which is what AUT-025 adds.

function realRecord(): AuditRecord {
  const envelope = buildEnvelope({
    kind: "order.cart.ensure",
    payload: { cartId: "cart_1" },
    actor: { principal: "system", sessionId: "system:job" },
    taint: "SYSTEM",
    nonce: "nonce-1",
  })
  return buildAuditRecord({
    envelope,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
  })
}

describe("verifyAuditRecord integration", () => {
  it("verified:true when signed and the ed25519 hook is supplied", () => {
    const { priv, pub } = keypair()
    const signed = attachAuditSignature(realRecord(), buildEd25519AuditSigner(priv, "k1"))
    const v = verifyAuditRecord(signed, {
      verifySignature: makeEd25519SignatureVerifier(pub),
    })
    expect(v.verified).toBe(true)
  })

  it("verified:false invalid_signature when the signature is forged", () => {
    const { pub } = keypair()
    const other = keypair()
    // Sign with a DIFFERENT key than the verifier holds.
    const signed = attachAuditSignature(realRecord(), buildEd25519AuditSigner(other.priv, "k1"))
    const v = verifyAuditRecord(signed, {
      verifySignature: makeEd25519SignatureVerifier(pub),
    })
    expect(v.verified).toBe(false)
    if (v.verified === false) expect(v.reason).toBe("invalid_signature")
  })
})
