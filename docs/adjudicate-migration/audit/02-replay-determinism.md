> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover replay-byte-determinism audit (2026-05-23). Informed the redactor-hash decision (Option A) and nonce policy; outstanding nonce-source issues are tracked in `../audit-2026-05-24/CLOSEOUT-STATUS.md`. Content preserved unchanged below as historical record.

---

# Replay Determinism Audit

> Audit pass over every `buildEnvelope` call site, the audit pipeline, and the DEFER park/resume round-trip, against CLAUDE.md rule #9 ("the LLM is a semantic parser with zero state-mutation authority"). Investigates whether re-running an adjudicated decision produces byte-identical `intentHash`.

## Executive summary

The hash machinery in `@adjudicate/core` is sound: `buildEnvelope` deterministically derives `intentHash` from `(version, kind, payload, nonce, actor, taint)` via canonical JSON + SHA-256 (`packages/core/src/envelope.ts`, `packages/core/src/hash.ts`). Key-order, omitted-undefined, and golden-vector tests all live in core and pass. The v2 design correctly excluded `createdAt` from the hash input so retries don't drift.

However, **at the IbateXas call-site layer, replay determinism is partially broken**. Three concrete defects:

1. **Customer-facing user envelopes use `randomUUID()` as nonce on every call** — no retry-stable idempotency key is plumbed at the route level for `order.cancel`, `order.amend.request`, `order.checkout.create`, `customer.anonymize`, `customer.anonymize.cancel`. A second click within the dedup window produces a different `intentHash`, defeating ledger dedup.
2. **DEFER park blobs from `llm-responder.ts` and `me.ts` are written raw** (not via `parkDeferredIntent` from `@adjudicate/runtime`), missing the top-level `actorPrincipal` field that `verifyParkedEnvelopeHash` checks. Every resume falls through to "legacy/unverified" mode — tamper-at-rest detection is structurally inert.
3. **The defer-resolver re-adjudicate audit record does NOT carry a `supersedes` link** despite the docstring saying it does (`apps/api/src/subscribers/defer-resolver.ts:370-374`). The supersession chain is unwired (F2/task 02 deviation, now confirmed in code).

Two further structural concerns:

- **Postgres `ON CONFLICT (intent_hash, recorded_at)` doesn't match the actual schema PK `(id, recorded_at)`** — no unique constraint exists on `(intent_hash, recorded_at)`, so the SQL will throw on Postgres rather than dedup. ([`packages/llm-provider/src/postgres-audit-writer.ts:68`](#) vs `migrations/001-create-intent-audit.sql:29`).
- **`AuditRedactor` preserves `auditHash` verbatim**, but the redacted record now has a mutated envelope.payload. `verifyAuditRecord` reading from durable storage will derive a different hash and report `tampered` — a tamper-detection vs PII-redaction conflict.

Verdict: **replay is NOT byte-deterministic today**. The framework primitives are correct; the IbateXas adoption is partial.

## Nonce inventory

20+ `buildEnvelope` call sites across `apps/api/src` and `packages/`. Inventory grouped by nonce-source class:

