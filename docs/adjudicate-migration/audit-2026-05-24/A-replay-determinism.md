# Replay determinism audit — 2026-05-24

**Branch:** feat/kernel-always-on-cutover @ c5c839c
**Methodology:** adversarial — looking for hash-divergent paths, non-deterministic guards, non-canonical serialization, supersession-chain breaks, and DEFER/resume payload drift.

## TL;DR

- **P0:** 3 findings (idempotency-key foot-gun in 4 just-landed wrappers + the entire ibatexas HTTP-route layer; supersession link silently dropped on every DEFER resume; 4 production callers bypass `parkDeferredIntentWithNxGuard`)
- **P1:** 2 findings (resumed envelope is a stripped `ParkedEnvelope.envelope` cast as full `IntentEnvelope`; `now: new Date()` injected into customer-onboarding state breaks rate-limit basis stability)
- **P2:** 1 finding (audit-record `ON CONFLICT DO NOTHING` no-op at adjudicate-postgres layer)

**Top 3 by impact:**
1. The `cryptoRandomNonce()` fallback in `medusa/store-adjudicated.ts`, `medusa/adjudicated.ts`, `stripe/adjudicated.ts`, `twilio/adjudicated.ts` plus ~25 `nonce: randomUUID()` sites across `routes/me.ts`, `routes/cart.ts`, `routes/order-actions.ts` defeat ledger dedup — same logical operation retried produces a fresh `intentHash` every time. The framework `envelope.ts` doc explicitly calls this out as "the foot-gun pre-T8 was designed to prevent."
2. `defer-resolver.ts:589` emits the resumed-envelope audit record without `supersedes` — replay tools cannot follow the resume chain back to the original DEFER; the `Supersession{ reason: "defer_resumed" }` contract documented in `audit.ts:42-58` is unrealized in ibatexas.
3. `kernel-executor.ts:221`, `llm-responder.ts:460`, `routes/me.ts:459,727` call `parkDeferredIntent` directly, bypassing the adopter-owned `parkDeferredIntentWithNxGuard`. Concurrent DEFERs for the same `sessionId` silently overwrite the first parked envelope (the wrapper exists explicitly to prevent this; see its own header comment).

**Report path:** `/Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/audit-2026-05-24/A-replay-determinism.md`

---

## Bug 1 — Fresh `nonce: randomUUID()` at every envelope construction defeats ledger dedup
**Severity:** P0
**Files:**
- `packages/tools/src/medusa/store-adjudicated.ts:621` (and `:950-954` `cryptoRandomNonce`)
- `packages/tools/src/medusa/adjudicated.ts:542` (and `:648-654`)
- `packages/tools/src/stripe/adjudicated.ts:374` (and `:630-636`)
- `packages/tools/src/twilio/adjudicated.ts:412` (and `:532-536`)
- `apps/api/src/routes/me.ts:433, 690, 876`
- `apps/api/src/routes/order-actions.ts:181, 277, 317, 353, 606, 696, 908, 940, 1049, 1078, 1111, 1224, 1251, 1276, 1386, 1488`
- `apps/api/src/routes/cart.ts:156, 830, 940`

**Class:** Hash divergence (silent ledger-dedup foot-gun)

**Reproduction:**
1. User calls `POST /api/orders/:id/cancel` (or any cart tool from the LLM) — `routes/order-actions.ts:317` builds an envelope with `nonce: randomUUID()` → `intentHash_A`.
2. Network blip / user double-tap / page reload triggers a retry of the same logical action.
3. The retry produces a fresh `randomUUID()` → `intentHash_B != intentHash_A`.
4. Both envelopes are accepted, both are audited as distinct decisions, both are executed (or REFUSE-then-EXECUTE) — the Execution Ledger's 7-day dedup window has no entry for `intentHash_B` to dedupe against.

**Expected on replay:** A retried envelope reuses the original `nonce` → same `intentHash` → ledger short-circuits to the prior decision.

**Actual on replay:** The retry is treated as a wholly new intent; ledger dedup is structurally inert at the ibatexas boundary.

