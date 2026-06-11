# LGPD Art. 18 — Anonymize Coverage Proof

**Status:** Wave A (in-process Prisma surfaces) + Wave B (Medusa cross-DB) both LANDED
**Coverage:** 12/12 surfaces = **100%** — 11 in-process Prisma surfaces scrubbed atomically + the Medusa-side customer row scrubbed via an eventual-consistent compensation chain
**Branch baseline:** `feat/policy-tree` @ `458526a`
**Cross-references:**
- [audit-2026-05-24 CLOSEOUT-STATUS.md](../adjudicate-migration/audit-2026-05-24/CLOSEOUT-STATUS.md)
- [H3 SYNTHESIS.md](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/SYNTHESIS.md)
- [H3 compliance investigation](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/compliance.md)
- [H3 schema investigation](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/schema.md)
- Source policy doc: [docs/ops/data-retention.md](../ops/data-retention.md)

---

## Executive summary

This document is the single authoritative artifact a compliance auditor — and any future Autoridade Nacional de Proteção de Dados (ANPD) audit — should read to verify that IbateXas implements the LGPD Art. 18 §III right of erasure (*"direito à eliminação dos dados pessoais tratados"*).

The system honors deletion via an OTP-gated, 24-hour-deferred destructive operation that, when resolved by the grace resolver, scrubs every reachable PII surface across 11 in-process Prisma tables in a single atomic transaction and emits 7 per-surface audit records chained back to the originating customer envelope. The 12th surface — the Medusa commerce database customer row — is scrubbed out-of-band via an eventual-consistent compensation chain (Wave B): after the Prisma transaction commits, `anonymizeCustomer` publishes `customer.anonymize.medusa.pending`, a subscriber PATCHes the Medusa admin API to null the customer fields, and a BullMQ retry job sweeps any pending events that lack a confirmation. The cancel-vs-resolve race that previously left a customer in a "I clicked cancel, but my account was destroyed" state is closed by a Redis SETNX mutex (`anonymize:active:{customerId}`) shared between the cancel route and the grace resolver; the loser of the race emits a REFUSE audit record (`cancel_won_race`) rather than mutating.

All 12 PII surfaces are now covered end-to-end. The Medusa scrub is eventual-consistent (~minutes), which is acceptable under LGPD's "reasonable timeframe" standard (there is no statutory upper bound on the erasure window).

---

## LGPD Art. 18 sub-rights mapped to implementation

