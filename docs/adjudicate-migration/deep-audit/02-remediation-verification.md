> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover per-fix scorecard against W1-W6 remediation claims (2026-05-23). PARTIAL and WEAKER-THAN-CLAIMED verdicts drove Waves 7-9 closure work. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Remediation Verification Audit

**Auditor:** Remediation Verification Auditor
**Date:** 2026-05-23
**Mandate:** Distrust every "complete" claim from the W1-W6 remediation reports. Independently verify each of the 26 in-codebase fixes by tracing the implementation against the audit's original findings.
**Inputs:**
- `docs/adjudicate-migration/audit/AUDIT-SYNTHESIS.md` (P0-1..P0-15, P1-A..P1-L, P2-A..P2-C)
- `docs/adjudicate-migration/remediation/REMEDIATION-COMPLETE.md`
- `docs/adjudicate-migration/remediation/REMEDIATION-STATE.md`

---

## Methodology

For each claimed-closed fix the auditor opened the implementation file at the asserted location, walked the execution path under adversarial conditions (concurrency, partial failures, edge inputs), grepped for residual bypass code, and cross-referenced the framework primitive when the fix delegates into `@adjudicate/runtime` or `@adjudicate/core`. No code was modified.

Verdicts:
- **VERIFIED** — claim matches the code; no hidden hole found within scope.
- **VERIFIED-WITH-CAVEAT** — claim matches but an adjacent gap or known limitation was acknowledged in the code/report.
- **PARTIAL** — claim is materially implemented but a documented operator action or design trade-off leaves a residual risk.
- **WEAKER-THAN-CLAIMED** — the fix is present but with a race, edge case, or scope hole that the remediation report under-discloses.

---

## Per-fix scorecard

