# Audit Synthesis — Master Findings

**Date:** 2026-05-23
**Branch audited:** `feat/consume-adjudicate-from-platform-repo` @ `0e1fb62`
**Auditors:** 8 specialized agents, ~2,044 lines of findings across `audit/01..08`

---

## TL;DR — The implementation is NOT production-ready

The overnight run produced **structurally correct code** but **the seams between modules leak guarantees**:

- **22 confirmed mutation bypasses** (7 P0, 12 P1, 3 P2) — including money paths
- **Replay is NOT byte-deterministic** today
- **DEFER is NOT production-safe** today
- **The PII gate has a known-good blind spot** (`actor.sessionId` plaintext customerId)
- **The two-person rule is NOT enforced** (admin step-1 and step-2 by same actor pass)
- **`installPack` fail-fast is not actually wired** (sync throw becomes unhandledRejection)
- **NATS has zero auth** — anyone on the network can forge resume signals or exfiltrate audit records

The framework primitives from `@adjudicate/core` and `@adjudicate/runtime` are correct. The adopter layer breaks the invariants — three different agents wrote three different `DEFER park` implementations and **none used the safe runtime primitives**. This is exactly the bug class that doesn't surface in per-file unit tests.

**Recommendation: DO NOT flip `IBX_KERNEL_ENFORCE` until the P0 remediations land.**

---

## P0 — Production-blocking findings (fix before any enforce flip)

### P0-1 — Refund magnitude bypasses the kernel
**Source:** Bypass Hunter §1
**File:** `apps/api/src/routes/admin/payments.ts:251`
**Risk:** Direct `prisma.payment.update` on `refundedAmountCentavos` after kernel only approved the *status transition*. Refund magnitude is never adjudicated. An attacker (or buggy code) can transition to "refunded" with a $0 status decision then write any amount to the DB.
**Fix:** Build a separate `payment.refund.issue` envelope with full amount in the payload; route through pack-orders/pack-payments policy. **Money path. P0 with regulatory consequences.**

### P0-2 — `payment/retry` and `payment/regenerate-pix` are unadjudicated end-to-end
**Source:** Bypass Hunter §2
**File:** `apps/api/src/routes/order-actions.ts:734,745,819,829,836`
**Risk:** Chain of THREE bypasses: deprecated bare-arg `paymentCmdSvc.transitionStatus` + bare-arg `paymentCmdSvc.create` + direct `prisma.payment.update` on `regenerationCount`. Zero kernel adjudication on entire flow.
**Fix:** Task 14 explicitly cut these routes from scope; complete the wrap. ~1d work.

### P0-3 — `amend-order.ts` entire pipeline unadjudicated
**Source:** Bypass Hunter §3
**File:** `packages/tools/src/cart/amend-order.ts:35,151-166,357`
**Risk:** Stripe PaymentIntent create, Medusa POSTs to `admin/orders/edits/items/confirm`, deprecated payment svc calls — none reviewed by kernel. The file is in `ALLOWED_MEDUSA_DIRECT` despite being a heavy writer.
**Fix:** Refactor amend-order to use envelope-typed payment service + `medusaAdjudicated` wrapper. Remove from `ALLOWED_MEDUSA_DIRECT`. ~1-2d.

### P0-4 — Admin reservation cancel bypasses ReservationCmdSvc
**Source:** Bypass Hunter §4
**File:** `apps/api/src/routes/admin/reservations.ts:270`
**Risk:** `prisma.$transaction([...])` writes directly. `reservationCmdSvc.cancelFromEnvelope` already exists from task 15.
**Fix:** Replace `$transaction` block with envelope call. ~30min.

### P0-5 — Two-person rule is unenforced
**Source:** Bypass Hunter §5
**File:** `apps/api/src/routes/admin/admin-confirmation-store.ts` consumer
**Risk:** Step 2 reads receipt's staffId for *audit* but never checks `request.staffId !== pending.staffId`. Same operator can issue both calls. Just one-person-double-click protection — not separation-of-duty.
**Fix:** Add explicit `if (request.staffId === pending.staffId) refuse("same_actor")`. ~30min.