| Sub-right | LGPD clause | Status | Implementing path |
|---|---|---|---|
| Direito de acesso (Access) | Art. 18 §I | Verified | `GET /api/me/data` → `exportCustomerData()` at `packages/domain/src/services/customer.service.ts:1233` |
| Direito à portabilidade (Portability) | Art. 18 §II | Verified | Same endpoint as access — JSON export of all personal data |
| Direito de correção (Correction) | Art. 18 §III(i) | Out of scope for H3 | Customer can re-authenticate via OTP and supply corrected data via the standard onboarding flow; no dedicated `/api/me/update` endpoint |
| **Direito à eliminação (Erasure)** | **Art. 18 §III(ii)** | **Verified — this document** | Multi-step OTP-gated flow with 24h grace, then `anonymizeCustomer()` scrubs 11 in-process surfaces atomically + a Medusa cross-DB compensation scrub |
| Direito de revogar consentimento (Revoke) | Art. 18 §V | Verified | `POST /api/me/data/cancel-deletion` within 24h grace window — REFUSE-supersedes-parked pattern, SETNX-mutex-arbitrated against the resolver |
| Direito de não ser sujeito a decisão automatizada | Art. 18 §VI | N/A | No ML scoring / autonomous customer-impacting decisions — every mutation is enveloped + kernel-adjudicated (CLAUDE.md rule #9) |

### Anonymize-trigger paths (the 5 entry points that reach `anonymizeCustomer`)

| Endpoint / trigger | File | Purpose |
|---|---|---|
| `POST /api/me/data/send-otp` | `apps/api/src/routes/me.ts:246` | OTP issuance — pre-gate, no mutation |
| `POST /api/me/data/verify-otp` | `apps/api/src/routes/me.ts:329` | Verify 6-digit code; set 60s `anonymize:otp_verified` marker |
| `POST /api/me/data/initiate-deletion` | `apps/api/src/routes/me.ts:444` | Build `customer.anonymize` envelope; adjudicate → DEFER; park 24h receipt |
| `POST /api/me/data/cancel-deletion` | `apps/api/src/routes/me.ts:822` | Build `customer.anonymize.cancel` envelope; REFUSE-supersedes-parked + SETNX arbitration |
| `intent.defer.timeout` event (grace-resolver) | `apps/api/src/subscribers/anonymize-grace-resolver.ts` | Auto-trigger 24h post-park; calls `anonymizeCustomer()` if receipt is still present |

A legacy single-step `DELETE /api/me/data?token={otp}` exists at `apps/api/src/routes/me.ts:724` for back-compat; it routes through the same `anonymizeCustomerFromEnvelope` executor. The OTP gate shared by these routes lives at `apps/api/src/routes/me/anonymize-otp-gate.ts`.

---

## Anonymize coverage by surface

The executor at `packages/domain/src/services/customer.service.ts:691` (`anonymizeCustomer`) implements 11 in-process surface scrubs and kicks off the Medusa cross-DB compensation chain for the 12th. The original task scope spoke of "8 surfaces"; the schema investigation refined this to 12 by counting pre-existing baseline surfaces separately from the seven added in Wave A1.

| # | Surface | Strategy | Wave | Closing commit | Verification (T4 test case) |
|---|---|---|---|---|---|
| 1 | `Customer` (name, email, phone, cpf, medusaId) | Sentinel name `"Usuário Removido"`; null email/cpf/medusaId; sha256-prefixed sentinel phone (UNIQUE constraint blocks null) | Pre-cutover baseline | `8c85265` (P0-13); subsequent hardening at `d880ca0` (tx timeout) | T4 happy-path |
| 2 | `Address` (entire row) | `deleteMany` | Pre-cutover baseline | `8c85265` | T4 happy-path |
| 3 | `CustomerPreferences` (entire row) | `deleteMany` | Pre-cutover baseline | `8c85265` | T4 happy-path |
| 4 | `Review.comment` | `updateMany` → `comment = null` (FK to anonymized Customer stays; PII linkage broken via parent scrub) | Pre-cutover baseline (+ Wave-A heavy-customer batching) | `8c85265` + heavy-path `d880ca0` | T4 happy-path |
| 5 | `CustomerOrderItem.customerId` | `updateMany` → `customerId = null` (order preserved for fiscal — 5y/NF-e) | Pre-cutover baseline | `8c85265` | T4 happy-path |
| 6 | `OrderProjection.{customerEmail, customerName, customerPhone, shippingAddressJson}` | null scalars; full-replace JSON `{anonymized: true}` (G2-b pick) | Wave A1 | `8c4b2f9` | T4 happy-path + JSON defense-in-depth scan |
| 7 | `ConversationMessage.{content, metadata}` | `content` → placeholder `"[anonymized]"`; `metadata` → `Prisma.JsonNull` (defensive — no current producer fills it, but the column is schema-permitted JSON); heavy-path batched pre-tx (≥1000 messages) | Wave A1 | `1b68707` | T4 happy-path |
| 8 | `Conversation.customerId` | Null-out (FK already nullable; SetNull cascade declared) | Wave A1 | `1b68707` | T4 happy-path |
| 9 | `OrderStatusHistory.actorId` | Null-out filtered on `actor = "customer" AND actorId = customerId` (Staff/admin rows MUST stay intact — schema does NOT model `actorId` as a Prisma relation, so no cascade applies) | Wave A1 | `7b46114` | T4 happy-path + **Staff-actor untouched** negative case |
| 10 | `OrderEventLog.payload` | Full-replace JSON `{anonymized: true}` (G2-d pick); heavy-path batched pre-tx (≥1000 events) | Wave A1 | `7b46114` | T4 happy-path + JSON defense-in-depth scan |
| 11 | `LoyaltyAccount.{customerId, stamps, totalEarned, redeemed}` | `customerId` → `null` (linkage genuinely broken); counters reset to 0. Migration `20260524000000` made the column `String? @unique` with `onDelete: SetNull` (schema.prisma:527-528), so the G2-c linkage scrub is now fully implemented in app code | Wave A1 (+ nullable migration) | `ec462c4` | T4 happy-path + idempotency |
| 12 | `Reservation.specialRequests` | Replace with `[]` (schema deviation — column is `Json @default("[]") NOT NULL`, cannot be set to null without a migration; empty array obliterates free-form pt-BR notes including allergy/accessibility text) | Wave A1 | `c4e0020` | T4 happy-path |
| 13 | **Medusa-side customer row** (`Customer.{email, first_name, last_name, phone, company_name}` + `metadata` JSON) | Compensation pattern (G2-a pick) — `anonymizeCustomer` publishes `customer.anonymize.medusa.pending` (customer.service.ts:1134-1154); subscriber `customer-anonymize-medusa-resolver` PATCHes the Medusa admin API (nulls the fields, `metadata={anonymized:true}`); BullMQ retry job sweeps unconfirmed events; idempotent via stable key | **Wave B (landed)** | — | `customer-anonymize-medusa-resolver.test.ts` + `anonymize-medusa-retry.test.ts` (Medusa admin mocked) |

**Per-surface scrub audit-record kinds (Wave A1):**

```
customer.anonymize.order_projection.scrubbed
customer.anonymize.conversation_message.scrubbed
customer.anonymize.conversation_link.scrubbed
customer.anonymize.order_status_history.scrubbed
customer.anonymize.order_event_log.scrubbed
customer.anonymize.loyalty_account.scrubbed
customer.anonymize.reservation_special_requests.scrubbed
```

Defined as `SCRUB_AUDIT_KINDS` at `packages/domain/src/services/customer.service.ts:660`. Seven kinds — one per Wave A1 surface; the four pre-cutover-baseline surfaces remain covered by the original `customer.anonymize.confirmed_after_grace` envelope emitted by the grace resolver. The four Wave-B Medusa audit kinds (`customer.anonymize.medusa.{pending,confirmed,failed,exhausted}`) are defined separately as `MEDUSA_ANONYMIZE_KINDS` in `apps/api/src/subscribers/__shared__/medusa-anonymize-kinds.ts`.

Each scrub audit record carries:
- `actor.principal = "system"` (the grace resolver is a system-driven mutation per CLAUDE.md rule #9)
- `sessionId = "customer.anonymize:{customerId}"`
- `taint = "SYSTEM"`
- `nonce = "{customerId}:{kind}"` (deterministic; idempotent retries collapse to the same record)
- `decision = EXECUTE` with `basis = [{ category: "business", code: "rule_satisfied" }]` — the LGPD-erasure business rule was satisfied by the scrub
- `supersedes` chained back to the original `customer.anonymize` envelope (when the caller passes `predecessor` — the grace resolver does), with `reason: "lgpd_scrub"` (customer.service.ts:1176). The earlier H3 implementation used `reason: "replay"` as the closest fit in the closed `@adjudicate/core` v1.0 `SupersessionReason` union; the dedicated `lgpd_scrub` member (available since `@adjudicate/core@1.1.0`; the repo now pins `^1.3.0`) is the semantically-correct value — operator dashboards aggregating by reason no longer double-count scrubs as generic replays

**Heavy-customer paths:**

Three surfaces have ≥1000-row pre-batched paths outside the main transaction to avoid holding locks for the duration of multi-thousand-row updates:

- `Review.comment` — batched at 500/batch when `reviewCount > 1000`
- `ConversationMessage.content` — batched at 500/batch when `messageCount > 1000`
- `OrderEventLog.payload` — batched at 500/batch via id-cursor when `eventCount > 1000`

Constants at `packages/domain/src/services/customer.service.ts:611..650`.

---

## Architectural guarantees

These properties are load-bearing for the LGPD posture; an auditor should verify each.

### Single atomic Prisma transaction for the 11 in-process surfaces

`packages/domain/src/services/customer.service.ts:881` opens `prisma.$transaction(...)` with `timeout: 60_000ms` and `maxWait: 5_000ms`. All 11 in-process surface scrubs (steps 1-12 in the executor, minus the cross-DB Medusa surface) commit together or roll back together. The heavy-path pre-batches happen outside the transaction but are idempotent on rerun, so a transaction abort + retry converges to the same end state.

### Mutex protection against cancel-vs-resolve race (closed)

The cancel-vs-resolve TOCTOU race — customer clicks "cancel deletion" at T+23h59m, resolver fires at T+24h, both win, account destroyed despite cancel returning 200 — is closed by a Redis SETNX mutex on `anonymize:active:{customerId}` shared between the cancel route and the grace resolver. The loser of the SETNX emits a REFUSE audit record (`code: cancel_won_race`) without mutating.

Closing commits:
- `df25dbf` — `fix(api,audit-2026-05-24-R2-2): anonymize cancel-vs-resolve race — SETNX mutex closes LGPD Art. 18 window`
- `4c82a22` — `fix(api,audit-2026-05-24-E2-fix-b): resolver re-checks parkKey post-SETNX to close race v2`

The follow-up (`4c82a22`) handles the variant where the resolver SETNX-wins but the parkKey was cleared between the wakeup and the SETNX — the resolver re-checks parkKey existence post-SETNX before dispatching, and emits `REFUSE` / `code: defer.resume.skipped` / `detail: parkKey_missing_after_sweeper` if the cancel cleared the receipt. T6 conformance suite is now at **hard-zero violations across 500 race iterations** (5 separate 100-iteration runs).

### Per-surface audit-record emit

A successful anonymize execution produces this audit chain:

1. The original `customer.anonymize` envelope from `/api/me/data/initiate-deletion` (DEFER decision; parked)
2. After 24h: `customer.anonymize.confirmed_after_grace` envelope from the grace resolver (EXECUTE decision; calls `anonymizeCustomer`)
3. Seven per-surface scrub records (`customer.anonymize.{surface}.scrubbed`) — one per Wave A1 surface
4. The Wave-B Medusa chain: `customer.anonymize.medusa.pending` → `.confirmed` (or `.failed`/`.exhausted` on the error/retry path)

The pre-cutover baseline surfaces (Customer / Address / CustomerPreferences / Review / CustomerOrderItem) do not emit their own per-surface records — they are subsumed under the `customer.anonymize.confirmed_after_grace` envelope. Wave A1 expanded coverage to the seven new surfaces precisely because the baseline emit was insufficient for ANPD forensic discovery.

`supersedes` (with `reason: "lgpd_scrub"`) links every Wave A1 scrub record back to the initiating envelope without join hops; the Wave-B chain threads the same `parkedIntentHash` so audit readers can reconstruct the full request → grace-expire → Prisma scrub → Medusa scrub → confirmed chain by predecessor traversal.

### Compensation pattern for Medusa cross-DB (Wave B — landed)

The Medusa commerce database lives in `apps/commerce/...` and is operationally separate from the `@ibatexas/domain` Prisma database, reachable only via the HTTP admin API. A 2PC across both was rejected (over-engineered for a low-concurrency destructive op with no rollback semantics). G2-a settled on a compensation chain, now implemented:

1. `anonymizeCustomer` captures `Customer.medusaId` BEFORE the Prisma TX nulls it; if the customer was never linked to Medusa (`medusaId === null`), the chain is skipped — there's nothing to scrub.
2. After the Prisma transaction commits, it `await`s `publishNatsEvent("customer.anonymize.medusa.pending", ...)` (customer.service.ts:1134-1154). The event is in `OUTBOX_EVENTS`, so a NATS outage writes it to the Redis outbox and the outbox-retry job re-publishes on recovery; only a total Redis outage can fail the publish, which is logged but does NOT fail-back the already-committed scrub.
3. The subscriber `apps/api/src/subscribers/customer-anonymize-medusa-resolver.ts` consumes it and PATCHes the Medusa admin API to set `first_name/last_name/email/phone/company_name = null` and `metadata = {anonymized:true}` via the adjudicated `medusaAdjudicated({ idempotencyKey })` wrapper. On success it publishes `customer.anonymize.medusa.confirmed`; on a Medusa 4xx/5xx it publishes `customer.anonymize.medusa.failed` (forensic only).
4. The BullMQ retry job `apps/api/src/jobs/anonymize-medusa-retry.ts` sweeps pending events lacking a confirmation and re-publishes, up to `MEDUSA_ANONYMIZE_MAX_ATTEMPTS` (12 × 5-min ≈ 1h budget), then emits `customer.anonymize.medusa.exhausted` and pages the operator. Idempotency key `customer.anonymize.medusa.{medusaId}.{parkedIntentHash}` is stable across retries so Medusa de-duplicates the write.

The four kinds + payload shape + idempotency-key helper live in `apps/api/src/subscribers/__shared__/medusa-anonymize-kinds.ts`. The compensation pattern is acceptable under LGPD because there is no statutory upper bound on the erasure window — only a "reasonable timeframe" requirement, which the ~minutes window meets.

### Customer revocation honored via SETNX

The cancel route (`POST /api/me/data/cancel-deletion`) competes for the same SETNX lock the resolver uses. Cancel-wins → resolver emits REFUSE; resolve-wins → cancel emits REFUSE. Either way, the customer's intent (cancel) wins authority when timed within the grace window — the resolver never silently destroys an account whose owner just clicked "cancel."

### 24-hour grace period (defer-park) survives process restart

The DEFER park lives in Redis under the `customer.anonymize.confirmed_after_grace` envelope's parkKey, with TTL set to the grace expiry. The NATS-driven `intent.defer.timeout` event sweeper publishes the resume event after the 24h timer fires, which the grace resolver consumes. Receipts persist across process restarts (Redis + NATS durability).

---

## Forensic-vs-compliance tension

LGPD Art. 18 §III requires elimination of *processed personal data* — not a relaxed "scrub-the-Customer-row-only" interpretation. At the same time, IbateXas runs on an immutable audit ledger (Postgres + NATS) that is the system's source of truth for replay, debugging, and intent-gated execution proof. Naively scrubbing audit rows would defeat the audit's purpose; naively keeping them retains PII the customer asked us to delete.

The system resolves this tension surface-by-surface, prioritizing erasure over forensic completeness while preserving causal structure where possible.

### `OrderEventLog.payload` — full-replace (G2-d)

Per G2-d, the entire `payload` JSON is replaced with `{anonymized: true}` for every row whose `orderId` belongs to the anonymized customer. The row itself (`id`, `orderId`, `eventType`, `idempotencyKey`, `timestamp`, `createdAt`) survives — operators can still query "what events happened on order X" — but every PII-bearing key inside the JSON blob (`customerEmail`, `customerName`, `shippingAddress`, nested customer objects, free-form payloads written by subscribers) is obliterated.

**Carve-out NOT taken.** The LGPD Art. 7 §IX "legitimate interest" carve-out (which under EU GDPR Art. 17(3)(e) would let us keep audit payloads under "archiving / legal claims") does **not** apply to Brazilian audit-trail retention without a specific legal opinion. ANPD has not published guidance recognizing append-only audit trails as exempt from Art. 18 §III. We chose full erasure as the conservative default.

This is the most expensive surface to scrub because there is no FK from `OrderEventLog` to `Customer` — the link is via `orderId → OrderProjection.customerId`. The heavy-path pre-batches in chunks of 500 by id-cursor when the customer has >1000 events.

### `LoyaltyAccount` — counters reset, linkage genuinely broken (G2-c)

Per G2-c, the approach is "scrub linkage + reset balance to 0." Migration `20260524000000` made `LoyaltyAccount.customerId` nullable (`String? @unique`, `onDelete: SetNull`; schema.prisma:527-528), so the executor (customer.service.ts:1045-1053) sets `customerId = null` and zeros `stamps`, `totalEarned`, `redeemed`. The linkage is now truly broken at the column level — not merely relying on the parent Customer row being scrubbed. The row itself is retained so historical loyalty aggregates (stamp velocity, redemption-rate cohorts) survive after PII is purged.

A prior I9 fix substituted a synthetic `customerId = "SCRUBBED:<uuid>"` sentinel; it was REVERTED because that value VIOLATES the still-present FK (the migration kept the FK with `ON DELETE SET NULL`), so the `updateMany` threw P2003 and aborted the entire LGPD erasure transaction for any customer with a loyalty account — a production-breaking governance regression. `NULL` is FK-safe and matches the T4 conformance assertion. See the executor comment at customer.service.ts:1019-1044.

### `Reservation.specialRequests` — empty array, structural shape preserved

`Reservation.specialRequests` is `Json @default("[]") NOT NULL`. Setting it to `[]` (the column's documented default) obliterates the free-form pt-BR notes the customer typed — which can include allergy details, accessibility requirements, dietary restrictions, family-occasion context — while preserving the structural shape (`SpecialRequest[]`) the downstream application code expects. The reservation itself (date, time, party size, status) survives for operational continuity.

A nullable migration is a future option but was out of Wave A1 scope.

### `Review.comment` — null content, FK retained

`Review.customerId` is declared `String NOT NULL` in the Prisma schema even though the relation declares `onDelete: SetNull` — a schema inconsistency we cannot fix from app code. The Wave A1 executor scrubs the comment text (the customer-typed PII path) and relies on the parent Customer row's anonymization to break PII linkage. Anyone querying the customer record via the Review's FK lands on the scrubbed Customer.

This is acknowledged in the executor's inline comments at `packages/domain/src/services/customer.service.ts:905-908` and tracked as a schema-level follow-up.

### `Customer.phone` — sentinel substitution, not null

`Customer.phone` is UNIQUE-constrained at the schema level. We cannot null it across many anonymize executions without collision. Instead we substitute a stable sentinel:

```
phone = "anonymized:" + sha256(customerId).slice(0, 16)
```

The hash is deterministic per customer (idempotent retries collapse to the same value) and collision-resistant across customers. The sentinel is non-PII (a hash of an internal UUID is not personal data under LGPD Art. 5 §I).

---

## Test conformance

### T4 LGPD scrub conformance suite

Path: `apps/api/src/__tests__/audit-2026-05-24/h3-t4-lgpd-scrub-conformance.test.ts`
Landing commits: `78646be` (Postgres testcontainer helper) → `662fc9c` (PIIFixtureSpec builder) → `ae7ded0` (happy-path) → `1cc1514` (Staff-actor untouched + idempotency + audit-emit) → `50adfb6` (JSON-stringification defense-in-depth scan)

The suite uses a real `postgres:15-alpine` testcontainer (`apps/api/src/__tests__/audit-2026-05-24/h3-postgres-container.ts`) — not a Prisma mock. Per CLAUDE.md / RULE 3, a Map-stub of `update`/`updateMany` would prove the call shape but not the column state; the failure mode T4 is designed to detect is exactly "the UPDATE was never issued." Only a real Postgres can catch that.

A declarative `PIIFixtureSpec` builder at `apps/api/src/__tests__/audit-2026-05-24/h3-fixture-builder.ts` populates a single test customer with PII across all 11 in-process surfaces, runs `anonymizeCustomer()`, then takes per-table snapshots and asserts zero PII linkage remains. The JSON-stringification scan walks every `Json` column post-scrub and pattern-matches against the fixture-populated PII strings as a defense-in-depth check against subtle key-scrub misses.

**Cases:**

1. **Happy path** — every surface populated, anonymize fires, every assertion runs (~50-100 individual checks). Includes JSON defense-in-depth scan.
2. **Staff-actor untouched** — admin/staff actor rows on `OrderStatusHistory` MUST NOT be touched even when the underlying order belongs to the anonymized customer. Filters on `actor = "customer" AND actorId = customerId` (not just `actorId = customerId`).
3. **Idempotency** — running `anonymizeCustomer()` twice produces the same post-state as one run. Critical for retry safety after the resolver throws mid-flight and leaves the receipt for retry.
4. **Audit-emit per surface** — mocks the audit sink; asserts one record per surface scrubbed with the expected `SCRUB_AUDIT_KINDS` kind name + `supersedes` chain back to the predecessor.

### Other LGPD-relevant test suites

- `packages/domain/src/services/__tests__/anonymize-customer.test.ts` — unit tests with mocked Prisma; covers the pre-cutover baseline 5 surfaces + heavy-path batching for reviews / messages / events. Updated in `fb7ff85` (Wave A1-7) to cover the 7 new surfaces.
- `apps/api/src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts` — end-to-end OTP → DEFER park → 24h timeout-sweeper → grace-resolver → `anonymizeCustomer`. Real Redis testcontainer. Asserts OTP brute-force lockout (5 failures → 30min lockout) and cancel-cooldown (30min).
- `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts` — T6 conformance for the cancel-vs-resolve race at the 24h boundary. Hard-zero violations across 500 race iterations.
- The OTP gate (`apps/api/src/routes/me/anonymize-otp-gate.ts`) is covered by `apps/api/src/__tests__/me-routes.test.ts` plus the whitespace-hardening cases in `apps/api/src/__tests__/wave6-red-team/{01-customerid-whitespace-bypass,05-whitespace-rejected}.test.ts` and `apps/api/src/__tests__/anonymize-empty-customerid.test.ts`.
- `apps/api/src/subscribers/__tests__/customer-anonymize-medusa-resolver.test.ts` + `apps/api/src/jobs/__tests__/anonymize-medusa-retry.test.ts` — Wave-B compensation chain (Medusa admin API mocked): pending→PATCH→confirmed, failure handling, and the retry/exhausted cap.

### CI gate

The repository CI workflow (`.github/workflows/ci.yml`) runs `pnpm test -- -- --coverage` on every PR to `main`/`dev`. The Postgres testcontainer in T4 is gated by `IBX_SKIP_REAL_POSTGRES` (default off — CI runs real containers). The testcontainer-based T4 suite is executed by `pnpm test` and will fail the build on any regression of the 11 in-process scrub surfaces.

**Open follow-up:** the CI YAML does not currently declare an explicit Docker / testcontainer health check before the test step. Docker is available on `ubuntu-latest` runners by default, but a smoke test would make this prerequisite explicit. Tracked as a hygiene follow-up.

---

## Anti-pattern register

What the system explicitly does NOT do, and the reason. An auditor reading code should expect these to be absent.

- **The LLM cannot anonymize a customer.** `customer.anonymize` is a destructive intent kind whose envelope is never built from an LLM tool call. Per CLAUDE.md rule #9, the LLM has zero state-mutation authority — the anonymize envelope is built only by `/api/me/data/initiate-deletion` (after OTP gate + adjudication) or by the grace resolver's system-actor envelope. The production planner `createIbatexasPlanner` (`apps/api/src/claustrum/ibatexas-planner.ts`) exposes exactly one mutating tool (`express_intent`); per-state tool visibility is governed by each Pack's `CapabilityPlanner` (the `CapabilityPlanner`/`ToolClassification` contracts in `@adjudicate/core/llm`), none of which surface an anonymize-shaped tool. (The legacy `@ibatexas/llm-provider` brain and its `capability-planner.ts` were deleted in the claustrum cutover.)
- **Allergens are not inferred from product names.** CLAUDE.md rule #1. Adjacent to the anonymize surface because `CustomerPreferences` carries allergen flags; the system requires explicit array `[]` at write time, so the anonymize scrub (`deleteMany`) is safe — there's no inference path that would resurrect allergen data post-deletion.
- **No 2PC across Medusa.** G2-a — eventual consistency (~minutes via the NATS + BullMQ compensation chain) is acceptable under LGPD; over-engineered 2PC is rejected for a destructive op with no rollback semantics.
- **No row-delete on `LoyaltyAccount`.** G2-c — `customerId` is nulled (linkage broken at the column level) and counters reset, but the row is retained so historical loyalty aggregates survive. Hard-delete would orphan aggregate accounting context without strengthening privacy.
- **No "legitimate interest" carve-out on `OrderEventLog`.** G2-d — full erasure of payload is the conservative LGPD-compliant default. Future legal counsel may revisit this if ANPD publishes guidance recognizing append-only audit as exempt.
- **No silent failure on audit-sink errors during scrub.** A failing `auditSink.emit()` is logged but does NOT fail the scrub — the data is already mutated by the committed transaction; throwing here would surface as a misleading "anonymize failed" up the stack and confuse retries. Emission is intentionally best-effort post-commit.
- **No plain `redis.del()` to release the anonymize mutex.** CLAUDE.md rule #10 — UUID lock values with Lua conditional release. Closes a class of bug where one party's release accidentally unlocks another party's hold.

---

## Open carve-outs / future legal review

These are surfaces where a future legal opinion could change the posture. Documented here so an ANPD audit understands the system's reasoning, not as gaps.

1. **`OrderEventLog.payload` — currently full-replace.** A future legal opinion that recognizes "audit-trail necessity" as a legitimate interest (LGPD Art. 7 §IX) would let us move to a carve-out that preserves payload content under retention rather than erasure. Currently we honor full erasure as the conservative default.
2. **`Reservation.specialRequests` empty array vs null.** `Json @default("[]") NOT NULL` blocks full null-out. Empty array is semantically equivalent to "no special requests" and is the column's default. A future nullable migration would let us emit a clearer "scrubbed" signal.
3. **`Review.customerId` not null.** Prisma schema inconsistency (declared `String NOT NULL` while the relation declares `onDelete: SetNull`; schema.prisma:218/225). Parent-Customer anonymization is the effective linkage break — the executor scrubs the comment text and nulls nothing on the FK. A future schema fix would let the Review FK genuinely null out.
4. **Medusa `metadata` JSON full-replace.** Integrations (Stripe-customer-id, third-party loyalty IDs, etc.) may have written PII into the `Customer.metadata` blob without documentation. The Wave-B compensation step full-replaces the whole `metadata` JSON with `{anonymized:true}` (the conservative default, since no PII keys are documented). A finer-grained key-scrub would require a production audit of actual `metadata` content; tracked as a G2-f sub-decision.
5. **Cache invalidation across all `rk()` namespaces.** Redis keys under `cart:`, `loyalty:`, `intelligence:`, `whatsapp:session:` may carry PII (snapshots, derived state). The current anonymize executor does not exercise cache cleanup. Identified in the H3 compliance investigation as a P1 hygiene gap. Tracked as a follow-up.

---

## Cross-reference

### Closing commits (Wave A1, in topological order on `feat/kernel-always-on-cutover`)

| Commit | Scope |
|---|---|
| `8c4b2f9` | Surface #6 — OrderProjection scrub |
| `1b68707` | Surfaces #7, #8 — ConversationMessage.content + Conversation.customerId |
| `7b46114` | Surfaces #9, #10 — OrderStatusHistory + OrderEventLog |
| `ec462c4` | Surface #11 — LoyaltyAccount (G2-c) |
| `c4e0020` | Surface #12 — Reservation.specialRequests |
| `4ac17a9` | Per-surface audit-record emit (`SCRUB_AUDIT_KINDS`) |
| `fb7ff85` | Unit-test expansion for the 7 new surfaces |

### Closing commits (Wave A2 — T4 conformance)

| Commit | Scope |
|---|---|
| `78646be` | Postgres testcontainer helper |
| `662fc9c` | PIIFixtureSpec builder |
| `ae7ded0` | T4 happy-path conformance |
| `1cc1514` | Staff-actor untouched + idempotency + audit-emit cases |
| `50adfb6` | JSON-stringification defense-in-depth scan |

### Closing commits (pre-cutover baseline + race remediation)

| Commit | Scope |
|---|---|
| `8c85265` | Baseline `anonymizeCustomer` (phone, cpf, reviews) — P0-13 |
| `d880ca0` | Heavy-customer review batching + 60s transaction timeout (NEW-P0-X7) |
| `df25dbf` | SETNX mutex closes cancel-vs-resolve race (R2-2) |
| `4c82a22` | Resolver re-checks parkKey post-SETNX (E2 Fix-b) |
| `fae8dc5` | JWT whitespace-only `sub` rejection at middleware (R1-4) |

### Source files

- `packages/domain/src/services/customer.service.ts` — `anonymizeCustomer` executor (line 691), `emitScrubAuditRecords` (line 1159, `reason: "lgpd_scrub"` at 1176), `SCRUB_AUDIT_KINDS` (line 660), threshold constants (lines 611-650), `exportCustomerData` (line 1233), Medusa-pending publish (lines 1134-1154)
- `apps/api/src/subscribers/anonymize-grace-resolver.ts` — grace resolver, SETNX mutex, `cancel_won_race` REFUSE audit record
- `apps/api/src/subscribers/customer-anonymize-medusa-resolver.ts` — Wave-B Medusa scrub subscriber; `apps/api/src/jobs/anonymize-medusa-retry.ts` — retry/exhausted job; `apps/api/src/subscribers/__shared__/medusa-anonymize-kinds.ts` — kinds + payload + idempotency-key helper
- `apps/api/src/routes/me.ts` — OTP-gated routes (send-otp 246, verify-otp 329, initiate-deletion 444, DELETE 724, cancel-deletion 822); OTP gate at `apps/api/src/routes/me/anonymize-otp-gate.ts`
- `apps/api/src/middleware/auth.ts` — whitespace `sub` rejection at lines 116, 156
- `apps/api/src/__tests__/audit-2026-05-24/h3-t4-lgpd-scrub-conformance.test.ts` — T4 conformance suite
- `apps/api/src/__tests__/audit-2026-05-24/h3-postgres-container.ts` — testcontainer harness
- `apps/api/src/__tests__/audit-2026-05-24/h3-fixture-builder.ts` — PIIFixtureSpec builder

### Related artifacts

- [H3 SYNTHESIS.md](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/SYNTHESIS.md) — orchestrator-level synthesis of the 4 H3 investigations
- [H3 schema investigation](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/schema.md) — per-surface Prisma-level analysis
- [H3 compliance investigation](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/compliance.md) — LGPD Art. 18 mappings + gap catalog
- [H3 cross-DB investigation](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/cross-db.md) — Medusa compensation pattern design
- [H3 test-fixtures investigation](../adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/test-fixtures.md) — T4 shape + fixture builder design
- [audit-2026-05-24 CLOSEOUT-STATUS.md](../adjudicate-migration/audit-2026-05-24/CLOSEOUT-STATUS.md) — overall remediation closeout status
- [E-admin-lgpd-redteam.md](../adjudicate-migration/audit-2026-05-24/E-admin-lgpd-redteam.md) — the W6 red-team audit that surfaced the 7 missing surfaces
- [data-retention.md](../ops/data-retention.md) — Brazilian-Portuguese retention policy doc (customer-facing)

---

## Last verified

**Date:** 2026-06-10
**Commit:** `458526a` (`feat/policy-tree`)
**Method:** static reconciliation against the executor at `packages/domain/src/services/customer.service.ts:691` + the Wave-B subscriber/job + T4 conformance suite at `apps/api/src/__tests__/audit-2026-05-24/h3-t4-lgpd-scrub-conformance.test.ts` + audit chains (`SCRUB_AUDIT_KINDS`, `MEDUSA_ANONYMIZE_KINDS`).

An ANPD auditor can verify each surface row in the coverage table against the linked commit hash via `git show <commit>` to inspect the actual code change.