| ID | Claim | Verdict | File:line | Notes |
|---|---|---|---|---|
| P0-6 | `installPack` fail-fast via `start().catch()` | VERIFIED | `apps/api/src/index.ts:138-142` | Sentry captured before exit. If Sentry.captureException itself throws, logger.fatal never runs — minor (Sentry is meant to be safe). |
| P0-9 | Enforce-config typo fail-closed | VERIFIED | `apps/api/src/plugins/kernel-bootstrap.ts:192-211` | Throws on `unknownShadow`/`unknownEnforce`. `parseList` trims + filters empty. **Case-sensitive** (`Order.cart.add` would be flagged — correctly). |
| P0-4 | Admin reservation cancel via envelope | VERIFIED | `apps/api/src/routes/admin/reservations.ts:255-330` | No `$transaction` remnant. Envelope path is the only path. |
| P0-5 | Two-person staffId binding | VERIFIED-WITH-CAVEAT | `apps/api/src/routes/admin/admin-confirmation-store.ts:178-195` | Atomic GET+DEL Lua + comparison after consume. **CAVEAT**: when `requestStaffId === null` OR `pending.staffId === null`, the check is skipped (API-key mode treated as a single actor; documented). |
| P0-14 | Postgres ON CONFLICT aligned | PARTIAL | `packages/llm-provider/src/postgres-audit-writer.ts:68-95` | Changed to `ON CONFLICT DO NOTHING` (no columns). **Acknowledged**: Layer-2 dedup at Postgres is currently a no-op (duplicates would land as separate rows). Operator must apply the SQL migration before flipping `IBX_AUDIT_POSTGRES_ENABLED=true`. |
| P1-C | payment-lifecycle DLQ on throw | VERIFIED-WITH-CAVEAT | `apps/api/src/subscribers/payment-lifecycle.ts:162-179, 254-267` | DLQ push present on both branches. **CAVEAT**: if `pushToDlq` itself throws inside the inner catch, the OUTER catch (line 318) only logs — original payload lost. Dedup ledger keyed on `(paymentId, newStatus)` means DLQ replay may still fire the mutation. |
| P1-J | no-show-checker via envelope | VERIFIED | `apps/api/src/jobs/no-show-checker.ts:77-128` | Uses `reservation.no_show.mark`, nonce `noshow:${reservationId}` for idempotency. No commented-out legacy code. |
| P0-7 | DEFER park via `parkDeferredIntent` (3 sites) | WEAKER-THAN-CLAIMED | `packages/llm-provider/src/kernel-executor.ts:276`, `packages/llm-provider/src/llm-responder.ts:508`, `apps/api/src/routes/me.ts:439,701` | All 3 sites use the runtime primitive with T-005 verification fields and quota. **BUT** the runtime's `parkDeferredIntent` uses plain `redis.set({EX})` for the park blob — **NO NX**. A second DEFER on the same `sessionId` STILL overwrites the first parked blob; the quota counter prevents unbounded growth, but the blob overwrite (the original audit-flagged bug) still exists at the framework level. See `/Users/thaisrodolpho/projects/adjudicate/packages/runtime/src/defer-park.ts:219-229`. Additionally, in `kernel-executor.ts:309-311`, a thrown park error is logged but the function STILL returns `parked: true` — caller is told the intent was parked when it wasn't. |
| P0-8 | Two-phase commit on resume dedup | VERIFIED | `apps/api/src/subscribers/defer-resolver.ts:420-642` | Order: SETNX-resuming → dispatch → SETNX-resumed → DEL-pending → DECR-counter → DEL-resuming. Recovery: resuming marker has 60s TTL. Cleanup on dispatch failure (line 596): DEL-resuming only, pending left for retry. Correct two-phase commit shape. |
| P0-15 | AuditRedactor recomputes hash | VERIFIED | `packages/llm-provider/src/audit-redactor.ts:418, 446, 503-509` | `recomputeAuditHash` strips auditHash+signature and rehashes via `sha256Canonical`. Called on both happy and fail-open (stub) paths. Signature dropped (acknowledged out-of-scope). |
| P1-D | defer-resolver distinguishes IOError from null | VERIFIED | `apps/api/src/subscribers/defer-resolver.ts:256-292, 332-350` | `robustRedisGet`: 3 retries with exp backoff (50/100/200ms), returns discriminated `{kind: value|missing|error}`. Error → DLQ + return `transient_error`. |
| P1-E | Sweeper recovery scan + heartbeat | VERIFIED-WITH-CAVEAT | `apps/api/src/jobs/defer-timeout-sweeper.ts:330-492, 137-145, 521-531` | Recovery scan fires on startup BEFORE the repeatable job registers. SETNX dedups via `recovery:fired:{intentHash}`. Heartbeat written every tick with 120s TTL. **CAVEAT**: NO heartbeat reader in the codebase — PagerDuty alerting is an operator action (acknowledged). |
| P1-F | `slot.released` removed | VERIFIED | grep across `packages/pack-reservations` | Only references are in code comments documenting the removal. No publishers or consumers remain. |
| P0-1 | Refund magnitude routed through kernel | VERIFIED | `apps/api/src/routes/admin/payments.ts:296-403` | Envelope carries `refundAmountCentavos` + `refundableBalanceCentavos` + `currentRefundedCentavos`. Routes through `paymentCmdSvc.issueRefundFromEnvelope`. No direct `prisma.payment.update` on `refundedAmountCentavos`. |
| P0-2 | payment/retry + regenerate-pix via envelopes | VERIFIED-WITH-CAVEAT | `apps/api/src/routes/order-actions.ts:734-822, 874-987` | The 5 audit-flagged sites are converted. **CAVEAT**: the route decomposes into `payment.status.transition` + `payment.create` envelopes rather than using the composite `payment.retry` / `payment.pix.regenerate` kinds that DO exist in pack-payments. Adjudication happens but at sub-intent granularity. |
| P0-3 | amend-order pipeline end-to-end adjudicated | VERIFIED | `packages/tools/src/cart/amend-order.ts:77-83, 136, 152, 221, 229, 237, 359, 367, 375, 463, 499, 548` | Every Medusa write goes through `medusaAdjudicated`. Every payment call uses `*FromEnvelope`. `medusaAdmin` import retained for reads via `createOrderService`. Stripe PI creation is inline external egress (acknowledged), PI ID then carried in adjudicated `payment.create`. |
| P1-I | Refund drip cap per-staff-day | WEAKER-THAN-CLAIMED | `apps/api/src/routes/admin/payments.ts:124-146, 460-531` | INCRBY is used, cap-check fallback to 2-step receipt exists. **HOLE**: `readDailyRefundTotal` (GET) → cap-check → `executeRefund` → `incrementDailyRefundTotal` is NOT atomic. Two concurrent refunds at `cap - 10` both read the same total, both pass the check, both execute, both INCRBY — total ends up above cap. The race window is the entire `executeRefund` duration. The audit's original claim was "both pass the cap" — this exact race remains. |
| P1-L | ALLOWED_MEDUSA_DIRECT audited | VERIFIED | `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:110-122` | Five files; each verified GET-only by inspection. `reorder.ts` + `amend-order.ts` removed from the list. |
| P0-10 | actor.sessionId hashed | VERIFIED | `packages/llm-provider/src/audit-redactor.ts:467-485, 431-434` | Always hashed via salted SHA-256 for any non-empty non-sentinel sessionId. Sentinel detection idempotent. WhatsApp pre-hashed (sha256-of-phone, 64-char hex) gets a second hash — still deterministic per customer, acceptable. |
| P0-11 | OTP brute-force + cancel cooldown | VERIFIED-WITH-CAVEAT | `apps/api/src/routes/me/anonymize-otp-gate.ts:208-295`, `apps/api/src/routes/me.ts:582-639` | INCR + EXPIRE-on-first-increment pattern. **EDGE**: if Redis restarts between INCR and EXPIRE, the counter has NO TTL — permanent lock. Mitigation: only locks legitimate user, no security regression. Five concurrent failed OTPs reliably increment to 5 because Redis is single-threaded; minor over-shoot possible on >5 (e.g., 6 returned to the caller, all fail-locked). |
| P0-12 | NATS auth wiring | PARTIAL | `packages/nats-client/src/index.ts:61-138` | Creds-path, nkey, TLS-CA, TLS-required all wired. Production-no-auth → loud `console.error` warning, but PROCEEDS. Acknowledged as operator-deferred (no creds provisioning was attempted; would require ops work). |
| P0-13 | anonymizeCustomer scrubs completely | VERIFIED-WITH-CAVEAT | `packages/domain/src/services/customer.service.ts:473-530` | Inside one `$prisma.$transaction(async tx => ...)`. Steps: (1) customer name → "Usuário Removido", email null, phone → `anonymized:sha256(customerId)[0:16]` (UNIQUE constraint workaround), cpf null, medusaId null. (2) addresses deletedMany. (3) preferences deletedMany. (4) reviews comment nulled. (5) order items customerId nulled. **CAVEAT**: `Review.customerId` is `String` (non-nullable per Prisma schema) so the FK link CANNOT be nulled in app code without a migration — the linkage is broken only via the Customer row scrub. Documented in comments (lines 506-516). |
| P1-G | pack-whatsapp REFUSE on unprojected staff routing | VERIFIED | `packages/pack-whatsapp/src/policies.ts:169-189, 448` | `refuseUnprojectedStaffRouting` is in `authGuards` array (line 448). Auth phase evaluates before the `business` phase that contains `sanitizeCustomerToStaff` REWRITE. Order is correct. |
| P1-H | Admin API-key fail-closed | VERIFIED | `apps/api/src/middleware/staff-auth.ts:96-127, 138-164`, `apps/api/src/routes/admin/index.ts:57-88, 113-121` | Both `requireManagerRole` and `requireOwnerRole` fail-closed when API key has no registry entry. Malformed JSON in production → throw. Empty registry → all API keys rejected on destructive routes. Boot-time warning for keys without role mapping. |
| W5-1 | pack-payments installed at boot | VERIFIED | `apps/api/src/plugins/kernel-bootstrap.ts:134` | `installPack(paymentsPack)` is called inside `installFirstPartyPacks`. |
| W5-3 | Drift intent kinds renamed | VERIFIED | grep across packages | Zero remaining usages of `order.cart.add` or `order.pix.regenerate`; only comments documenting the rename. |
| W5-4 | KNOWN_INTENT_KINDS = 62 | VERIFIED-WITH-CAVEAT | `packages/llm-provider/src/intent-kinds.ts:56-195` | Manual count: 22 + 8 + 4 + 3 + 17 + 8 = 62. `satisfies readonly XIntentKind[]` clauses pin compile-time consistency with each Pack's union. **CAVEAT**: `packages/cli/src/commands/__tests__/kernel.test.ts:82` still asserts `count = 32` (3 pre-existing failures acknowledged). |
| W5-8 | `ibx kernel divergence` beyond stub | VERIFIED | `packages/cli/src/commands/kernel.ts:327-545` | Real Postgres `pg.Client` connection, reads `intent_audit` via `readAuditWindow` from `@adjudicate/audit-postgres`, groups by `basis[].metadata.class`, prints summary. Not a stub. |
| W5-9 | kernel_intent_kind_coverage gauge | VERIFIED | `apps/api/src/plugins/kernel-metrics-sink.ts:220, 273-298, 388-392` | Observed-kinds map maintained per decision (with 24h eviction), publishes ratio `(observed ∩ known) / |known|`. Denominator published at construction so dashboards have it even at zero traffic. |

