# Adversarial audit synthesis — 2026-05-24

**Branch:** `feat/kernel-always-on-cutover` @ `c5c839c`
**Method:** 6 parallel adversarial audits, instructed to find concrete bugs (not re-baseline coverage)
**Result:** **9 P0** + **8 P1** + **8 P2** findings. Several previously "fixed" issues are still load-bearing wrong.

**Source reports:**
- [A-replay-determinism.md](./A-replay-determinism.md) — 3 P0 / 2 P1 / 1 P2
- [B-deferred-chaos.md](./B-deferred-chaos.md) — 2 P0 / 3 P1
- [C-envelope-authenticity.md](./C-envelope-authenticity.md) — 1 P1 / 2 P2
- [D-today-regression.md](./D-today-regression.md) — 1 P1 / 4 P2-P3
- [E-admin-lgpd-redteam.md](./E-admin-lgpd-redteam.md) — 1 P0 / 2 P1 / 2 P2
- [F-audit-pipeline.md](./F-audit-pipeline.md) — 3 P0 / 3 P1

---

## TL;DR

The 2026-05-23 audit reported ~88% adjudicated and "kernel always-on, authoritative." This adversarial sweep finds that **several load-bearing guarantees are paper-only**:

- The W7-P0-7-TRUE NX-park wrapper has **zero production callers** — it's tested but never used.
- 17 wrapper-callers (twilio, stripe, medusa-store) silently **skip audit emit** because `auditSink` is optional and never passed.
- The LGPD `anonymizeCustomer` executor **leaves customer PII in ~8 tables** after running — and there's a **race** that lets a customer cancel during the destructive Prisma TX (LGPD Art. 18).
- The audit pipeline writes every row **twice** (in-process Postgres sink + NATS consumer), but the dedup `ON CONFLICT` is a no-op because there's no UNIQUE constraint on `(intent_hash, recorded_at)`.
- `update_preferences` (landed yesterday) silently **zeros stored allergens** when the LLM omits the field — violates the explicit allergens rule.
- Random `nonce: randomUUID()` in 4 just-landed wrappers + 25 sites breaks ledger dedup on HTTP retry / WhatsApp resend.

These are not theoretical issues. Most have file:line evidence and a concrete reproduction. The cutover commit's claim that the kernel is "authoritative and audited" is **not currently true** along several axes.

---

## P0 — must fix before any production rollout

### P0-1 — NX-park wrapper is dead in production paths

**Severity:** P0 — destroys DEFER replay determinism
**Audits:** B-1, A-3
**Evidence:**
- `parkDeferredIntentWithNxGuard` (`apps/api/src/adapters/park-deferred-intent-nx.ts:105`) has only test callers.
- Production callers bypass it and call `parkDeferredIntent` directly from `@adjudicate/runtime`:
  - `packages/llm-provider/src/llm-responder.ts:460`
  - `packages/llm-provider/src/kernel-executor.ts:221`
  - `apps/api/src/routes/me.ts:459`
  - `apps/api/src/routes/me.ts:727`
- The framework `parkDeferredIntent` (`adjudicate/packages/runtime/src/defer-park.ts:219`) uses plain `set(...)` with no `NX` flag.

**Impact:** Two back-to-back DEFERs for the same `sessionId` silently overwrite each other. The W7-P0-7-TRUE wrapper, the D2 G3 fail-loud hoist, and `PARK_COLLISION_REFUSAL_PT_BR` are all paper-only protections.

**Fix:** migrate the 4 production callers to `parkDeferredIntentWithNxGuard`. ~1-2h.

### P0-2 — Sweeper races in-flight resume → double-execute destructive ops

**Severity:** P0 — double-execution of `anonymizeCustomer` (and any other DEFERred destructive intent)
**Audit:** B-2
**Evidence:**
- `apps/api/src/jobs/defer-timeout-sweeper.ts` has no references to `defer:resuming` / `defer:resumed` keys.
- When TTL crosses `IMMINENT_TTL_SECONDS=60`, the sweeper publishes `intent.defer.timeout` **and** DELs the parked key — while the defer-resolver may simultaneously be re-dispatching the mutation.
- For intents whose `intent.defer.timeout` handler runs the same executor as resume (anonymize), this is double-execution.

