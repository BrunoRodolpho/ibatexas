> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover decision note (2026-05-23, Wave 2). The decision (Option A — recompute `auditHash` after redaction) was implemented and remains in effect. This file is preserved as the institutional record of *why* that approach was chosen. For current redactor behaviour, see `packages/llm-provider/src/audit-redactor.ts` and the T3 conformance suite. Content preserved unchanged below as historical record.

---

# P0-15 — Redactor Hash Decision

**Date:** 2026-05-23
**Wave:** 2 (DEFER + replay correctness)
**Files:** `packages/llm-provider/src/audit-redactor.ts`,
`packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts`,
`packages/llm-provider/src/__tests__/audit-redactor.test.ts`

## Problem

The pre-W2 audit redactor mutated `record.envelope.payload` (PII scrub) but
preserved `record.auditHash` verbatim. `auditHash` had been computed by
`buildAuditRecord` over the *unredacted* envelope; once payload was
redacted, the stored hash no longer matched what `sha256Canonical(record \
{auditHash, signature})` re-derives.

Consequence: `verifyAuditRecord` (from `@adjudicate/core/audit.ts:235-249`)
reported `verified: false, reason: "tampered"` for EVERY redacted record
read downstream. Since every record exits `getAuditSink()` in redacted
form (by invariant), tamper-detection at the audit-record level was
**structurally inert** for every reader (NATS subscribers, Postgres
replay, ops dashboards).

## Decision: Option A — recompute `auditHash` after redaction

Two options were on the table per the audit (`02-replay-determinism.md`
§F5):

| Option | What it does | Pros | Cons |
|---|---|---|---|
| **A** | Recompute `auditHash` over the redacted record | `verifyAuditRecord` actually works on downstream records | Loses the unredacted-content tamper guarantee; replay must redact-with-same-config |
| **B** | Add a `redactedAuditHash` field alongside the original `auditHash` | Both unredacted and redacted tamper-evidence available | `redactedAuditHash` is not on the `AuditRecord` shape; no `verifyRedactedAuditRecord` exists in `@adjudicate/core`; downstream sinks would silently drop the field unless every reader is taught to consult it |

**Chosen: Option A.**

### Why not B

Option B requires:

1. Either modifying `AuditRecord` in `@adjudicate/core` (out of scope per
   the W2 brief: "Do NOT touch `@adjudicate/*` source").
2. Or carrying the field as an untyped extra. Even if the in-process redactor
   adds it, the downstream verifier (`verifyAuditRecord`) only checks
   `record.auditHash` — so the extra field doesn't actually solve the
   "downstream readers report tampered" problem unless those readers are
   also patched.
3. The contract for "what does `auditHash` mean?" splits in two: pre-emit
   vs post-emit. Operators reading audit records can't tell which is which
   without out-of-band knowledge. That's a worse failure mode than Option A.

### Trade-offs of Option A

**LOSS — original-content guarantee at the audit-record level.** A downstream
reader can prove the REDACTED payload was unmodified since emit, but
*cannot* prove the original payload was unmodified before redaction (that
information is gone). For non-repudiation of the original record content,
add a signer at the emit boundary — out of scope here.

**GAIN — `verifyAuditRecord` actually works on the records sinks see.** No
more universal false-positive "tampered" reports. Operators can now use
the verifier for legitimate tamper detection downstream.

**REPLAY CONTRACT — redaction config is part of the audit record's identity.**
A replay tool re-deriving `auditHash` against a stored record MUST redact
with the *same configuration* (REDACT/HASH field sets, `INTENT_KIND_FIELD_RULES`,
and `AUDIT_REDACT_SECRET`) to reproduce the stored hash. Operators MUST
snapshot:

- The redactor source at the time of emit (or a config-hash of it)
- The `AUDIT_REDACT_SECRET` value
- The `INTENT_KIND_FIELD_RULES` map at emit time

alongside the audit stream. Without these, replay is non-reproducible.

**FAIL-OPEN STUB — the `{ __redactor_error: true }` fallback also gets a
recomputed hash.** Otherwise the stub records would report `tampered`
forever after fail-open.

**SIGNATURE INVALIDATION — `signature` is dropped on redaction.** A v4
signature is over the original `auditHash`; recomputing the hash
invalidates the signature. If non-repudiation is required, the signer
must re-sign post-redaction (out of scope; signers run as pluggable
adapters and may be added in W4).

## Invariants the redactor still preserves

1. `intentHash` is NEVER recomputed. The redacted record's intentHash
   still equals the originating envelope's intentHash. Ledger dedup
   (`IBX_LEDGER_ENABLED`) and `replayEnvelopeFromAudit` remain correct.
2. `auditHash` is stable across `redact ∘ redact` (idempotent).
3. Envelope `actor`, `taint`, `kind`, `nonce`, `createdAt`, `version`
   are preserved.
4. Top-level decision, decision_basis, at, durationMs, plan, supersedes,
   kernelIdentity, policyVersion, kernelVersion are preserved.

## Tests added

- `audit-redaction-contract.test.ts`:
  - `every fixture recomputes auditHash so verifyAuditRecord works on
    redacted records` — covers the entire 50+ fixture corpus.
  - `redacted auditHash differs from the original auditHash whenever
    payload changed` — proves the recomputation is actually doing work.
- `audit-redactor.test.ts`:
  - `redact(redact(record)) preserves intentHash; auditHash is stable
    post-redaction (P0-15)` — idempotency + stability.

## Open follow-ups (not in scope for W2)

- **Signature re-signing**: when a v4 signature adapter is wired (likely
  W4), it must run *after* the redactor so the signature is over the
  redacted hash. Today no signer is installed, so `signature` is simply
  absent — no field to drop.
- **Replay tool config snapshot**: `ibx kernel replay` (today a stub per
  `02-replay-determinism.md` §"Replay CLI assessment") will need to load
  the redactor config from an alongside artifact when implemented.