### P0-6 — `installPack` fail-fast not wired
**Source:** Pack Conformance §1
**File:** `apps/api/src/index.ts:131`
**Risk:** `start()` invoked without `.catch()`. Sync throw inside `bootstrapKernel` becomes `unhandledRejection` (logs + Sentry) but no `process.exit(1)`. Process hangs without subscribers running. Contradicts the kernel-bootstrap docstring + tasks 01+08+15 claims.
**Fix:** Wrap `start()` call with `.catch(err => { console.error(err); process.exit(1) })`. ~5min.

### P0-7 — DEFER park is silent-data-loss
**Source:** Deferred Workflow §1 + Reliability §1
**Files:** `kernel-executor.ts:270`, `llm-responder.ts:498`, `routes/me.ts:313`
**Risk:** All three park sites use raw `redis.set(...)` instead of the runtime's `parkDeferredIntent`. No NX, no quota counter, no verification fields. Second DEFER on same sessionId silently overwrites the first. LLM tells user "aguardando confirmação" while no envelope was stored.
**Fix:** Replace raw `redis.set` with `parkDeferredIntent` from `@adjudicate/runtime` at all three sites. Per-site ~30-60min × 3.

### P0-8 — Resume dedup fires BEFORE dispatch → restart loses intent
**Source:** Deferred Workflow §3
**File:** `defer-resolver.ts:305-451`
**Risk:** SETNX dedup ledger AND parked-key delete BOTH happen BEFORE the dispatcher runs. Crash between → ledger says "resumed", dispatcher never fired, every retry blocked as "duplicate". Permanently stuck intent.
**Fix:** Reorder: dispatch first, then mark dedup. Or use a two-phase commit pattern with `pending` and `done` states. ~2-3h.

### P0-9 — Enforce-config typo silently disables enforcement
**Source:** Reliability §2
**File:** `kernel-bootstrap.ts:168-178`
**Risk:** `IBX_KERNEL_ENFORCE=order.cart.adddd` (typo) → warning + proceed. Ops dashboard shows green. **Enforcement disabled silently in prod.**
**Fix:** Make typo fail-closed: `validateEnforceConfig` with unknown intent kinds → process exit, not warn. ~15min.

### P0-10 — Audit redactor leaks customerId via `actor.sessionId`
**Source:** Security §3
**File:** `audit-redactor.ts` + contract test `audit-redaction-contract.test.ts:610-612`
**Risk:** HTTP routes set `actor.sessionId = customerId` verbatim. Redactor explicitly preserves `envelope.actor`. **The contract test wrongly excludes `actor.sessionId` from PII detection.** Every audit record ships plaintext customerId to NATS + Postgres.
**Fix:** Hash `customerId` at envelope-build time OR treat `actor.sessionId` as HASH field in redactor. Update contract test to detect this PII path. ~1-2h.

### P0-11 — Stolen JWT instantly destroys an account
**Source:** Security §1
**Files:** LGPD anonymize flow
**Risk:** `initiate-deletion` requires only JWT cookie. **No fresh-OTP gate at initiation.** Combined with no app-layer brute-force counter on anonymize OTP verify → stolen-cookie attacker iterates codes faster than global rate limit. Cancel-then-reinitiate amplifies harassment + Twilio spend.
**Fix:** Require fresh OTP at initiate-deletion (not just delete). Add per-customer brute-force counter (`anonymize:fail:{customerId}`) with 5-strike lockout. Add 30-min cooldown after cancel-deletion. ~3-4h.

### P0-12 — NATS has zero authentication
**Source:** Security §2
**File:** `packages/nats-client/src/index.ts:29-33`
**Risk:** No creds, no nkey, no TLS. Any process reaching `localhost:4222` can:
- Subscribe to `audit.intent.decision.v1` → **PII exfiltration**
- Publish forged `payment.status_changed` → **forge resume signals**
- Publish forged `intent.defer.timeout` → **forge LGPD anonymize triggers**
**Fix:** Add nkey/JWT auth + TLS to NATS client. Infrastructure change but wiring is one-line in nats-client. ~1d total (creds rotation + dev + staging + prod).