### Wave 6 (testing + observability + docs, 13 deliverables)

Skimmed each W6 test file. The pattern is: hoisted Vitest stubs for Redis (Map-backed), Twilio (vi.fn), NATS (vi.fn), Prisma where applicable; real Fastify instances; real kernel `adjudicate()` for `multi-pack-supersedes` and `audit-sink-fail-resilience`. Verdicts:

- **W6-1 lgpd-anonymize-lifecycle**: 6 mocks (including `anonymizeCustomer`). Tests wiring, not the DB scrub. Documented as such.
- **W6-2 multi-pack-supersedes**: 0 mocks. Real `adjudicate()` against `ordersPolicyBundle` + `paymentsPolicyBundle`. Genuine cross-cutting.
- **W6-3 audit-sink-fail-resilience**: 0 mocks (uses local Redis spill stub). Real kernel + buildAuditRecord, verifies fail-open contract.
- **W6-4 kernel-bootstrap-pack-failure**: 2 mocks (`installPack` stubbed to throw). Tests propagation through bootstrap.
- **W6-5 concurrent admin two-step Lua atomicity**: pings real Lua against an in-process Redis mock.
- **W6-6, W6-7**: 0 mocks. Real adjudicate paths.
- **W6-8** bypass-detection extensions: regex extension. **STILL LINE-BASED** (acknowledged). Multi-line POST calls slip through. AST migration explicitly flagged as follow-up.