| Call site | Nonce source | Deterministic across retries? | Risk |
|-----------|--------------|-------------------------------|------|
| `apps/api/src/routes/stripe-webhook.ts:98` | `event.id` (Stripe event ID) | YES — Stripe re-delivers same ID on failed ACK | Low. Optimal. |
| `apps/api/src/subscribers/__shared__/system-actor-envelope.ts:97` | `args.eventId` (caller-supplied) | YES if caller passes stable ID | Low when callers comply (NATS event id / job tick id). High if a caller passes `randomUUID()`. |
| `apps/api/src/routes/admin/orders.ts:331` | `requestId ?? randomUUID()` | Conditional — depends on header `Idempotency-Key` | Medium. Most clients won't send the header. |
| `apps/api/src/routes/admin/order-actions.ts:600` (waive confirm) | `pending.nonce` (replayed from confirmation receipt) | YES — pinned at step-1, replayed at step-2 | Low. Two-step confirmation flow done right. |
| `apps/api/src/routes/admin/order-actions.ts:263` (force-cancel confirm) | `pending.nonce` | YES | Low. |
| `apps/api/src/routes/admin/payments.ts:715` (force-status confirm) | `pending.nonce` | YES | Low. |
| `apps/api/src/routes/admin/payments.ts:232` (refund) | `args.nonce` (caller-passed `randomUUID()` from caller scope) | NO — caller passes fresh UUID each refund attempt | Medium. Refund retries don't dedup at envelope layer; Stripe ledger covers it. |
| `apps/api/src/routes/admin/payments.ts:157` (cash confirm) | `randomUUID()` | NO | Medium. Double-clicking the "confirm cash" button produces two envelopes. |
| `apps/api/src/routes/admin/order-actions.ts:409` (advance) | `randomUUID()` | NO | Medium. |
| `apps/api/src/routes/admin/order-actions.ts:316` (paymentEnvelope inside cancel-confirm) | `randomUUID()` | NO | Medium. Cascade envelope under a deterministic parent — should derive from the parent nonce. |
| `apps/api/src/routes/admin/reservations.ts:177,223,...` (check-in / complete / cancel) | `randomUUID()` | NO | Medium. No idempotency surface on admin reservation routes. |
| `apps/api/src/routes/order-actions.ts:231` (customer order.cancel) | `randomUUID()` | NO | **High**. Customer-facing; users retry on transient network errors. |
| `apps/api/src/routes/order-actions.ts:517` (customer order.amend.request) | `randomUUID()` | NO | **High**. |
| `apps/api/src/routes/cart.ts:614` (customer order.checkout.create) | `randomUUID()` | NO | **High**. Checkout double-submit produces 2 envelopes that the kernel must REFUSE / DEFER independently. |
| `apps/api/src/routes/me.ts:278` (customer.anonymize) | `randomUUID()` | NO | High. Retry within the OTP window won't dedup at the envelope layer. The route guards via `existing` pending-receipt check, but that's a defensive layer outside the kernel. |
| `apps/api/src/routes/me.ts:422` (customer.anonymize.cancel) | `randomUUID()` | NO | Medium. |
| `packages/tools/src/cart/add-order-note.ts:91` | `randomUUID()` | NO | Medium. LLM-driven; retries replay tool call but build a fresh envelope. |
| `packages/tools/src/cart/change-delivery-address.ts:87` | `randomUUID()` | NO | Medium. |
| `packages/tools/src/cart/switch-order-type.ts:97` | `randomUUID()` | NO | Medium. |
| `packages/tools/src/medusa/adjudicated.ts:499` | `idempotencyKey ?? randomUUID()` | YES when caller supplies key | Low if caller threads through; medium otherwise. |
| `packages/llm-provider/src/tool-registry.ts:396` | `randomUUID()` | NO | High for LLM-proposed mutations. Retry of the same conversational turn produces a new envelope on every retry. |
| `packages/llm-provider/src/llm-responder.ts:792, 825` (validation.text.rewrite/refuse synthesised audit) | `randomUUID()` | NO (intentional — never retried) | Low. These are post-hoc audit captures, not idempotent mutations. |
| `packages/llm-provider/src/kernel-executor-envelopes.ts:142` (KernelAddItem/Checkout/Cancel/PixRegenerate) | `randomUUID()` | NO | Medium. XState kernel doesn't thread idempotency keys today (explicit TODO in the file comment). |
| `packages/pack-whatsapp/src/policies.ts:286` (sanitize REWRITE) | `envelope.nonce` (preserved from caller) | YES | Low. REWRITE correctly preserves parent nonce. |

