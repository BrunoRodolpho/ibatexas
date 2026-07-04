// audit-signer.ts — AUT-025: production ed25519 audit-record signing.
//
// The kernel (`@adjudicate/core`) exposes a fail-closed `AuditSigner` seam
// (092): `sign(auditHash) → { keyId, alg, value }`, attached to
// `record.signature`, EXCLUDED from the auditHash pre-image. IbateXas ships
// NO signer, so every prod audit row is unsigned (signature_jsonb NULL).
//
// WHERE we sign (load-bearing): the IbateXas audit redactor
// (`audit-redactor.ts`) RECOMPUTES `auditHash` over the redacted record and
// DROPS any pre-existing signature (its own comment: "the signer must re-sign
// post-redaction"). So a signature attached at the kernel `buildAuditRecord`
// call site (deps.signer) would be discarded before persistence. The ONLY
// point at which a signature survives to `intent_audit.signature_jsonb` is
// AFTER redaction — so signing lives at the sink, downstream of
// `redactor.redact()` (see `index.ts:buildSink`). That single seam covers
// EVERY emit path uniformly (the kernel-verb bridge, the `withAdjudicate`
// domain services, subscribers, and jobs all emit through `getAuditSink()`).
//
// WHAT we sign: the kernel's canonical signature pre-image over
// `(auditHash, keyId)` — `auditSignaturePreimage()` from `@adjudicate/core`,
// the SAME pre-image the browser-safe hash-bind leg and
// `@adjudicate/approval-engine`'s ed25519 signer commit to. Binding `keyId`
// means a signature minted under one key id cannot be re-presented under
// another. We do NOT invent a second canonicalization.
//
// Crypto: node:crypto ed25519 ONLY (no new deps).

import {
  auditSignaturePreimage,
  type AuditRecord,
  type AuditSignature,
  type AuditSigner,
} from "@adjudicate/core"
import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto"

/** Algorithm tag recorded into `signature.alg` for the asymmetric leg. */
export const AUDIT_ED25519_ALG = "ed25519" as const

/** A fixed, non-secret digest string used only for the boot self-test. */
const SELF_TEST_AUDIT_HASH = "aut-025-audit-signer-self-test"

// ── Key parsing ────────────────────────────────────────────────────────────
//
// Canonical env format is base64-encoded DER (PKCS8 for the private key, SPKI
// for the public key) — single-line, SSM/.env-friendly. A PEM block (detected
// by "BEGIN") is also accepted for operator convenience.

function looksPem(raw: string): boolean {
  return raw.includes("-----BEGIN")
}

/** Normalize a PEM that may arrive with literal `\n` escapes (env-single-line). */
function normalizePem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw
}

/**
 * Parse an ed25519 PRIVATE key from base64 PKCS8 DER (canonical) or a PEM
 * block. Throws on any malformed / non-ed25519 key so a bad key is caught at
 * boot, never at request time.
 */
export function parseEd25519PrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim()
  const key = looksPem(trimmed)
    ? createPrivateKey({ key: normalizePem(trimmed), format: "pem" })
    : createPrivateKey({
        key: Buffer.from(trimmed, "base64"),
        format: "der",
        type: "pkcs8",
      })
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `AUDIT_SIGNING_PRIVATE_KEY is not an ed25519 key (got ${String(
        key.asymmetricKeyType,
      )})`,
    )
  }
  return key
}

/**
 * Parse an ed25519 PUBLIC key from base64 SPKI DER (canonical) or a PEM block.
 * Used by the verify path (`ibx kernel audit-verify`) where only the public
 * half is available.
 */
export function parseEd25519PublicKey(raw: string): KeyObject {
  const trimmed = raw.trim()
  const key = looksPem(trimmed)
    ? createPublicKey({ key: normalizePem(trimmed), format: "pem" })
    : createPublicKey({
        key: Buffer.from(trimmed, "base64"),
        format: "der",
        type: "spki",
      })
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `ed25519 public key expected (got ${String(key.asymmetricKeyType)})`,
    )
  }
  return key
}

// ── Signer / verifier ──────────────────────────────────────────────────────

/**
 * Construct an ed25519 `AuditSigner` bound to `keyId`. `sign(auditHash)`
 * commits to `auditSignaturePreimage(auditHash, keyId)` and returns the
 * detached signature base64-encoded as `{ keyId, alg: "ed25519", value }`.
 * Deterministic per (key, auditHash) — ed25519 signatures are deterministic —
 * so a signed record stays replayable.
 */
export function buildEd25519AuditSigner(
  privateKey: KeyObject,
  keyId: string,
): AuditSigner {
  return {
    keyId,
    sign(auditHash: string): AuditSignature {
      const preimage = auditSignaturePreimage(auditHash, keyId)
      const signature = cryptoSign(null, Buffer.from(preimage, "utf8"), privateKey)
      return {
        keyId,
        alg: AUDIT_ED25519_ALG,
        value: signature.toString("base64"),
      }
    },
  }
}

/**
 * Build a verifier for the ed25519 leg, shaped for
 * `verifyAuditRecord`'s `verifySignature` hook `(auditHash, signature) =>
 * boolean`. Returns `false` for a non-ed25519 alg, a malformed value, or a
 * signature that does not verify (never throws — a verifier that throws would
 * be indistinguishable from an invalid signature to the caller).
 */