### P0-13 — `anonymizeCustomer` doesn't actually anonymize fully
**Source:** Security §LGPD verdict
**File:** `packages/domain/src/services/customer.service.ts`
**Risk:** Per audit, `anonymizeCustomer` doesn't clear `phone` or `reviews`. **LGPD obligation not met.**
**Fix:** Extend anonymizeCustomer to nullify phone, anonymize reviews, scrub address fields. ~2-3h.

### P0-14 — Postgres audit sink will crash on first enabled write
**Source:** Replay Determinism §"latent bombs"
**File:** `postgres-audit-writer.ts`
**Risk:** `ON CONFLICT (intent_hash, recorded_at)` targets a constraint that doesn't exist (audit-postgres schema may differ). Will throw `42P10` the moment `IBX_AUDIT_POSTGRES_ENABLED=true`.
**Fix:** Verify constraint name in `@adjudicate/audit-postgres` migrations; align `ON CONFLICT` target. ~30min.

### P0-15 — AuditRedactor breaks audit hash verification
**Source:** Replay Determinism §"latent bombs"
**File:** `audit-redactor.ts`
**Risk:** Preserves `auditHash` while mutating `envelope.payload`. **`verifyAuditRecord` will report `tampered` for every redacted record read downstream.** Replay is broken by design.
**Fix:** Recompute `auditHash` after redaction OR adopt a `redactedAuditHash` companion field. Coordinate with `@adjudicate/core` audit shape. ~3-4h.

---

## P1 — Should-fix before scaling enforcement (~3-5 days total)

### P1-A — Intent-kind drift (will silently default-REFUSE under enforce)
- `order.cart.add` should be `order.item.add` (kernel-executor-envelopes.ts:52)
- `order.pix.regenerate` belongs to payment domain (taxonomy: `payment.pix.regenerate`)
- **No `@ibatexas/pack-payments` exists**, but `payment.status.transition` used at 10+ sites
- `order.status.transition` used at 7+ sites — not in pack-orders
- `conversation.message.append` — no pack home
- `medusa.*` 13 kinds — by design, but outside the typo gate

**Fix path**: rename + write `pack-payments` + expand `pack-orders` + add conversation kind to `pack-whatsapp` + register all in `KNOWN_INTENT_KINDS`. **~3-5d.**

### P1-B — Stripe webhook handler doesn't capture refund magnitude (chain with P0-1)
Already covered by P0-1 + P0-2; mentioned here for completeness.

### P1-C — payment-lifecycle subscriber swallows failures
**File:** `payment-lifecycle.ts:162-167, 242-246`
Throws warned + no DLQ push. Investigation 04 §"Quick wins" #10 — still not fixed after the overnight run.
**Fix:** Wrap `transitionStatusFromEnvelope` calls with `pushToDlq(originalPayload)` on throw. ~1h.

### P1-D — defer-resolver Redis IOError silently dropped
**File:** `defer-resolver.ts:236-239`
`get(parkedKey)` IOError caught as `null` → indistinguishable from real "no park". PIX confirmations silently dropped during transient Redis errors.
**Fix:** Distinguish error from null. On error: retry + log + sentry. ~1h.

### P1-E — Sweeper downtime silently loses envelopes
**File:** `defer-timeout-sweeper.ts`
BullMQ `upsertJobScheduler` does NOT replay missed runs. Worker down 1h → Redis GCs keys → `intent.defer.timeout` never published → no backfill, no audit. **LGPD obligation can be breached this way.**
**Fix:** Add a heartbeat metric. Add a recovery scan on worker startup that finds expired keys and publishes timeout events. ~3-4h.

### P1-F — `slot.released` is dead code
**File:** Pack-reservations references; no publisher exists.
**Fix:** Either implement the publisher or remove the dead signal. ~30min decision + work.

### P1-G — pack-whatsapp has zero auth-phase guards
**File:** `pack-whatsapp/src/policies.ts`
Customer→staff sanitization is REWRITE-only. Bypasses entirely if upstream forgets to project `recipientType`.
**Fix:** Add an explicit auth guard rejecting customer→staff without sanitization. ~1-2h.