**Fix:** sweeper must SETNX-acquire `defer:resuming:${parkKey}` before deleting; resolver must hold the same key during dispatch. Or: sweeper publishes timeout but does NOT delete; resolver is the only deleter. ~3-4h with tests.

### P0-3 — Anonymize cancel-vs-resolve race → LGPD violation possible

**Severity:** P0 — LGPD Art. 18 (right to revoke deletion)
**Audit:** E-1
**Evidence:**
- `apps/api/src/subscribers/anonymize-grace-resolver.ts:113-126` runs the Prisma anonymize TX with no SETNX lock against `/api/me/anonymize/cancel`.
- A customer who cancels at T+24h-ε while the resolver TX is in flight can see a 200 "canceled" response while data is being anonymized in another transaction.

**Fix:** SETNX lock `anonymize:active:${customerId}` acquired by both surfaces (whichever wins becomes authoritative). Resolver releases on commit; cancel releases on success. ~2-3h with tests.

### P0-4 — 17 wrapper callers silently skip audit emit

**Severity:** P0 — audit trail has holes for every PIX confirm, cart mutation, outbound WhatsApp
**Audit:** F-1
**Evidence:**
- All three new wrappers (`twilioAdjudicated`, `medusaStoreAdjudicated`, `medusaAdjudicated`, `stripeAdjudicated`) declare `auditSink?: AuditSink` as **optional** (e.g., `packages/tools/src/twilio/adjudicated.ts:381`, `packages/tools/src/medusa/store-adjudicated.ts:539`).
- The emit is conditional: `if (meta.auditSink) { meta.auditSink.emit(record) }`.
- 17 call sites in `packages/tools/src/cart/*.ts` (including yesterday's W4 migrations) and `apps/api/src/whatsapp/client.ts` pass `meta` **without** `auditSink`.
- The wrapper's `_shared.ts` documents this as a deliberate "cycle-avoidance compromise" (`@ibatexas/tools` cannot import from `@ibatexas/llm-provider`).

**Worst offender:** `packages/tools/src/cart/create-checkout.ts:68` builds an envelope carrying raw PIX `billing_details.{name, email, tax_id}` that NEVER reaches an audit sink.

**Fix:** resolve the dep cycle (e.g., extract `getAuditSink()` to a leaf package). OR: thread the sink via DI at boot, attached to every wrapper-meta automatically. ~4-6h (architecture call required).

### P0-5 — Redactor rule typo + templateVariables miss → WhatsApp PII leak

**Severity:** P0 — template variable values reach audit topic unredacted
**Audit:** F-5
**Evidence:**
- `INTENT_KIND_FIELD_RULES` key `"whatsapp.handoff.request"` does not exist — real kind is `"whatsapp.session.handover"`.
- Rule field name `"variables"` misses the real payload field name `templateVariables`.

**Fix:** rename the key + add the correct field. ~30min.

### P0-6 — Free-form fields escape redactor across 14 intent kinds

**Severity:** P0 — `conversation.message.append.body` carries literal customer text into audit topic
**Audit:** F-6
**Evidence:**
- 14 intent kinds across `pack-payments`, `pack-orders`, `pack-reservations`, `pack-whatsapp` have `reason`/`comment`/`body`/`note`/`specialRequests` payload fields with no redactor rule.
- The global regex defense catches CPF/email/phone/card but does NOT catch customer names.

**Fix:** per-intent-kind redactor rules for each of the 14 kinds. ~2-3h with contract tests.

### P0-7 — Random `nonce: randomUUID()` breaks ledger dedup on retry

**Severity:** P0 — HTTP retries / WhatsApp resends produce distinct intentHashes for the same logical operation
**Audit:** A-1
**Evidence:**
- 4 just-landed wrappers (`medusa/store-adjudicated.ts:621`, `medusa/adjudicated.ts:542`, `stripe/adjudicated.ts:374`, `twilio/adjudicated.ts:412`) generate fresh `randomUUID()` per call when no `idempotencyKey` is supplied.
- ~25 sites across `routes/me.ts`, `routes/cart.ts`, `routes/order-actions.ts` build envelopes the same way.
- This is exactly the foot-gun the T8 idempotency-key spec was designed to prevent.

**Fix:** require idempotency-key from callers (or derive from request-id when available). Where no key is reasonable, document the "best-effort dedup only" posture explicitly. ~3-4h to add the key to ~5 highest-priority call sites; full sweep ~1-2d.

### P0-8 — anonymize executor emits NO audit record

**Severity:** P0 — destructive LGPD operation has no audit trail
**Audits:** A-2, F-2
**Evidence:**
- `anonymize-grace-resolver.ts:114` runs the Prisma anonymize TX without `buildAuditRecord` / sink emit.
- The code comment claims "audit record carries supersedes" but the code never calls the sink.

**Fix:** emit `buildAuditRecord({kind:"customer.anonymize.execute", supersedes: <original-park-intentHash>})` before the TX commits. ~1h with tests.

### P0-9 — anonymizeCustomer LGPD scope is incomplete

**Severity:** P0 — ANPD compliance failure
**Audit:** E-2
**Evidence (all PII surviving "anonymize"):**
- `OrderProjection.{customerEmail, customerName, customerPhone, shippingAddressJson}`
- `ConversationMessage.content`
- `Conversation.customerId`
- `OrderStatusHistory.actorId`
- `OrderEventLog.payload`
- `LoyaltyAccount` (customer-linked record)
- `Reservation.specialRequests`
- **Medusa-side customer row** (separate database)

**Fix:** extend the anonymize executor to scrub all 8 surfaces. Medusa-side scrub is most novel (cross-DB transaction or compensation pattern). Estimated **~1-2 days** with contract tests + ANPD audit checklist refresh.

---

## P1 — should fix before any new feature work

### P1-1 — `update_preferences` zeros stored allergens

**Severity:** P1 — violates CLAUDE.md rule #1 ("allergens MUST always be explicit `[]` — never infer")
**Audit:** D-1
**Evidence:** `packages/tools/src/intelligence/update-preferences.ts:34-58` — when the LLM omits `allergens` in the proposal, the tool coerces missing → `[]` which silently zeroes stored allergens.
**Fix:** reject the proposal (REFUSE) if `allergens` is missing; OR preserve existing stored value. Either is correctness-improving; reject is safer. ~30min.

### P1-2 — AuditRedactor doesn't walk `decision.rewritten.payload`

**Severity:** P1 — REWRITEd payloads leak PII into audit topic
**Audit:** C-1
**Evidence:** The redactor scrubs `envelope.payload`. After REWRITE, `audit-record.decision.rewritten.payload` carries the post-rewrite (potentially PII-tainted) value. The spread on `audit-redactor.ts:431` lets it through.
**Fix:** redactor must also walk `decision.rewritten.payload`. ~1h.

### P1-3 — resume-dispatcher silently drops kernel-covered tool resumes

**Severity:** P1 — checkout, add_to_cart resumes never execute the actual mutation
**Audit:** B-3
**Evidence:** `apps/api/src/adapters/resume-dispatcher.ts:134-152` has a code comment explicitly noting "task 22" was never landed and the mutation is silently dropped. The resolver sees no error, commits the ledger, deletes the parked key.
**Fix:** dispatch via the existing executor (the kernel-executor knows which tool to invoke per the parked envelope kind). ~3-4h.

### P1-4 — Audit row duplication: every row persisted 2×

**Severity:** P1 — 2× storage growth, broken aggregates
**Audit:** F-4
**Evidence:** Both the in-process Postgres sink (in-band) and the audit-consumer subscriber (out-of-band) write the same record. The two-layer dedup uses Redis SETNX with DIFFERENT key prefixes, so neither sees the other. `ON CONFLICT DO NOTHING` is a no-op because there's no UNIQUE constraint on `(intent_hash, recorded_at)`.
**Fix:** add the UNIQUE constraint; choose one path as authoritative (in-process for latency; consumer for fault-tolerance). ~1-2h + schema migration.

### P1-5 — defer-resolver omits `supersedes` field

**Severity:** P1 — replay tools cannot follow defer_resumed chain
**Audits:** A-2, F-3
**Evidence:** `apps/api/src/subscribers/defer-resolver.ts:589` builds the resume audit record without `supersedes: <original-intent-hash>`.
**Fix:** thread the original hash through resume. ~30min.

### P1-6 — `middleware/auth.ts` accepts whitespace `sub`

**Severity:** P1 — W7-G1 only patched the OTP gate, not the JWT middleware
**Audit:** E-3
**Evidence:** `apps/api/src/middleware/auth.ts:64,95,127` — three sites still use `=== ""` (untrimmed).
**Fix:** add `.trim().length === 0` to the three guards. ~10min.

### P1-7 — `intent.defer.timeout` has no PIX consumer

**Severity:** P1 — PIX expirations silently swallowed
**Audit:** B-4
**Evidence:** Only `anonymize-grace-resolver` subscribes to `intent.defer.timeout`. PIX-expiry events publish there but are dropped.
**Fix:** add `pix-defer-timeout-resolver` subscriber, or repurpose `pix-expiry-checker` job to consume the NATS subject. ~2h.

### P1-8 — NX-wrapper quota counter leak on park-throw

**Severity:** P1 — quota slot leaked per mid-park exception
**Audit:** B-5 (was W6 finding, documented but never fixed)
**Evidence:** `apps/api/src/adapters/park-deferred-intent-nx.ts:162-168` — if INCR succeeds but the placeholder SET throws, the counter is not DECR'd.
**Fix:** wrap in try/catch with DECR on failure path. ~30min.

---

## P2 — polish + observability

| # | Finding | Audit | File | Effort |
|---|---|---|---|---|
| P2-1 | B3 retry treats `TwilioAdjudicateRefusedError` as transient → 3 audit emissions per refused | D-2 | `apps/api/src/whatsapp/client.ts:143-160,220-240` | 1h |
| P2-2 | W4 cart catches swallow `MedusaStoreAdjudicateRefusedError.userFacing` → generic pt-BR | D-3 | `packages/tools/src/cart/{add-to-cart,update-cart,remove-from-cart}.ts` | 1h |
| P2-3 | D3 audit record loses original `pickup`/`dine_in` vocab fidelity | D-4 | `apps/api/src/routes/order-actions.ts:1487` | 30min |
| P2-4 | `subscribeNatsEvent` no queue group → N-way handler inflation | E-5 | NATS subscriber wiring | 1h |
| P2-5 | Force-* payloads omit `expectedVersion` (projection version not pinned at step-2 dispatch) | E-4 | `apps/api/src/routes/admin/{orders,payments}.ts` | 1-2h |
| P2-6 | Latent forgery — `actor.principal: "system"` mintable from customer HTTP routes | C-2 | customer-intent-gateway | 2h |
| P2-7 | Latent forgery — `taint: "TRUSTED"` mintable from customer HTTP routes | C-3 | customer-intent-gateway | 1h |
| P2-8 | C1 taxonomy mismatch (`medusa.store.cart.email.update` used for metadata-only) | D-5 | `packages/tools/src/medusa/store-adjudicated.ts:carts.update` | 30min |

---

## Pre-existing latent bugs surfaced (not from yesterday's commits)

- **`get_loyalty_balance` is READ_ONLY-classified but triggers a Postgres upsert** (Audit D)
- **`submit_review` has no cross-customer ownership check** — a customer can submit a review for an order belonging to another customer if they know the orderId (Audit D)

Both are out-of-scope for the audit-2026-05-24 closeout but should be added to the backlog.

---

## Audit's own clean surfaces (verified no findings)

- Nonce generation uses `crypto.randomUUID()` everywhere live (`Math.random` fallbacks are dead code on Node ≥ 22) — Audit C
- Stripe + Twilio webhook signatures verified before lift-to-envelope — Audit C
- Admin two-person rule fail-closed (P0-5-TRUE intact) — Audit C
- Actor-principal spoofing structurally blocked by TypeScript constraint at the BASE — Audit C
- JWT empty-`sub` defense intact at the OTP gate — Audit E (but missing at middleware — see P1-6)
- W6-1 (`verifyParkedEnvelopeHash` inert) → W7-G3 hoist holds — Audit E
- D2 G3 hoist extends to version/nonce/taint with fail-loud (this session's work) — Audit E

---

## Severity-ranked remediation buckets

### Bucket H0 — Tight P0 fixes (~1d wall-clock, mostly mechanical)
Best parallel-safe set with high blast-radius reduction per hour:
- P0-1 NX-park migrate 4 callers (~1-2h)
- P0-5 redactor rule typo (~30min)
- P0-6 free-form field redactor rules for 14 kinds (~2-3h)
- P0-7 nonce idempotency for 5 highest-priority sites (~3-4h)
- P0-8 anonymize audit emit (~1h)
- P1-1 allergens fix (~30min)
- P1-2 REWRITE PII fix (~1h)
- P1-5 supersedes threading (~30min)
- P1-6 middleware/auth.ts trim (~10min)

**Total ~10-13h**. Closes 6 P0s + 4 P1s. Could split across 4-6 parallel agents.

### Bucket H1 — Concurrency P0 fixes (design + careful implementation)
- P0-2 sweeper-vs-resume race (~3-4h)
- P0-3 anonymize cancel-vs-resolve race (~2-3h)
- P1-3 resume-dispatcher task-22 (~3-4h)
- P1-4 audit row UNIQUE + dedup choice (~1-2h + schema migration)
- P1-7 PIX defer-timeout consumer (~2h)
- P1-8 NX-wrapper quota counter leak (~30min)

**Total ~12-15h**. Each requires careful testing for race correctness. ~2 agents serial.

### Bucket H2 — Architecture-required P0
- P0-4 wrapper auditSink dep-cycle resolution (~4-6h **after** architectural decision)
  - Option A: extract `getAuditSink` to a leaf package
  - Option B: DI sink via boot, attached automatically to wrapper-meta
  - Option C: move sink emit out of wrappers; have callers emit
  - **Needs your call before implementation.**

### Bucket H3 — LGPD epic
- P0-9 anonymizeCustomer scope expansion (8 tables incl. Medusa cross-DB) (~1-2d)
  - Standalone epic; conformance tests + ANPD checklist refresh

### Bucket P2 polish (~5h total)
- All 8 P2 items, parallel-safe across 3-4 agents

---

## Hardening tests (recommended additions, agnostic of which bugs you choose to fix)

1. **NX-park conformance test**: assert via grep that no production .ts file imports `parkDeferredIntent` directly (must go through wrapper).
2. **AuditSink wrapper-call conformance test**: assert every wrapper-call passes `auditSink`.
3. **Per-intent-kind redactor conformance**: for each kind in `KNOWN_INTENT_KINDS`, assert either a per-kind rule exists OR the payload is provably PII-free.
4. **LGPD scrub conformance**: snapshot every table reachable from customerId; assert post-anonymize zero rows match the pre-anonymize PII fixtures.
5. **DEFER+resume integrity**: parked envelope hash + post-resume audit record's `supersedes` field must point at it.
6. **Sweeper-resolver race regression test**: schedule both within 50ms; assert at most one mutation fires.
7. **Idempotency key conformance**: for every wrapper-call, assert either idempotency-key supplied OR documented as "best-effort dedup only."

---

## Recommended sequencing

**Phase A (Bucket H0 only, this session):** ~10-13h work compressed to ~2h wall-clock via 4-6 parallel agents on disjoint surfaces. Closes 6 P0s + 4 P1s. Best return on hours invested. Safe to land without architectural debate.

**Phase B (Bucket H1, next session):** ~12-15h, fewer agents because race-correctness needs care. Closes the remaining "core safety" P0s.

**Phase C (Bucket H2, gated on decision):** P0-4 wrapper auditSink architecture. Needs your call (Option A/B/C). Until then, the 17 wrapper sites have an audit-trail hole.

**Phase D (Bucket H3, gated on stakeholder):** LGPD anonymize scope expansion. ~1-2d epic; touches Medusa cross-DB. Should not block H0/H1.

**Phase E (Bucket P2):** parallel polish, low risk.

**Phase F:** hardening tests (recommended additions).

---

## What this audit did NOT cover

- Runtime fuzzing — bugs that only manifest under specific data shapes or concurrency timings beyond what static analysis catches.
- Cross-repo correctness — adjudicate sibling repo audited only in pass-through fashion. The framework's `verifyParkedEnvelopeHash` back-compat branch may need its own audit.
- Penetration testing of the WhatsApp inbound path (the LLM is a trust boundary; prompt-injection adversarial scenarios weren't deeply explored).
- Capacity / latency analysis under load.
- Conformance of the `@adjudicate/conformance` matrix against ibatexas packs.