export function makeEd25519SignatureVerifier(
  publicKey: KeyObject,
): (auditHash: string, signature: AuditSignature) => boolean {
  return (auditHash, signature) => {
    if (signature.alg !== AUDIT_ED25519_ALG) return false
    try {
      const preimage = auditSignaturePreimage(auditHash, signature.keyId)
      return cryptoVerify(
        null,
        Buffer.from(preimage, "utf8"),
        publicKey,
        Buffer.from(signature.value, "base64"),
      )
    } catch {
      return false
    }
  }
}

// ── Post-redaction record signing (the sink seam) ───────────────────────────

/**
 * Attach a signature to a record whose `auditHash` is FINAL (i.e. AFTER the
 * redactor recomputed it). A record that already carries a signature or that
 * lacks an `auditHash` (pre-v4) is returned unchanged. A throwing signer
 * propagates — the sink seam relies on that to fail CLOSED (see
 * `index.ts:buildSink`).
 */
export function attachAuditSignature(
  record: AuditRecord,
  signer: AuditSigner,
): AuditRecord {
  if (record.signature) return record
  if (!record.auditHash) return record
  const signature = signer.sign(record.auditHash)
  return { ...record, signature }
}

// ── Boot-time resolution (fail-closed) ──────────────────────────────────────

export interface ResolveAuditSignerInput {
  readonly nodeEnv: string | undefined
  readonly privateKey: string | undefined
  readonly keyId: string | undefined
  readonly log: {
    readonly warn: (obj: Record<string, unknown>, msg: string) => void
    readonly info?: (obj: Record<string, unknown>, msg: string) => void
  }
}

let _devWarnedOnce = false

/**
 * Resolve the process audit signer from env, with a BOOT self-test.
 *
 * Posture (mirrors `assertAuditRedactSecretPosture` / the ADMIN_API_KEYS prod
 * gate):
 *   - production + key absent      → THROW (no unsigned prod rows).
 *   - key present but invalid       → THROW (in ANY env — a broken key is a
 *     config error; running unsigned would mask it). The self-test signs AND
 *     verifies with the DERIVED public key, so a key that cannot round-trip
 *     fails the BOOT, never a per-request EXECUTE (a lazily-discovered bad key
 *     is an outage because the kernel's signer seam is fail-closed).
 *   - dev + key absent              → undefined + one-shot WARN (records stay
 *     unsigned — today's behavior, made explicit).
 */
export function resolveAuditSignerFromEnv(
  input: ResolveAuditSignerInput,
): AuditSigner | undefined {
  const isProd = input.nodeEnv === "production"
  const privateKey = input.privateKey?.trim()
  const keyId = input.keyId?.trim()

  if (!privateKey || !keyId) {
    if (isProd) {
      throw new Error(
        "AUDIT_SIGNING_PRIVATE_KEY and AUDIT_SIGNING_KEY_ID must be set in " +
          "production — audit records are unsigned (non-repudiation gap) without " +
          "them. Generate with: node -e \"const c=require('crypto');const " +
          "{privateKey,publicKey}=c.generateKeyPairSync('ed25519');console.log('PRIV',privateKey" +
          ".export({format:'der',type:'pkcs8'}).toString('base64'));console.log('PUB',publicKey" +
          ".export({format:'der',type:'spki'}).toString('base64'))\"",
      )
    }
    if (!_devWarnedOnce) {
      _devWarnedOnce = true
      input.log.warn(
        { event: "audit_signer.absent" },
        "[audit-signer] AUDIT_SIGNING_PRIVATE_KEY/KEY_ID not set — audit records " +
          "will be UNSIGNED. Acceptable in dev only; production fails closed at boot.",
      )
    }
    return undefined
  }

  let signer: AuditSigner
  try {
    const priv = parseEd25519PrivateKey(privateKey)
    signer = buildEd25519AuditSigner(priv, keyId)
    // Self-test: sign a fixed probe and verify it with the key DERIVED from the
    // private key. A key that cannot round-trip must fail boot here.
    const verify = makeEd25519SignatureVerifier(createPublicKey(priv))
    const probe = signer.sign(SELF_TEST_AUDIT_HASH)
    if (!verify(SELF_TEST_AUDIT_HASH, probe)) {
      throw new Error("self-test sign+verify did not round-trip")
    }
  } catch (err) {
    throw new Error(
      `[audit-signer] signing key FAILED the boot self-test: ${
        (err as Error).message
      }. A bad key must fail boot, never a per-request EXECUTE.`,
    )
  }

  input.log.info?.(
    { event: "audit_signer.ready", keyId, alg: AUDIT_ED25519_ALG },
    "[audit-signer] ed25519 audit-record signing ENABLED",
  )
  return signer
}

// ── Process singleton ───────────────────────────────────────────────────────
//
// Mirrors the `_deps`/`_sink` singleton convention in `index.ts`. Read at
// EMIT time by `buildSink` (not at build time), so boot ordering is tolerant
// and tests can swap the signer between cases without rebuilding the sink.

let _signer: AuditSigner | undefined
let _signerResolved = false

/** Register the process audit signer (or `undefined` for unsigned). */
export function __setAuditSigner(signer: AuditSigner | undefined): void {
  _signer = signer
  _signerResolved = true
}

/** The registered signer, or `undefined` when none is configured. */
export function getAuditSigner(): AuditSigner | undefined {
  return _signer
}

/** @internal — true once `__setAuditSigner` has run (boot completed). */
export function __auditSignerResolved(): boolean {
  return _signerResolved
}

/** @internal — test isolation: clear the singleton + the one-shot dev warn. */
export function __resetAuditSigner(): void {
  _signer = undefined
  _signerResolved = false
  _devWarnedOnce = false
}