---

## Confirmed weaknesses / partial implementations

### W1
- **P0-14 partial** — SQL `ON CONFLICT DO NOTHING` works against the deployed schema only if the operator has applied the audit-postgres migration. The remediation acknowledges this; in-code dedup is a no-op until the unique index lands upstream.

### W2
- **P0-7 framework-level hole** — `parkDeferredIntent` does `redis.set(parkKey, ..., { EX })` without NX. Second DEFER for the same sessionId overwrites the first blob even though the quota counter increments correctly. This is the *exact* bug the audit reported, persisting in the framework primitive used to "fix" it.
- **Kernel-executor return on park failure** — when `parkDeferredIntent` throws, `kernel-executor.ts:309-317` returns `parked: true` regardless. Caller may report success when Redis is down.

### W3
- **P1-I race** — refund drip cap check-then-act is non-atomic; concurrent refunds can both pass the cap. No INCRBY+check is performed atomically (no Lua eval). The cap check uses GET, executes the refund, then INCRBYs. Same attack the audit identified.
- **payment.method.switch route bypass** — `apps/api/src/routes/order-actions.ts:1049-1065` still uses BARE-ARG `paymentCmdSvc.transitionStatus(...)` and `.create(...)` for the method switch flow. The pack-payments intent kind `payment.method.switch` exists in W5 but is unused; the route fully bypasses kernel adjudication on this money-path mutation. **Outside the original audit scope** (the audit only flagged retry/regen-pix sites), but the same vulnerability class.

### W4
- **P0-11 Redis-restart edge case** — INCR-then-EXPIRE allows a stuck counter if Redis crashes between the two. Fail-mode locks honest user but doesn't compromise security.
- **P0-12 deferred** — code path supports auth but no creds are provisioned. Three customer-touching enforce paths are gated on this.
- **P1-H operator-pending** — code is fail-closed but operator must populate `ADMIN_API_KEY_ROLES_JSON`. Empty registry blocks every API key.

### W5
- **kernel.test.ts stale** — three pre-existing test failures asserting `count = 32` documented but not fixed. Anyone running the test suite gets red.