**Root cause:**
The T8 envelope spec moved the idempotency key out of `createdAt` (descriptive only) into the `nonce` field (load-bearing for hash) precisely so adopters could rebuild envelopes on retry without breaking ledger dedup (see `envelope.ts:14-21,67-77`). The contract: "Retries pass the SAME value as the original attempt — typically the adopter persists the envelope (or just the nonce) at first dispatch and reuses on retry."

The ibatexas surface uniformly violates this. The four egress wrappers each declare `meta.idempotencyKey?` as optional and fall back to `crypto.randomUUID()` when callers omit it. **None of the ~10 cart-tool callers (`add-to-cart.ts`, `apply-coupon.ts`, `update-cart.ts`, `remove-from-cart.ts`, `get-or-create-cart.ts`, `create-checkout.ts`) pass `idempotencyKey`.** The HTTP routes inline a fresh `nonce: randomUUID()` literal at every `buildEnvelope(...)` site. Cumulatively this is ~30 ibatexas-side envelope construction sites all producing non-deterministic intent hashes on retry.

The framework's own comment block in `store-adjudicated.ts:942-948` warns: "Replay safety requires the caller to supply `idempotencyKey`." The warning is in the helper; no caller honors it.

**Concrete amplifier — Twilio retry loop:** `apps/api/src/whatsapp/client.ts:143-161,220-235` retries the same `twilioAdjudicated.messages.create` up to 3 times in a tight loop. Each retry generates a fresh `randomUUID()` nonce. So a single logical WhatsApp send may produce 3 envelopes with 3 distinct intentHashes and 3 audit rows — for what is logically one send.

**Suggested fix:** Two options (callers can mix):
- **Per-call site:** derive a stable `idempotencyKey` from a domain identifier the caller already has. Cart tools: `${ctx.sessionId}:${cartId}:${variantId}:${verb}` (already covered by the assert-cart-ownership chain). Routes: `${customerId}:${routeName}:${requestBodyHash}` or accept an `Idempotency-Key` HTTP header from the client.
- **Framework-level:** introduce `nonce: "auto-from-payload"` in `BuildEnvelopeInput` that computes a stable hash of `(kind, payload, actor.sessionId)` — but this collapses the case where the same payload is legitimately submitted twice (a user wanting to add the SAME variantId twice). Per-call-site stable keys are safer.

---

## Bug 2 — DEFER+resume audit record omits `supersedes`, breaking the audit chain
**Severity:** P0
**File:** `apps/api/src/subscribers/defer-resolver.ts:587-607`

**Class:** Supersession-chain break (replay tooling cannot follow `defer_resumed`)

**Reproduction:**
1. PIX-pending DEFER parks an envelope with intentHash `H_park`.
2. `payment.status_changed` fires; `resolveDeferredSession` re-adjudicates the parked envelope, producing a new Decision (e.g. EXECUTE).
3. `buildAuditRecord({ envelope, decision, durationMs })` is invoked — note the absence of `supersedes`.
4. The emitted audit row carries the SAME `intentHash` as the original DEFER (resume reuses the parked envelope) but has no `supersedes` link.

**Expected:** The audit record carries `supersedes: { predecessorIntentHash: H_park, predecessorAt: <original ISO>, reason: "defer_resumed" }`, allowing replay tools to follow the chain.

**Actual:** No supersession link. Two audit rows with the same `intentHash` exist (the original DEFER and the resumed EXECUTE), distinguished only by `decision_kind` + `recorded_at`. Replay tooling cannot tell which is the resume — and the Postgres sink's `ON CONFLICT DO NOTHING` (P0-14, see Bug 6) will not differentiate them at the DB level either.

**Root cause:** `audit.ts:42-58` defines `Supersession` with `reason: "defer_resumed"` as a v3+ field. `defer-resolver.ts:20-24` documents in a comment "An audit record is emitted with `supersedes` linking the resume back to the original park." The implementation never actually passes the field. The comment lies.