### P1-H — Admin API-key bypasses two-person rule
**File:** `apps/api/src/middleware/staff-auth.ts:67-74`
`requireManagerRole` is no-op when no JWT. One leaked `ADMIN_API_KEY` → unbounded refunds.
**Fix:** Tighten `requireManagerRole` to fail-closed when no JWT (or define an API-key-role registry). ~1h.

### P1-I — Refund threshold bypass via drip
**Source:** Security §5
Sub-R$200 refunds skip two-step receipt. 100×R$199 ≈ R$19,900 with no aggregate cap.
**Fix:** Add per-staff-session aggregate cap (e.g., R$2000/day without second confirm). ~2h.

### P1-J — `no-show-checker` actively running deprecated state-machine transition in PRODUCTION
**Source:** Bypass Hunter §"contradictions with open-blockers"
Open-blockers said this is a "30min follow-up" — auditor flagged it's running TODAY.
**Fix:** Wrap the job in `reservation.no_show.mark` envelope. ~30min.

### P1-K — `bypass-detection.test.ts` regex is line-based — gate is performative
**Source:** Bypass Hunter §"contradictions"
Multi-line `medusaStore("/path", { method: "POST" })` slips through. Gate appears green but doesn't catch real bypasses.
**Fix:** Either AST-parse calls or use a multiline regex with proper backtracking. Extend with the 4 missing scenarios from test-coverage audit. ~3-4h.

### P1-L — `ALLOWED_MEDUSA_DIRECT` carve-out wrong
**Source:** Bypass Hunter §"contradictions"
Claims `reorder.ts` + `amend-order.ts` are "read-only"; both POST. Audit list is wrong, gate misses real bypasses.
**Fix:** Audit each entry; remove anything that's not strictly read-only. ~2h.

---

## P2 — Cleanup / monitoring debt (~1-2 days)

- DLQ CLI hardcodes 5 events (Task-04 widening of Task-19 surface; `audit.intent.decision.v1` + `intent.defer.resume` invisible)
- NATS Core mode silently drops audit on backpressure — JetStream migration overdue
- `console.warn`/`console.error` in `@ibatexas/llm-provider` — no `reqId` correlation
- `withBasisAudit` is fail-open (sink failure → undetected drift)
- pack-orders ships 10/19 governance order-kinds (9 missing, undocumented as scope-cuts)
- Pack `safePlan` wrapping should be enforced as a contract (currently per-pack convention)
- Phone regex misses `+55-11-99999-9999` (auditor caught as CARD instead — wrong sentinel)
- Obfuscated emails pass through redactor (`user [at] domain.com`)
- KNOWN_INTENT_KINDS = 32; taxonomy claims 64 but union sums to 67 (internal arithmetic error)

---

## Test gaps (P0/P1 — 10-14 engineer-days to close)

Per Test Coverage Gap audit:
1. LGPD anonymize T0→cancel→fire integration (~1-2d, closes 4 P0 gaps)
2. Stripe webhook end-to-end against real command service + DB
3. Multi-pack supersedes chain (order.cancel → payment.refund)
4. Audit-sink-fails-mid-decision; decision still completes
5. `installPack` boot-failure exits non-zero (now blocked by P0-6 fix)
6. Concurrent admin two-step confirm (Lua atomicity)
7. Order-cancel-refund multi-pack chain
8. Stripe webhook for already-anonymized customer
9. Anonymize-during-open-order
10. Shadow divergence NONE class (positive)
11. Concurrent envelope-build determinism

**`classifyReplayDrift` symbol not found anywhere; `ibx kernel replay` still a stub.**

---

## Cascade scenarios (the "looks fine in dev, breaks in prod" cluster)

- **A (P0 regulatory)**: BullMQ sweeper outage >24h → anonymize grace never fires → LGPD breached
- **B (P0 data loss)**: Redis outage during DEFER park → silent loss
- **C (P0 audit silent dropout)**: NATS Core backpressure during incident → audit records vanish
- **D (P1 audit gap)**: Simultaneous Postgres + Redis spill outage → memory queue grows → restart loses queue
- **E (P0 enforcement bypass)**: Typo in `IBX_KERNEL_ENFORCE` → enforcement off, dashboard green