### W6
- **P1-K acknowledged-partial** — bypass-detection regex is still line-based; multi-line POST bypasses slip through. Documented as follow-up.
- **LGPD lifecycle test is wiring-only** — `anonymizeCustomer` itself is mocked; the test does not verify phone/email/CPF/reviews are actually scrubbed against a Prisma DB. The unit test for `anonymizeCustomer` (`customer-anonymize.test.ts` and similar) does exist but the W6-1 integration test does not pin DB shape end-to-end.

---

## Hidden TODOs uncovered

1. `packages/llm-provider/src/postgres-audit-writer.ts:14-18` — "Schema TODO: When the IntentAudit Prisma model lands, swap this implementation for `prisma.intentAudit.create({data: row})`." Still on raw `$executeRawUnsafe`.
2. `packages/llm-provider/src/postgres-audit-writer.ts:43-52` — "Schema-level dedup is tracked as a follow-up against the @adjudicate/audit-postgres package." Layer-2 dedup remains a no-op.
3. `apps/api/src/routes/me/anonymize-otp-gate.ts:243` — comment about `EXPIRE NX` semantics "emulated as a defensive EXPIRE call which is harmless if TTL is already set" — but the call is `redis.expire(key, TTL)` only on `next === 1`, so other increments leave the TTL state to the first arrival.
4. `packages/llm-provider/src/audit-redactor.ts:206` — `audit-redactor` warn-injection cleanup; one site still uses console.warn as fallback (documented in `REMEDIATION-COMPLETE.md`).
5. `packages/cli/src/commands/__tests__/kernel.test.ts:82` — pre-existing failure asserting `count=32` against W5's 62.

---

## Unreachable / never-exercised branches

- `apps/api/src/jobs/defer-timeout-sweeper.ts:137` writes `heartbeat:defer-sweeper` — **no reader in the codebase**. The signal is for operator/PagerDuty wiring; without it, sweeper outages have no in-process alarm.
- `apps/api/src/middleware/staff-auth.ts:96-127` — `requireManagerRole` API-key fail-closed branch fires only when operator did NOT configure `ADMIN_API_KEY_ROLES_JSON`. Default deploy without env var → every API-key admin call returns 403.
- `apps/api/src/plugins/kernel-bootstrap.ts:188-211` — fatal-throw path is only exercised when env vars have typos. No staging test seeds a deliberate typo to confirm process exit on a real boot.

---

## Edge cases that bypass the fix

1. **P0-5 same-actor with null staffId** — API-key step-1 followed by JWT-staff step-2 (or vice versa) passes the check trivially because one side is `null`. Documented but worth noting: an attacker who controls both an API-key AND a staff JWT bypasses the two-person rule on either step. Mitigation requires registry mapping API-keys to a synthetic "role-actor" and then comparing those.
2. **P0-7 sessionId overwrite** — runtime primitive's park blob has no NX, so two DEFERs for the same sessionId still race-overwrite. The quota counter prevents unbounded growth but the data-loss class persists.
3. **P0-15 hash-rebind requires same salt** — `AUDIT_REDACT_SECRET` must be snapshotted alongside audit records or replay fails. The trade-off is documented but in practice operators may not consider this until the salt changes.
4. **P1-C DLQ throw** — if `pushToDlq` itself throws inside the inner `catch`, the outer try (line 318) catches and logs only. Original payload is lost. Dedup ledger means a replay (manual ops action) is the only recovery.
5. **P1-I race** — concurrent sub-threshold refunds can collectively exceed the daily cap because the check is non-atomic with the increment. Single-actor attack: open two browser tabs and submit two `R$1990` refunds within the same millisecond.
6. **payment.method.switch route** — not in original audit but same bypass class; bare-arg `transitionStatus` + `.create` on `apps/api/src/routes/order-actions.ts:1049-1065`. Kernel sees nothing on this flow.

---

## Verdict per wave