The sibling `anonymize-grace-resolver.ts:108-134` is worse — it documents emitting an audit record (line 111: "audit record carries `supersedes: [parked.intentHash]`") but emits **nothing at all**. The destructive `anonymizeCustomer(customerId)` runs without any audit emit. Search confirmed no `buildAuditRecord` or `getAuditSink` reference in that file.

**Suggested fix:**
```ts
// defer-resolver.ts:589
const record = buildAuditRecord({
  envelope,
  decision,
  durationMs: Date.now() - startedAt,
  supersedes: {
    predecessorIntentHash: parked.envelope.intentHash, // same hash, but explicit
    predecessorAt: parked.parkedAt,                    // ISO from ParkedEnvelope
    reason: "defer_resumed",
  },
});
```

And in `anonymize-grace-resolver.ts:113-126`, emit a real audit record around `anonymizeCustomer(customerId)`. The destructive LGPD operation is precisely the kind that needs supersession-traceable audit.

---

## Bug 3 — Direct `parkDeferredIntent` callers bypass adopter NX guard
**Severity:** P0
**Files:**
- `packages/llm-provider/src/kernel-executor.ts:221`
- `packages/llm-provider/src/llm-responder.ts:460`
- `apps/api/src/routes/me.ts:459, 727`

**Class:** Mutable state between adjudicate calls (silent payload overwrite on collision)

**Reproduction:**
1. Session `s1` adjudicates intent `A` → kernel returns DEFER → `kernel-executor.ts:221` calls `parkDeferredIntent` directly (no NX guard). Park key `defer:pending:s1` now holds envelope `A`.
2. Concurrent: same session emits intent `B` → kernel also returns DEFER → second `parkDeferredIntent` call OVERWRITES the same Redis key. Park key `defer:pending:s1` now holds envelope `B`. Envelope `A` is permanently lost.
3. PIX wire signal arrives → resume executes envelope `B`, not `A`.

**Expected on replay:** The first parked envelope (`A`) is preserved; the second (`B`) is refused with `collision`. The `parkDeferredIntentWithNxGuard` wrapper exists specifically for this. See `apps/api/src/adapters/park-deferred-intent-nx.ts:1-32` — its header documents this is a real data-loss class.

**Actual on replay:** The framework's `parkDeferredIntent` (in `@adjudicate/runtime/defer-park.ts:219`) performs a plain `redis.set(...)` without `NX`. Two DEFERs for the same `sessionId` silently overwrite each other; only the last writer's envelope is recoverable.

**Root cause:** The adapter `parkDeferredIntentWithNxGuard` was introduced (per the file header) precisely to prevent this. But 4 production callers (the kernel-executor itself, the LLM responder, and both `me.ts` anonymize sites) reach past the adapter and call the framework primitive directly. The adapter's `hoistAndValidateVerificationFields` step (lines 195-239) is ALSO bypassed, but those callers do manually copy `version/nonce/taint/actorPrincipal` to the top level — so the hash-verification fields path is intact. The NX collision guard is the load-bearing missing piece.

**Suggested fix:** Replace the 4 direct calls with `parkDeferredIntentWithNxGuard({...})`. Add a grep-test (mirror of `bypass-detection.test.ts`) that fails CI on any non-test `import { parkDeferredIntent } from "@adjudicate/runtime"`.

---

## Bug 4 — Resumed envelope is a stripped `ParkedEnvelope.envelope` cast as `IntentEnvelope`
**Severity:** P1
**File:** `apps/api/src/subscribers/defer-resolver.ts:565`