---

## Verdict per domain

| Domain | Code structure | Tests | Replay | Security | Verdict |
|---|---|---|---|---|---|
| order | 🟡 | 🟢 | 🔴 | 🟡 | **needs fix** (P0-1, P0-2, P0-7, P1-A) |
| payment | 🔴 | 🟡 | 🔴 | 🔴 | **NOT production-ready** — no pack, refund bypass |
| reservation | 🟢 | 🟢 | 🟡 | 🟢 | **mostly ready** (P0-4, P1-J) |
| customer (LGPD) | 🟡 | 🟡 | 🔴 | 🔴 | **NOT production-ready** — incomplete anonymize, stolen-JWT, OTP brute-force |
| whatsapp | 🟡 | 🟢 | 🟡 | 🟡 | **amber** — REWRITE-only sanitization, no auth guard |
| audit pipeline | 🟡 | 🟡 | 🔴 | 🔴 | **NOT production-ready** — actor.sessionId leak, Postgres crash, redactor breaks hash, NATS unauth |
| LLM tool path | 🟢 | 🟢 | 🟢 | 🟢 | **mostly clean** (post task 06 + 07) |
| DEFER infra | 🔴 | 🔴 | 🔴 | 🔴 | **NOT production-safe** (P0-7, P0-8, P1-D, P1-E) |

---

## Recommendation

**Hold all enforce-mode rollouts.** The P0 cluster is broad: 15 distinct production-blocking findings spanning bypasses, replay, DEFER, security, and audit. **Fix order:**

### Wave 1 (~2 dev-days, fail-safety + obvious bugs)
P0-6 (installPack fail-fast), P0-9 (enforce-config typo), P0-4 (admin reservation cancel), P0-14 (Postgres ON CONFLICT), P1-J (no-show-checker), P0-5 (two-person staffId binding).

### Wave 2 (~3-4 dev-days, replay + DEFER correctness)
P0-7 (DEFER park primitive), P0-8 (resume dedup ordering), P0-15 (redactor hash recompute), P1-D (defer-resolver Redis errors), P1-E (sweeper recovery scan), P1-F (slot.released).

### Wave 3 (~3-4 dev-days, money path)
P0-1 (refund magnitude), P0-2 (payment/retry + regen-pix wrap), P0-3 (amend-order pipeline), P1-C (payment-lifecycle DLQ), P1-I (refund drip cap).

### Wave 4 (~3-5 dev-days, security + LGPD)
P0-10 (actor.sessionId PII), P0-11 (stolen-JWT + OTP counter), P0-12 (NATS auth), P0-13 (anonymize completeness), P1-H (admin API-key).

### Wave 5 (~3-5 dev-days, enforcement-readiness)
P1-A intent-kind drift + create pack-payments + extend pack-orders + KNOWN_INTENT_KINDS reconciliation. **This is the gate to flip enforce mode.**

### Wave 6 (~2-3 dev-days, monitoring + cleanup)
P1-K + P1-L (gate hardening), P2 cleanup.

**Total: ~15-22 engineer-days of hardening before the system is credibly production-safe.** That's on top of the ~50 dev-days the overnight run did.

---

## What the overnight run got RIGHT

To be fair, the audit found significant value:
- Framework primitives (`buildEnvelope`, `adjudicate`, kernel decision branching) are correct
- Pack scaffolding is consistent across all 4 packs (default REFUSE, `safePlan` wrapping, pt-BR refusals, conformance corpus)
- Audit pipeline architecture is sound (redactor → buffered → multi-sink → spill → NATS replay) — the weak link is monitoring, not design
- Boot sequence has no race window for traffic before packs install
- Lua atomic GET+DEL receipt-consume script is correct
- pack-reservations is fully production-ready
- Audit redactor `__redactor_error` sentinel is preserved end-to-end
- Customer identity-lifecycle (`pack-customer-onboarding`) is clean at the pack level
- LLM tool path (post 06 + 07) is mostly clean

The structural decisions were right. The integration and security details slipped through.