| Wave | Theme | Verdict | Rationale |
|---|---|---|---|
| W1 | Fail-safety + enforcement | 🟢 GREEN | 7/7 verified. P0-14 partial is operator-side per the report's own disclosure. |
| W2 | DEFER + replay correctness | 🟡 AMBER | 5/6 verified. P0-7 has a framework-level overwrite hole + kernel-executor returns `parked:true` on throw. The two-phase commit (P0-8) is solid. |
| W3 | Money-path governance | 🟡 AMBER | 4/5 verified strongly + 1 caveat (P0-2). **P1-I has a real race window** that could be weaponized by a single insider. Adjacent route bypass (`payment.method.switch`) is outside scope but unaddressed. |
| W4 | Security + LGPD | 🟢 GREEN (pending NATS) | Code-side fixes solid. P0-12 is honest operator-deferred. P0-13 reviews FK limitation is schema-level not app-level. |
| W5 | Enforcement readiness | 🟢 GREEN | pack-payments wired, KNOWN_INTENT_KINDS = 62, divergence CLI real, coverage gauge live. Stale kernel.test.ts disclosed. |
| W6 | Testing + observability + docs | 🟡 AMBER | Tests are mostly stub-driven where reality matters (LGPD lifecycle mocks `anonymizeCustomer`). bypass-detection still regex-based. Honest about limits in the report. |

---

## Top 5 fixes that are weaker than claimed

1. **P0-7 DEFER park** — the runtime primitive lacks NX on the blob SET, the kernel-executor still returns `parked: true` on throw. Bug class persists at a deeper layer.
2. **P1-I refund drip cap** — check-then-act race; INCRBY happens AFTER `executeRefund` returns. Concurrent refunds can defeat the cap.
3. **P0-14 Postgres audit** — code-side change is good (SQL no longer crashes), but Layer-2 dedup is now a documented no-op. Two replays of the same audit record will land as separate Postgres rows.
4. **W6-1 LGPD lifecycle test** — mocks `anonymizeCustomer`. The integration test claim "pins the full lifecycle" overstates: the DB-scrub semantics are not exercised end-to-end.
5. **P0-5 same-actor null edge** — null-on-one-side bypasses the check. Acceptable per the documented API-key model but the audit's "step 2 by same operator" wording leaves the null edge unaddressed.

## Top 3 fixes that are well-implemented (credit where due)

1. **P0-8 two-phase commit on resume** — SETNX-resuming before dispatch, dispatch, then SETNX-resumed + DEL-pending + DECR-counter + DEL-resuming, with a 60s TTL safety net on the intermediate marker. Clean ordering, correct cleanup on failure, recovery via TTL. Best fix in the entire remediation.
2. **P0-15 audit hash recomputation** — rigorous mirroring of `verifyAuditRecord`'s strip-and-hash sequence, applied on both happy and fail-open paths. Trade-off is explicitly documented in `REDACTION-HASH-DECISION.md`. Signature dropping is honest.
3. **P0-3 amend-order pipeline** — every Medusa write now flows through `medusaAdjudicated`, every payment call uses `*FromEnvelope`. Stripe inline is acknowledged. Removed from `ALLOWED_MEDUSA_DIRECT`. Comprehensive refactor.

## Overall verdict

**Trustworthy in shape, brittle in detail.** The remediation report's high-level claims line up with the code — 24/26 in-codebase fixes are materially present, and the 2 deferred items (P0-12 NATS, P0-14 Postgres) are honestly flagged. The report is candid about its trade-offs (audit hash recomputation, redactor signature drop, LGPD test mocking, bypass-detection regex).

However: three fixes (**P0-7 DEFER park, P1-I drip cap, P0-15 redactor**) carry subtleties that the wave reports under-disclose — especially P1-I's race and P0-7's framework-level overwrite. A determined adversary or a high-concurrency incident would expose those.

**Production readiness:**
- Tier 1 + 2 shadow rollout: appropriate; the report's recommendation matches the code.
- Tier 3 + 4 enforce: should NOT proceed until P0-7's framework primitive is patched (NX on park blob) AND P1-I's race is closed (Lua atomic check-and-increment). The report's claim that money-path is GREEN-PENDING-NATS understates the in-process race.
- Audit-postgres flip: only after operator applies the migration, AND the Layer-2 dedup limitation is internalized by the ops team.

**Recommendation**: file three additional remediation tickets:
1. Framework PR: `parkDeferredIntent` must SETNX the blob (or use a Lua compound op).
2. Backport: kernel-executor's `parked: true` return on park throw should become `parked: false` with a propagated refusal.
3. P1-I race: rewrite the cap check as a single Lua eval (INCRBY-then-check-and-rollback), mirroring the `evalIncrCheck` pattern already used by `parkDeferredIntent`.