Tally:
- **Deterministic nonces:** 4 sites (Stripe webhook, system-actor with stable event id, two-step confirmation flows on `pending.nonce`, REWRITE preservation in pack-whatsapp).
- **Conditionally deterministic (depends on caller plumbing):** 3 sites (admin `Idempotency-Key` header, medusa wrapper, system-actor envelope).
- **Non-deterministic (`randomUUID()` per call):** 13+ sites including ALL customer-facing routes and ALL LLM-tool-proposed paths.

## Hash-preserving paths verified

| Path | Verified by | Status |
|------|-------------|--------|
| `buildEnvelope` canonical-JSON hash determinism | `packages/core/tests/hash-determinism.test.ts`, `hash-golden-vectors.test.ts`, `cross-runtime-hash-vectors.test.ts` | PASS in core; golden vectors locked. |
| `redact(record).intentHash === record.intentHash` | `packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts:683-690` | PASS — explicit contract test. |
| `redact(record).envelope.{actor,taint,kind,nonce,createdAt,version}` preserved | Same contract test, line 693-704 | PASS. |
| Idempotency `redact(redact(record)) === redact(record)` | Same contract test, line 707-714 | PASS. |
| REWRITE preserves nonce (pack-whatsapp sanitize) | `packages/pack-whatsapp/src/policies.ts:286-293` carries `nonce: envelope.nonce, createdAt: envelope.createdAt` | Visual inspection confirms; conformance test in pack covers. |
| Multi-sink fan-out (`persistentBufferedSink` → console + NATS + Postgres) preserves the AuditRecord shape | `packages/llm-provider/src/intent-audit-wiring.ts:281-294` — `_sink.emit` calls `redact` once then forwards | PASS. The spill list holds redacted records (invariant #1: never raw PII in Redis spill). |
| `replayEnvelopeFromAudit(record).intentHash === record.intentHash` | `packages/core/src/audit.ts:264-278` re-passes `(kind, payload, actor, taint, nonce, createdAt)` to `buildEnvelope`; depends on the v2 invariant that `createdAt` is NOT in the hash | PASS by construction. |

## Hash-preserving paths NOT verified / broken

1. **`auditHash` vs redactor conflict** — `buildAuditRecord` computes `auditHash = sha256Canonical(baseRecord)` where `baseRecord` includes the *unredacted* envelope. The redactor preserves `auditHash` verbatim while mutating envelope.payload. `verifyAuditRecord` reading a durable record (e.g. from Postgres) re-derives `sha256Canonical(record minus {auditHash, signature})` against the redacted envelope — gets a different hash — and returns `{ verified: false, reason: "tampered" }`. The two contracts (tamper-evidence + PII-redaction) are not aligned. See `packages/core/src/audit.ts:235-249` and `packages/llm-provider/src/audit-redactor.ts:313-356`.

2. **Postgres ON CONFLICT clause references a non-existent unique constraint.** The SQL (`packages/llm-provider/src/postgres-audit-writer.ts:68`) is `ON CONFLICT (intent_hash, recorded_at) DO NOTHING`, but the table PK is `(id, recorded_at)` where `id` is `BIGSERIAL` (`@adjudicate/audit-postgres/migrations/001-create-intent-audit.sql:29`). No `UNIQUE (intent_hash, recorded_at)` index exists across migrations 001-008. Postgres rejects `ON CONFLICT` against arbitrary column tuples — needs a unique constraint or index. So either (a) the INSERT throws and the audit-consumer DLQs every record, or (b) it works because the runtime auto-promotes the column list when no constraint matches (it doesn't — this is a `42P10 invalid_column_reference` error). Today the flag `IBX_AUDIT_POSTGRES_ENABLED` is off by default; this latent defect would surface the moment the flag flips.

## DEFER round-trip determinism

The DEFER park/resume cycle is governed by two paths:

1. **Park** — `apps/api/src/routes/me.ts:313-321` and `packages/llm-provider/src/llm-responder.ts:498-506` write `JSON.stringify({envelope, signal, parkedAt})` directly to `rk("defer:pending:<sessionId>")`. They do NOT use `parkDeferredIntent` from `@adjudicate/runtime`.
2. **Resume** — `apps/api/src/subscribers/defer-resolver.ts:228-451` reads the parked blob, calls `verifyParkedEnvelopeHash`, calls `resumeDeferredIntent` (runtime), re-derives state, re-calls `adjudicate(envelope, state, policy)`.

The envelope blob IS the full envelope (not a derived form) — that part is correct. `resumeDeferredIntent` returns `parked.envelope` unchanged; `defer-resolver.ts:345` then passes it to `adjudicate()`, so the second invocation sees the *exact* same envelope object with the *exact* same `intentHash`. Round-trip is byte-identical in principle.

**But the verification layer is structurally inert.** `verifyParkedEnvelopeHash` expects `parked.envelope.actorPrincipal` at the top level (`packages/runtime/src/defer-resume.ts:74`). The IbateXas park sites serialize the canonical `IntentEnvelope` which carries `actor.principal` (nested), not `actorPrincipal` (top-level). The verifier therefore always returns `{ verified: null, reason: "missing_fields" }` for IbateXas's parked blobs. `defer-resolver.ts:302` interprets `null` as "legacy v0.1 blob — log warn and proceed" (and `verifyMode` defaults to `"warn"`, not `"strict"`). Net effect: **tamper-at-rest detection is silently disabled** for every parked envelope written by IbateXas.

Workaround: `@adjudicate/adapter-core/src/decisions.ts:163-176` shows the correct shape — it explicitly spreads `actorPrincipal: ctx.envelope.actor.principal` and `taint: ctx.envelope.taint` alongside the envelope. IbateXas's two raw-park sites need to do the same.

Idempotency of resume itself (the `defer:resumed:*` SETNX ledger) is well-formed: `runtime/src/defer-resume.ts:259` uses `deferResumeHash(intentHash, signal)` as the key suffix — that's `sha256(intentHash + ":" + signal)`. Both the original intentHash AND the resume-event identifier are in the key. Duplicate webhook deliveries return `duplicate_resume_suppressed`. The cycle cap (`defer:cycle:<intentHash>`) is keyed by intentHash alone — defaults to 3 cycles before refusing.

Per-session quota (`defer:count:<sessionId>`) lives in the runtime via `parkDeferredIntent` — but since IbateXas doesn't call `parkDeferredIntent`, **the quota is also unenforced**. A misbehaving sessionId can grow `defer:pending:<sessionId>` blobs unboundedly (well, bounded only by Redis memory and the 14d TTL).

## Supersession chain status

**Unwired.** `apps/api/src/subscribers/defer-resolver.ts:370-374` emits:

```ts
const record = buildAuditRecord({
  envelope,
  decision,
  durationMs: Date.now() - startedAt,
})
```

No `supersedes` field. The docstring at line 20-21 of the same file explicitly promises "audit record is emitted with `supersedes` linking the resume back to the original park". The audit type supports it (`@adjudicate/core/src/audit.ts:138-152` has `Supersession` and `supersedes` field with reason codes including `"defer_resumed"`). The buildAuditRecord function passes through `supersedes` when provided (`audit.ts:193`). It's a one-line wire-up:

```ts
supersedes: {
  predecessorIntentHash: intentHash,
  predecessorAt: parked.parkedAt,
  reason: "defer_resumed",
}
```

Per the task brief: "task 02 deviation left it unwired" — confirmed in code. Replay reports today can NOT walk a resume chain back to the original park record.

The `kernelIdentity`, `policyVersion`, `kernelVersion` fields on `BuildAuditInput` are likewise never threaded through any IbateXas call site. `grep` confirms zero hits in `apps/` or `packages/` for `kernelIdentity:`, `policyVersion:`, `kernelVersion:` in calls to `buildAuditRecord` outside of test fixtures.

## JSON-order / serialization stability

`sha256Canonical` (in `packages/core/src/hash.ts`) sorts object keys recursively (`canonicalize` function) before stringifying. Confirmed by:

- `packages/core/tests/hash-determinism.test.ts:7-11` — `{kind, payload, taint}` and `{taint, payload, kind}` produce identical canonical JSON.
- `packages/core/tests/hash-golden-vectors.test.ts` — locked golden vectors prevent regression.
- `packages/core/tests/cross-runtime-hash-vectors.test.ts` — Rust/Go/Python compatibility.
- The spec is normatively documented at `docs/specs/canonical-json-hash.md` (referenced in `envelope.ts:26`).

Undefined fields are omitted (`canonicalize` filters via `.filter(([, v]) => v !== undefined)`), so `{a: 1, b: undefined}` and `{a: 1}` hash identically.

`null` is normalized: `if (value === null || value === undefined) return null` (`hash.ts:29`). One subtle consequence: explicit `null` and missing-key hash the same — if a payload field changes from `undefined` to `null` between attempts, hash is stable; but it also means a payload that uses `null` semantically can't be distinguished from one with the field absent. Not a defect, just a property worth knowing for replay-debug scenarios.

Arrays are NOT sorted (`return value.map(canonicalize)` preserves order). Any place a payload constructs an array from a `Set` iteration or `Object.keys()`-then-`.map()` could yield platform-dependent ordering. Spot-check of allergens (`CLAUDE.md` rule #1) and `decision_basis` arrays: both are built deterministically by code paths I traced — allergens come from explicit-array passes through the catalog layer, decision_basis from guard chains in pack-orders / pack-whatsapp policies. No obvious ordering hazards in payloads, but no proactive contract test enforces "all envelope payload arrays are deterministically ordered".

## Replay CLI assessment

Two layers:

1. **`adjudicate replay` (platform repo)** — `packages/cli/src/commands/replay.ts`. Reads JSON/JSONL audit records, calls `replayEnvelopeFromAudit` to reconstruct the envelope, calls `adjudicate(envelope, syntheticState, pack.policy)`, compares decision via `classify(...)`. Known limitation explicit in source (line 91-95): "AuditRecord doesn't carry the state at the time of adjudication. We synthesize an empty state". This makes the CLI useful for *policy drift* detection (did the basis codes change?) but NOT for full replay — most decisions depend on state, not just envelope.

2. **`ibx kernel replay` (this repo)** — `packages/cli/src/commands/kernel.ts:185-325`. Today this is a **stub**: it reads audit records from Postgres via `readAuditWindow`, prints a count and per-kind summary, but does NOT re-feed records through `adjudicate()`. The explicit TODO on line 298 says "re-feed records through adjudicate() with the matching policy bundle, then call replayWithIntegrity + explainReplayReport" — deferred to a follow-up task. Per the docstring at line 9 the command's purpose is "re-feed audit records from Postgres" but the implementation only summarises.

So today: a replay against historical audit records cannot diverge from the original because no re-adjudication happens. When the TODO lands, the CLI inherits the platform-CLI's "synthetic empty state" limitation unless IbateXas wires a state-reconstruction primitive per intent kind.

Code-drift risk: `replayEnvelopeFromAudit` reconstructs the envelope from the *stored* envelope.payload + nonce + createdAt + actor + taint. So even if payload-building code drifts in routes (e.g. someone adds a new field to `OrderCancelPayload`), the replay re-derives the original payload from the stored audit record, not from current code. **Replay envelope reconstruction is stable against code drift in payload-building.** What it is NOT stable against is **policy-bundle drift** (Pack guard logic) — by design, that's what the replay tool is supposed to detect.

## Findings ranked

### F1 — High: User-facing routes use `randomUUID()` per-call as nonce
**Impact:** Customer cart-checkout, order-cancel, order-amend, anonymize, anonymize-cancel — all generate a fresh `intentHash` on every retry. Network blip + user resubmit produces two distinct envelopes the kernel will re-decide independently. `IBX_LEDGER_ENABLED` dedup cannot collapse them.
**Files:** `apps/api/src/routes/cart.ts:614`, `apps/api/src/routes/order-actions.ts:231,517`, `apps/api/src/routes/me.ts:278,422`.
**Fix:** Plumb a client-supplied `Idempotency-Key` header or derive nonce from `(customerId, action, version)` tuple. Pattern already exists for admin two-step confirmations.

### F2 — High: DEFER park sites bypass `parkDeferredIntent`
**Impact:** Two side-effects compounded:
- `verifyParkedEnvelopeHash` returns `missing_fields` for every parked blob → tamper-at-rest detection inert.
- `parkDeferredIntent`'s quota check is bypassed → no per-session park limit.
**Files:** `packages/llm-provider/src/llm-responder.ts:498-506`, `apps/api/src/routes/me.ts:313-321`.
**Fix:** Route through `parkDeferredIntent` from `@adjudicate/runtime`, spreading the explicit verification fields per `@adjudicate/adapter-core/src/decisions.ts:163-176`.

### F3 — High: `supersedes` chain unwired on DEFER resume
**Impact:** Resume audit records don't reference the parked record. Operators replaying a chain cannot answer "what was the original park?" without joining on `actor.sessionId`. Violates the v3 audit record contract documented at `packages/core/src/audit.ts:42-58`.
**Files:** `apps/api/src/subscribers/defer-resolver.ts:370-374` (buildAuditRecord call missing `supersedes` field). Same gap exists for `confirmation_resolved`, `rewrite_executed`, `replay` reason codes — no call site sets `supersedes` anywhere in `apps/`.
**Fix:** Add `supersedes: { predecessorIntentHash: intentHash, predecessorAt: parked.parkedAt, reason: "defer_resumed" }` to the resume audit emit.

### F4 — High: Postgres ON CONFLICT references non-existent unique constraint
**Impact:** When `IBX_AUDIT_POSTGRES_ENABLED=true` flips, every audit INSERT throws `42P10` and the buffered sink retry-spills indefinitely. Postgres audit sink will be 0% effective.
**Files:** `packages/llm-provider/src/postgres-audit-writer.ts:68` SQL vs `@adjudicate/audit-postgres/migrations/001-create-intent-audit.sql:29` PK.
**Fix:** Add a unique index/constraint on `(intent_hash, recorded_at)` in a new migration, OR change `ON CONFLICT` to `ON CONFLICT DO NOTHING` (no column list — only works if no INSERT can produce a logical duplicate).

### F5 — Medium: AuditHash vs redactor conflict (tamper-detection broken on redacted records)
**Impact:** Records that round-trip through the redactor (i.e., ALL records emitted via `getAuditSink()`) will fail `verifyAuditRecord` for every reader. Tamper-evidence at the audit-record level is structurally broken in IbateXas.
**Files:** `packages/llm-provider/src/audit-redactor.ts:313-356` mutates payload while preserving `auditHash`; `packages/core/src/audit.ts:235-249` recomputes against the mutated payload.
**Fix options:** (a) recompute `auditHash` over the redacted record (defeats the tamper-detection from `buildAuditRecord`); (b) keep `auditHash` over unredacted but expose a separate `redactedAuditHash` for downstream re-verification; (c) document that `verifyAuditRecord` is only meaningful pre-redaction (i.e., in the in-process sink, not downstream).

### F6 — Medium: System-actor envelopes with un-stable upstream IDs
**Impact:** The `buildSystemEnvelope` helper requires callers to pass a stable `eventId`. If a caller passes `randomUUID()` instead, the determinism contract silently breaks at the call site — no type-system signal.
**Files:** `apps/api/src/subscribers/__shared__/system-actor-envelope.ts:51-53` (contract) and every caller of `buildSystemEnvelope`.
**Fix:** Audit each `buildSystemEnvelope` call site (would be a separate task) to confirm `eventId` is upstream-derived. Consider renaming the parameter to `upstreamEventId` to make the contract more visible.

### F7 — Low: XState kernel-executor envelopes never carry idempotency keys
**Impact:** `kernel-executor-envelopes.ts` builds `randomUUID()` nonces for `order.cart.add`, `order.checkout.create`, `order.cancel`, `order.pix.regenerate`. The file's own comment (line 40-44) acknowledges this: "When the kernel needs idempotent retries it should thread its own nonce through ctx; for now first-attempt-only semantics match the legacy direct-call behaviour."
**Files:** `packages/llm-provider/src/kernel-executor-envelopes.ts:142`.
**Fix:** Thread an idempotency key through XState context. Lower urgency because the XState kernel doesn't retry by itself — retries originate from the LLM-proposed path which has its own (currently also non-deterministic, see F1) nonce.

### F8 — Low: Cascade envelopes don't derive nonce from parent
**Impact:** In `apps/api/src/routes/admin/order-actions.ts:313-319`, a force-cancel produces an `order.status.transition` envelope keyed by `pending.nonce` (deterministic) AND a cascade `payment.status.transition` envelope keyed by `randomUUID()` (non-deterministic). Replaying the parent doesn't replay the child.
**Files:** `apps/api/src/routes/admin/order-actions.ts:316`.
**Fix:** Derive child nonce as `sha256(parent.nonce + ':payment')` or similar.

---

## Top 3 replay-divergence risks

1. **Customer routes use `randomUUID()` per call** — `apps/api/src/routes/cart.ts:614` (checkout double-submit), `apps/api/src/routes/order-actions.ts:231` (order cancel). Scenario: customer taps "Confirmar" twice; envelope A and envelope B have different `intentHash`; the kernel runs the policy twice; ledger dedup at the audit layer cannot collapse them; second mutation either races or duplicates.
2. **DEFER park blobs are unverifiable** — `packages/llm-provider/src/llm-responder.ts:498`, `apps/api/src/routes/me.ts:313`. Scenario: an operator with Redis write access mutates a parked envelope between park and resume; on resume, `verifyParkedEnvelopeHash` returns `missing_fields` (because the IbateXas blob lacks the top-level `actorPrincipal` field), so the tamper-detection branch never fires — the mutated envelope is re-adjudicated as if intact.
3. **Resume audit records have no supersession link** — `apps/api/src/subscribers/defer-resolver.ts:370`. Scenario: replay tool walks an audit chain backwards from a recent EXECUTE; the predecessor (the parked DEFER) is invisible because no `supersedes` edge exists; replay reports a "fresh" EXECUTE rather than a chained resume.

## Verdict

**Replay is NOT byte-replayable today.**

The cryptographic primitives are correct: `buildEnvelope` is deterministic in core, the canonical JSON encoder is sound, the v2 envelope spec correctly excludes `createdAt` from the hash, and the audit-redactor's contract tests assert `intentHash` preservation. So the foundation is intact.

But the adopter-layer breaks the replay invariant in at least three load-bearing ways: customer-facing routes use fresh `randomUUID()` nonces every call, DEFER park blobs miss the explicit verification fields, and the supersession chain that should let a replay walk from resume back to park is unwired. Until F1, F2, and F3 are addressed, "replay an audit record and reproduce the same decision" works only for the subset of envelopes whose first attempt was their only attempt — i.e., absent retries, DEFER resumes, or two-step confirmation flows. F4 latently blocks Postgres audit persistence the moment the flag flips; F5 means tamper-detection at the audit-record level is structurally inert downstream of `getAuditSink()`.