**Class:** Non-canonical serialization (audit row's envelope_jsonb lacks `createdAt` after resume)

**Reproduction:**
1. Original adjudication produces a full `IntentEnvelope` with `createdAt: "2026-05-23T..."`.
2. `kernel-executor.ts:222-233` parks ONLY `{intentHash, kind, actor:{sessionId}, payload, version, nonce, taint, actorPrincipal}` — `createdAt` is NOT included in the parked blob. Verified against `ParkedEnvelope.envelope` shape at `defer-resume.ts:29-49`: `createdAt` is not a field.
3. On resume, `defer-resolver.ts:565` does `const envelope = parked.envelope as IntentEnvelope`. The cast lies — the runtime object has no `createdAt`.
4. `buildAuditRecord({ envelope, decision, ... })` embeds this `createdAt`-less envelope.
5. `postgres-sink.ts:120` writes `envelope_jsonb: JSON.stringify(record.envelope)` — `createdAt` is `undefined`, so it's dropped from the JSON.
6. Replay tool reads the row, calls `legacyV1ToV2(row)` (audit-postgres). `legacy-v1-compat.ts:56`: `nonce: typeof row.nonce === "string" ... ? row.nonce : (stored.nonce ?? stored.createdAt)`. The row's `nonce` IS populated (the framework recipe always reads nonce from envelope, see `postgres-sink.ts:129-132`), so the fallback is benign — for now.
7. BUT `buildEnvelope({ createdAt: stored.createdAt, ... })` at `legacy-v1-compat.ts:63` receives `undefined`. In `envelope.ts:95`: `const createdAt = input.createdAt ?? new Date().toISOString()`. Replay's reconstructed envelope gets a FRESH timestamp. Not in the hash, but the audit-record's `auditHash` recompute (if a verifier runs) WILL diverge because `createdAt` IS in the AuditRecord — and a verifier that strips `auditHash` and re-canonicalizes the rest will see a different `createdAt`.

**Expected:** Replay reproduces a byte-identical `AuditRecord` including the original `createdAt`.

**Actual:** Replay of resumed-envelope rows reconstructs an envelope with `createdAt = <replay-time now()>`, breaking `verifyAuditRecord` on the audit-record-level hash for any record that originated from a resume.

**Root cause:** The runtime's `ParkedEnvelope` (defined in `defer-resume.ts:29-49`) was deliberately leaner than `IntentEnvelope` — `createdAt` was viewed as metadata-only (per the T8 spec). But the ibatexas resume path treats `parked.envelope` AS a full envelope (line 565 cast) and embeds it in the v4 audit record without ever restoring `createdAt`. The audit-record hash (v4 auditHash) is computed over canonical(record \ {auditHash, signature}) — `createdAt` is one of those fields.

**Suggested fix:** Either:
- Have `defer-resolver.ts:565` rebuild the envelope via `replayEnvelopeFromAudit`-style reconstruction with a stored `createdAt` (would require parking it too); OR
- Park the full envelope (add `createdAt` to `ParkedEnvelope.envelope` upstream, as an additive field); OR
- In `defer-resolver.ts:589`, populate `at: parked.parkedAt` AND attach a synthesized `createdAt` to `envelope` before passing to `buildAuditRecord`, AND assert downstream that the resumed audit record's `envelope.createdAt === parked.envelope.createdAt`. Without upstream changes, this is a fragile workaround.

---

## Bug 5 — `now: new Date()` injected into customer-onboarding state makes the rate-limit basis non-replayable
**Severity:** P1
**Files:**
- `apps/api/src/routes/me.ts:448, 707, 893` (state.ctx.now = new Date())
- `packages/pack-customer-onboarding/src/policies.ts:152-159` (consumer)

**Class:** Non-deterministic guard basis (basis carries computed `hoursSince`)

**Reproduction:**
1. User calls `PATCH /api/me/profile` at T1. `routes/me.ts:893` (or similar) builds state with `now: new Date()` = T1.
2. `enforceProfileRateLimit` (policies.ts:265-278) computes `hoursSince = (T1 - lastProfileUpdateAt) / hour`. If `hoursSince < CUSTOMER_PROFILE_RATE_LIMIT_HOURS`, returns REFUSE with `basis: [{ rule: "profile_rate_limit", hoursSince: X.YZ, ... }]`.
3. Audit row stores `decision_basis` and `decision_jsonb` carrying the precise `hoursSince` float.
4. Replay tool re-runs `adjudicate(envelope, state, ...)`. To classify drift, replay must reconstruct state. If state is reconstructed at replay-time, `now` is a different timestamp; `hoursSince` differs; basis detail differs.
5. `classifyReplayDrift` only compares decision-kind + basis-codes + refusal-code (see `replay-classify.ts:43-75`), so this won't trip the standard classifier. BUT the v4 `auditHash` includes the full basis (with detail), so `verifyAuditRecord` against a re-derived record will see a mismatch.

**Expected:** State that affects basis detail is captured at decision time (as an ISO timestamp), and replay reconstructs the same state.

**Actual:** `now` is a transient construction; it's projected from `new Date()` at the route layer and never persisted. Replay must either (a) skip basis-detail comparison or (b) read `at` from the audit row and use it as `now`. Neither is what `verifyAuditRecord` does today.

Note: the issue is hash-divergent in the auditHash sense, NOT in the intentHash sense (state is not part of intentHash). This is why severity is P1 rather than P0 — it doesn't break ledger dedup, only the v4 tamper-evidence guarantee for rate-limited refusals.

**Suggested fix:** Either (a) have the route pass `now: new Date(envelope.createdAt)` so the kernel-evaluation-time `now` is keyed to the (deterministic) envelope timestamp, or (b) extend the basis to record an ISO `at` and have replay use it for `now` projection, or (c) accept that `hoursSince` is non-deterministic and exclude it from the auditHash recipe via a dedicated `non_deterministic_detail` sub-object (kernel + audit contract change, large scope).

---

## Bug 6 — Postgres `ON CONFLICT DO NOTHING` is a no-op; duplicate audit rows for same intentHash
**Severity:** P2
**File:** `packages/llm-provider/src/postgres-audit-writer.ts:68-95`

**Class:** Replay-side-effect leak (duplicate audit rows confuse replay-by-intentHash queries)

**Reproduction:**
1. AuditRecord emit lands in Postgres → row 1 with `id=1, intent_hash=H, recorded_at=T1`.
2. NATS-redelivery or Redis-spill replay causes the same record to be emitted again → row 2 with `id=2, intent_hash=H, recorded_at=T1` (same content).
3. The `ON CONFLICT DO NOTHING` clause matches no unique constraint (audit-postgres schema has NO unique constraint on `intent_hash` or `(intent_hash, recorded_at)` — the comment at lines 28-52 explicitly acknowledges this).
4. Both rows persist. Replay queries selecting by `intent_hash = H` get TWO rows; ordering by `recorded_at DESC, id DESC` happens to be stable here, but any caller doing `find first` gets one or the other based on driver-level ordering, plus the Layer-2 dedup is now structurally inert.

**Expected on replay:** Reading audit history by `intent_hash` produces a single canonical row (Layer-2 dedup catches the duplicate).

**Actual on replay:** Duplicates accumulate silently. The wiring's Layer-1 (Redis SETNX in `audit-consumer.ts`) is the only real dedup; the wiring comment at lines 49-52 acknowledges this.

**Root cause:** The original SQL targeted `ON CONFLICT (intent_hash, recorded_at)` — a constraint that does not exist. The fix was to fall back to bare `ON CONFLICT DO NOTHING`, which is a no-op. Acknowledged in the file header as a known follow-up against `@adjudicate/audit-postgres`.

**Suggested fix:** Either (a) add a unique constraint on `intent_hash` upstream in `@adjudicate/audit-postgres` migration 009 (this is the structural fix); or (b) accept duplicates and have downstream replay tools `SELECT DISTINCT ON (intent_hash) ... ORDER BY recorded_at ASC` to canonicalize. Not urgent because Layer-1 (Redis SETNX) handles the common case; urgent if Redis ever gets bypassed (e.g., direct postgres re-emit during replay tooling).

---

## Methodology / what I checked but found clean

- **`packages/llm-provider/src/audit-redactor.ts`** — idempotent by construction, uses `AUDIT_REDACT_SECRET` salt as a stable input; recomputes `auditHash` over redacted record (P0-15 fix). Sentinel detection (`isSentinelString`) prevents double-redact drift. ✓ clean.
- **`@adjudicate/core/hash.ts`** — canonical-JSON SHA-256 with deterministic key sort; `null`/`undefined` normalized; pure function. ✓ clean.
- **`@adjudicate/core/envelope.ts:buildEnvelope`** — `createdAt` correctly excluded from hash input; `nonce` is the load-bearing idempotency key. ✓ clean at the framework boundary; foot-gun is at adopter call sites (Bug 1).
- **`packages/pack-orders/src/policies.ts`** — no time / random reads; PIX-pending guard is a pure function of payment status. ✓ clean.
- **`packages/pack-customer-onboarding/src/policies.ts`** — `enforceProfileRateLimit` reads `state.ctx.now` but that's an adopter-supplied state field; only the route's projection of `now` is non-deterministic (Bug 5).
- **`packages/domain/src/services/__shared__/loyalty-policy.ts`** — single executeStampAdd EXECUTE guard, no time or random reads, pure SYSTEM-taint policy. ✓ clean.
- **`packages/domain/src/services/__shared__/order-projection-policy.ts`** — pure ownership / existence checks, no time-dependent guards. ✓ clean.
- **`apps/api/src/subscribers/__shared__/system-actor-envelope.ts`** — `nonce = eventId` correctly threaded; stable derivation across subscribers / jobs. ✓ clean (the helper is correct; callers consistently pass stable eventIds).
- **`apps/api/src/jobs/pix-expiry-checker.ts`, `stale-order-checker.ts`, `no-show-checker.ts`** — all use stable eventIds (`pix:expiry:${paymentId}`, `stale:${orderId}`, `noshow:${reservationId}`). ✓ clean.
- **`apps/api/src/subscribers/cart-intelligence.ts:361-366, 461-466, 549-553`** — uses `buildSystemEnvelope` with stable eventIds (`loyalty:${orderId}`, `projection:${orderId}`, `payment:${orderId}`). ✓ clean.
- **Kill-switch path in `@adjudicate/core/kernel/enforce-config.ts:setKillSwitch`** — invokes `new Date().toISOString()` for `toggledAt`, which lands in the kill-active refusal's basis detail. But the kill switch is a runtime override; on replay the original `toggledAt` is preserved in the audit row, and re-adjudication with the switch released produces a DIFFERENT decision-kind that the standard `classifyReplayDrift` handles correctly (DECISION_KIND mismatch). Not a determinism bug — a deliberate kill-override.
- **`@adjudicate/core/replay-classify.ts`** — compares decision-kind, basis (category+code), refusal-code; ignores basis detail, durationMs, auditHash, recorded_at. ✓ correct surface for replay-determinism comparison.

## Open questions

1. **Replay-against-historical-state**: the resume path's `buildResumeOrderState` (defer-resolver.ts:150) reconstructs state from a NATS event. Replay tooling has no access to the NATS event. Can the audit row's `envelope.payload` alone be enough to re-derive state for replay? If not, the replay contract is structurally limited to envelope+decision comparison, NOT full re-adjudication. This is a contract question, not a bug.

2. **F2 missing — `kernel.intent_dispatched` basis code**: the 2026-05-23 SYNTHESIS flagged this as still open in the sibling repo (Q1). Without it, what is supposed to be a supersession-prefix basis in the resume audit record? Possibly the missing F2 is WHY Bug 2's fix wasn't landed — but the fix doesn't require F2 (`Supersession.reason: "defer_resumed"` is independent of any basis code). Unclear without a deeper governance read.

3. **Twilio retry idempotency**: even with a stable `idempotencyKey`, the underlying Twilio SDK does NOT expose an `Idempotency-Key` HTTP header for `messages.create` (acknowledged in `twilio/adjudicated.ts:373-376`). So even with a stable nonce, the actual Twilio API may not dedupe — but the kernel's audit ledger would. Worth confirming whether the operator-side intent is "kernel dedup is enough" or "we need Twilio API dedup too" (which would require swapping transports).

4. **Order in which audit rows for the same intentHash should be returned**: with Bug 6 (no unique constraint) duplicate rows can pile up. Existing replay tooling that does `SELECT * FROM intent_audit WHERE intent_hash = ?` may not be deterministic. Not confirmed without a deeper read of `pg-reader.ts` and `audit-store.ts` in the sibling repo.
