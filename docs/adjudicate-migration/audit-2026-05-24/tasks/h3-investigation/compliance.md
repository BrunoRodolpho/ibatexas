# H3 Investigation — LGPD Compliance Audit

**Date:** 2026-05-24  
**Scope:** LGPD Art. 18 anonymize epic (H3)  
**Status:** Complete — 8 surfaces mapped, 5 compliance gaps identified

---

## Existing Compliance Docs

| Path | Scope | Coverage |
|------|-------|----------|
| `docs/ops/data-retention.md` | Data retention policy per LGPD Art. 18 | Enumerates 8 types (orders, profile, addresses, prefs, sessions, PostHog, reviews, WhatsApp) with 24h grace deletion model |
| `docs/architecture/decisions.md` | Cross-cutting patterns (ADR #9 Intent-Gated Execution) | No LGPD-specific ADR; governance is kernel-based not compliance-specific |
| `E-admin-lgpd-redteam.md` | W6 red-team audit (2026-05-24) | **5 bugs found**: 2 P0 (anonymize race + scope completeness), 3 P1/P2 |
| `h3-lgpd-anonymize-scope-expansion.md` | H3 epic scope + acceptance criteria | Lists 8 surfaces + G2 sub-decisions (Medusa cross-DB strategy, LoyaltyAccount policy, OrderProjection.shippingAddressJson strategy) |

**Key gaps:** No post-W4 compliance doc enumerating audit proof per surface. Data-retention.md describes POLICY but not implemented MECHANISMS.

---

## LGPD Art. 18 Sub-Rights Mapped to Code

| Sub-Right | LGPD Clause | Claim in Codebase | Implementing Path | Status |
|---|---|---|---|---|
| **Direito de acesso** (Access) | Art. 18 §I | ✅ Supported | `GET /api/me/data` → `exportCustomerData()` at `packages/domain/src/services/customer.service.ts:732` | **Verified** |
| **Direito à portabilidade** (Portability) | Art. 18 §II | ✅ Supported via access | Same as above; JSON export of all personal data | **Verified** |
| **Direito de correção** (Correction) | Art. 18 §III(i) | ⚠️ Partial | No dedicated `/api/me/update` endpoint; customer can re-authenticate and supply corrected data via separate flow (out of scope for H3) | **Out of scope** |
| **Direito à eliminação** (Deletion / Erasure) | Art. 18 §III(ii) | ✅ Claimed | Multi-step flow: `POST /api/me/data/send-otp` → `POST /api/me/data/verify-otp` → `POST /api/me/data/initiate-deletion` (parks DEFER 24h) → grace resolver calls `anonymizeCustomer()` | **Partially verified** — see gaps below |
| **Direito de revogar consentimento** (Revoke Consent) | Art. 18 §V | ✅ Via cancel | `POST /api/me/data/cancel-deletion` within 24h grace window (REFUSE-supersedes-parked pattern) | **Verified** |
| **Direito de não ser sujeito a decisão automatizada** (No automated decisions) | Art. 18 §VI | N/A | Kernel adjudication happens; no ML/scoring blocking autonomy; food reservation is UX not automated | **N/A** |

**Analysis:** Five of six applicable sub-rights claim code paths. Deletion is the focus of H3; the implementation is **incomplete at the data-surface level** (see PII inventory below).

---

## PII Classification per Surface

| # | Surface | Schema Path | PII Classes | LGPD Requirement | Implemented | Status |
|---|---|---|---|---|---|---|
| **1** | `Customer` (direct) | `model Customer {...}` | Direct: `name`, `email`, `phone`, `cpf`; Pseudo: `medusaId` | Delete all identifiers per Art. 18 §III | ✅ In `anonymizeCustomer()` — lines 666-675 | **Complete** |
| **2** | `Address` | `model Address {...}` | Direct: `street`, `number`, `cep`, `city`, etc. | Delete (no accounting use) per data-retention.md | ✅ `deleteMany({where: {customerId}})` at line 678 | **Complete** |
| **3** | `CustomerPreferences` | `model CustomerPreferences {...}` | Behavioral: allergen flags, dietary prefs | Delete (legal review re: allergen retention — resolved to DELETE) | ✅ `deleteMany({where: {customerId}})` at line 684 | **Complete** |
| **4** | `Review` | `model Review {...}` | Direct: `customerId` FK; Behavioral: `comment` (free-form text); Derived: rating, timestamps | Comment scrub + FK relinkage via nulled Customer | ✅ `comment = null` at line 701; FK via anonymized Customer row | **Partial** — FK still points to anonymized Customer, not null |
| **5** | `CustomerOrderItem` | `model CustomerOrderItem {...}` | Pseudo: `customerId` FK to Customer; Behavioral: item choices | Delink from customer (preserve order for fiscal) | ✅ `customerId = null` at line 709 | **Complete** |
| **6** | `OrderProjection` | `model OrderProjection {...}` | Direct: `customerEmail`, `customerName`, `customerPhone`, `shippingAddressJson` (full address) | **NOT scrubbed** — denormalized PII survives anonymize | ❌ **Missing** | **Gap P1** |
| **7** | `ConversationMessage` | `model ConversationMessage {...}` | Behavioral: `content` (free-form pt-BR messages, may contain name/address/CPF) | **NOT scrubbed** — chat history PII survives | ❌ **Missing** | **Gap P1** |
| **8** | `Conversation` | `model Conversation {...}` | Pseudo: `customerId` FK to Customer | Should be nulled (schema allows) | ❌ **Missing** — FK still points to anonymized Customer | **Gap P1** |
| **9** | `OrderStatusHistory` | `model OrderStatusHistory {...}` | Pseudo: `actorId` (FK to Customer when actor type = "customer") | **NOT scrubbed** — customer IDs as literal values in audit rows | ❌ **Missing** | **Gap P1** |
| **10** | `OrderEventLog` | `model OrderEventLog {...}` | Behavioral: `payload` JSONB (may carry customer email, name, phone, address in event payloads) | **NOT scrubbed** — JSON audit trail survives | ❌ **Missing** | **Gap P1** |
| **11** | `LoyaltyAccount` | `model LoyaltyAccount {...}` | Pseudo: `customerId` FK; Derived: `stamps`, `totalEarned`, `redeemed` | Policy TBD: scrub linkage + reset balance? Or full delete? | ⚠️ **Undefined** — G2-c decision pending stakeholder input | **Waiting decision** |
| **12** | `Reservation` | `model Reservation {...}` | Pseudo: `customerId` FK; Behavioral: `specialRequests` JSONB (free-form notes, may contain name/dietary/family info) | **NOT scrubbed** — specialRequests text survives | ❌ **Missing** | **Gap P1** |
| **13** | **Medusa Commerce** | `apps/commerce/...` (cross-DB) | Direct: Medusa `Customer.{email, first_name, last_name, phone}`; Orders metadata | **NOT scrubbed** — entirely outside IBX anonymize scope | ❌ **Missing** (compensation pattern required per H3 epic, G2-a) | **Gap P1 + Design** |

**Summary:** 13 surfaces enumerated. **6 surfaces COMPLETE** (Customer, Address, Preferences, OrderItem, legacy DELETE, OTP gate). **7 surfaces INCOMPLETE** (OrderProjection, ConversationMessage, Conversation FK, OrderStatusHistory, OrderEventLog, Reservation, Medusa). **1 UNDEFINED** (LoyaltyAccount policy).

---

## Forensic-vs-Compliance Tension

### The Tradeoff

LGPD Art. 18 §III requires **eliminação dos dados pessoais tratados** (deletion of processed personal data). Forensic investigation of anonymize chains requires **immutable audit trails** that carry the original state.

**Current state:**
- `OrderEventLog` is declared **append-only-immutable** (schema line 411-412) — never mutated after INSERT.
- `OrderStatusHistory` audit rows carry literal `actorId` (customer IDs as values).
- Kernel audit sinks (`@adjudicate/audit` + `@adjudicate/audit-postgres`) emit event logs carrying `actor.principal = "system"` and envelope payloads.

**Observed residue:**
- If a customer initiates anonymize at T=0, the kernel publishes `customer.anonymize.confirmed_after_grace` DEFER envelope.
- At T=24h the `intent.defer.timeout` event is published (line 73, `E-admin-lgpd-redteam.md`).
- The event carries `intentHash`, `signal`, `customerId`, `sessionId` — potentially linkable.
- If `anonymizeCustomer` throws at 90% completion, the audit trail shows the attempt; replay could expose the partial-scrub state.

**Regulatory surface:**
- An ANPD audit that queries `SELECT * FROM order_event_log WHERE payload->>'customerId' = $1` will find un-scrubbed payloads.
- Brazil's LGPD does NOT have a statutory exemption for append-only audit (unlike EU GDPR Art. 17(3)(e) "archiving, legal claims").
- The codebase claims the append-only ledger is "observability + replay" (investigation 08 P0 #2), but LGPD does not recognize "replay" as a lawful basis for retention.

**No documented resolution:** The H3 epic (h3-lgpd-anonymize-scope-expansion.md, line 556) flags this as an **open question** — "OrderEventLog payload scrubbing strategy: the table is declared append-only-immutable (line 412). LGPD compliance and append-only-audit are in tension."

---

## Anonymize-Trigger Paths

| Endpoint / Trigger | File | Route / Handler | Notes |
|---|---|---|---|
| **`POST /api/me/data/send-otp`** (step 1) | `apps/api/src/routes/me.ts:209-284` | Emit fresh Twilio Verify OTP; no mutation | Prerequisite gate |
| **`POST /api/me/data/verify-otp`** (step 2) | `apps/api/src/routes/me.ts:292-403` | Verify 6-digit code; set 60s `anonymize:otp_verified` marker | Freshness gate; rate-limit 5 failures / 30min → lockout |
| **`POST /api/me/data/initiate-deletion`** (step 3) | `apps/api/src/routes/me.ts:407-535` | Require fresh verify marker + outside cancel-cooldown; build `customer.anonymize` envelope; adjudicate (expects DEFER); park receipt in Redis | **Main trigger path** — parks envelope with 24h grace |
| **`DELETE /api/me/data?token={otpCode}`** (legacy) | `apps/api/src/routes/me.ts:544-561` | Single-step (pre-W4); kept for back-compat | Deprecated; same `anonymizeCustomerFromEnvelope` executor |
| **`POST /api/me/data/cancel-deletion`** (step 4 alt) | `apps/api/src/routes/me.ts:845-955` | Within 24h grace: build `customer.anonymize.cancel` envelope; adjudicate (REFUSE-supersedes-parked); DEL receipt + kernel envelope | Cancel/revocation path |
| **`intent.defer.timeout` event** (auto-trigger) | `apps/api/src/subscribers/anonymize-grace-resolver.ts:102-340` | Defer-timeout-sweeper publishes after 24h; grace-resolver consumes; filters on `CUSTOMER_ANONYMIZE_GRACE_SIGNAL`; calls `anonymizeCustomer()` if receipt still present | **Automated execution path** — no human re-confirmation |

**No other paths found:** Grep of `anonymizeCustomer` across the codebase finds only these 5 + 1 test path. No admin force-anonymize, no data-deletion webhook, no batch purge job.

---

## LGPD-Specific Test Coverage

| Test File | Scope | Surfaces Covered | Status |
|---|---|---|---|
| `packages/domain/src/services/__tests__/anonymize-customer.test.ts` (66-867 lines) | Unit test of `anonymizeCustomer` function | Customer, Address, Preferences, Review (comment scrub), CustomerOrderItem | ✅ Complete for 5 surfaces; mocks Prisma; covers heavy-customer path (5k+ reviews) |
| `apps/api/src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts` (865 lines) | End-to-end LGPD lifecycle (W6-1 finding) | Route → DEFER park → timeout-sweeper → grace-resolver → anonymizeCustomer | ✅ Tests T0 (verify-otp), T+1h (cancel), T+24h (resolver); real Redis testcontainer; asserts OTP brute-force (5 failures → lockout), cancel-cooldown (30min) |
| `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts` | Race condition: cancel-vs-resolve at 24h boundary | Receipt clear timing; concurrent resolver runs | ✅ Tests Bug #1 from E-admin-lgpd-redteam.md (cancel-vs-resolve TOCTOU race) |
| `apps/api/src/routes/me/__tests__/anonymize-otp-gate.test.ts` | OTP gate unit tests | Send-OTP, verify-OTP, freshness window, failure counter, lockout sentinel | ✅ Tests W7-G1 hardening (whitespace customerId trim at gate) |

**Gaps identified:**

1. **No cross-surface conformance suite (T4):** `h3-lgpd-anonymize-scope-expansion.md` line 66 requires "a single fixture customer with PII populated in every reachable table, run `anonymizeCustomer`, assert zero PII rows remain via per-table queries." This **does not exist yet**. The per-surface unit test only mocks Prisma; no end-to-end SQL validation.

2. **OrderProjection / ConversationMessage / OrderStatusHistory / OrderEventLog / Reservation not exercised:** These 5 surfaces are not present in any anonymize test. A regulator query of these tables would immediately surface non-compliance.

3. **Medusa cross-DB scrub untested:** No test harness for compensation pattern or Medusa API call. H3 epic marks this as a pending G2 decision, but no acceptance test exists yet.

4. **Cache invalidation untested:** `E-admin-lgpd-redteam.md` line 546 flags "every `rk()` namespace that may key on customerId (`cart:`, `loyalty:`, `intelligence:`, `whatsapp:session:`) and DEL" — no test exercises Redis cache cleanup on anonymize.

---

## Compliance Gaps (Summary)

| Gap # | Severity | Surface(s) | Issue | Evidence | Mitigation (H3 Acceptance) |
|---|---|---|---|---|---|
| **P1-A** | **P0** | OrderProjection | `customerEmail`, `customerName`, `customerPhone`, `shippingAddressJson` NOT scrubbed | `E-admin-lgpd-redteam.md` Bug #2, line 146-151 | UPDATE to null + JSON → `{anonymized: true}` |
| **P1-B** | **P0** | ConversationMessage | `content` (free-form pt-BR) NOT scrubbed | `E-admin-lgpd-redteam.md` Bug #2, line 153-159 | UPDATE `content = '[redacted]'` for all msgs in anonymized conversations |
| **P1-C** | **P0** | Conversation | `customerId` FK NOT nulled | `E-admin-lgpd-redteam.md` Bug #2, line 161-164 | UPDATE `customerId = null` (schema allows) |
| **P1-D** | **P0** | OrderStatusHistory | `actorId` (customer transitions) NOT scrubbed | `E-admin-lgpd-redteam.md` Bug #2, line 166-167 | UPDATE `actorId = null` where `actorId = customerId` AND actor_type = "customer" |
| **P1-E** | **P0** | OrderEventLog | `payload` JSONB NOT scrubbed; append-only tension | `E-admin-lgpd-redteam.md` Bug #2, line 170-172; open question line 556 | TBD: scrub payload keys, add indexed `customerId` column, or document as append-only exception |
| **P1-F** | **P0** | Reservation | `specialRequests` JSONB NOT scrubbed | `E-admin-lgpd-redteam.md` Bug #2, line 178-180 | SET `specialRequests = null` or `[]` |
| **P1-G** | **P0** | LoyaltyAccount | Policy undefined; DELETE vs scrub vs reset-balance | `h3-lgpd-anonymize-scope-expansion.md` G2-c | Stakeholder decision (product/legal): DELETE rows? Or scrub `customerId` + reset balance? |
| **P1-H** | **P0** | Medusa customer row | Cross-DB customer PII NOT scrubbed | `E-admin-lgpd-redteam.md` Bug #2, line 182-185; `h3-lgpd-anonymize-scope-expansion.md` surface #8 | Compensation pattern + retry job (G2-a) or 2PC (alternative) |
| **P1-I** | **P1** | Cache layers | Redis `cart:`, `loyalty:`, `intelligence:`, `whatsapp:session:` may carry PII | `E-admin-lgpd-redteam.md` line 546 (open question) | Enumerate every `rk()` namespace + DEL on anonymize |
| **P0-RACE** | **P0** | Cancel-vs-resolve TOCTOU | Customer sees "canceled" while Prisma anonymizes; account destroyed despite cancel returning 200 | `E-admin-lgpd-redteam.md` Bug #1, line 32-124; `sweeper-resolver-race.test.ts` | SETNX lock per `customerId` before resolver's Prisma TX; check lock in cancel path |
| **P0-WHITESPACE** | **P1** (defense-in-depth) | Auth middleware | `sub` empty-string-only check bypassed by whitespace; propagates to non-anonymize routes | `E-admin-lgpd-redteam.md` Bug #3, line 246-336 | Apply `.trim()` check at `middleware/auth.ts:64, 95, 127` (6-line fix) |

**Total: 10 confirmed gaps (9 compliance, 1 race/defense).** Gaps P1-A through P1-I are **required for H3 acceptance.** P0-RACE and P0-WHITESPACE are from the E-admin audit and likely already tracked as W7 remediation.

---

## Architecture & Policy Notes

### Why 8 Surfaces Matter

Brazil's LGPD Art. 18 §III uses the phrase **"eliminação dos dados pessoais tratados"** (elimination of processed personal data). It does not say "delete the Customer row" — it says delete every instance of the data subject's PII across the entire processing system.

The codebase's current `anonymizeCustomer` focuses on the Customer row + direct FKs (Address, Preferences, Review.comment). But the **denormalization pattern** (OrderProjection storing `customerName`, `customerEmail`, etc.) and the **audit-trail pattern** (OrderEventLog storing payloads) mean PII survives the "anonymize" call.

From a regulator's perspective: After `anonymizeCustomer` runs, query `SELECT customer_email FROM order_projections WHERE customer_id = $1;` and you find the original email. That's **non-compliance by the standard forensic definition.**

### Medusa Cross-DB

The H3 epic (line 35-42) documents two strategies:
1. **Compensation pattern** (recommended) — emit `customer.anonymize.medusa.pending` after main Prisma TX; a subscriber calls Medusa API; on success publishes `customer.anonymize.medusa.confirmed`. Retry job picks up pending entries after N minutes. **Eventually consistent.**
2. **2PC alternative** — wrap both DBs in distributed transaction. Higher complexity.

Neither is yet implemented. The epic marks it as a **G2 decision**, meaning stakeholder approval is required before H3 spawns an implementation agent.

### LoyaltyAccount Policy

The epic (line 49-52) flags this as a **pure data retention question** requiring stakeholder input. Two poles:
- **Delete the row entirely.** Simplest compliance path; customer loses all loyalty data. May be unacceptable to product.
- **Scrub `customerId` linkage + reset `stamps` to 0.** Keeps aggregate `totalEarned` for internal accounting; balances privacy + ops retention.

The epic recommends the second approach. It is **not yet decided** and is a prerequisite for T4 conformance suite acceptance.

### OrderEventLog Immutability

The schema (line 411-412) marks OrderEventLog as **append-only**. The codebase (anonymize-grace-resolver.ts, line 263) explicitly documents that the audit record does NOT carry PII: "payload = {customerId, scope} — NO PII. customerId is a UUID, not name/email."

However, the **OrderEventLog rows that predate anonymize** may carry customer PII in their `payload` JSONB. The current `anonymizeCustomer` does not touch them.

Two regulatory risks:
1. **Forensic SQL discovery.** ANPD auditor queries `SELECT payload FROM order_event_log WHERE payload->>'customerEmail' IS NOT NULL;` and finds residual PII.
2. **Replay integrity.** If a future audit replay reconstructs the anonymize chain, the historical payloads still carry PII — defeating the purpose of anonymize.

---

## Summary: Compliance Audit Findings

| Finding | Category | Urgency | Impact |
|---|---|---|---|
| **Missing T4 conformance test suite** | Test coverage | P1 | Cannot verify H3 acceptance without end-to-end SQL assertions across all 8 surfaces |
| **7 PII surfaces not scrubbed** (OrderProjection, ConversationMessage, Conversation, OrderStatusHistory, OrderEventLog, Reservation, Medusa) | LGPD Art. 18 §III | **P0** | Regulator audit immediately finds non-compliance; civil liability risk |
| **LoyaltyAccount policy undefined** | Design decision | P1 | Cannot accept H3 without stakeholder resolution |
| **Cancel-vs-resolve TOCTOU race** | Race condition (W7 remediation) | **P0** | Customer sees "canceled" but account is destroyed; LGPD Art. 18 §VI violation |
| **Whitespace customerId bypass at auth middleware** | Defense-in-depth (W7 remediation) | P1 | Existing gate hardening (W7-G1) does not propagate to middleware; 6-line fix required |
| **Cache invalidation untested** | Completeness | P2 | Redis keys may carry PII; no test exercises cleanup |
| **Append-only audit tension** | Regulatory interpretation | P2 | Open question: is OrderEventLog carve-out acceptable under LGPD? No documented stakeholder decision |

---

## Surprises & Red Flags

1. **No formal LGPD compliance doc post-W4:** `data-retention.md` describes policy; `E-admin-lgpd-redteam.md` identifies bugs; `h3-lgpd-anonymize-scope-expansion.md` defines epic scope. But there is **no post-implementation audit document** enumerating which surfaces are protected. Recommend: create `docs/compliance/lgpd-anonymize-coverage.md` as part of H3 acceptance criteria (line 59, h3 epic).

2. **Medusa out-of-scope by design (not by accident):** The CLAUDE.md ADR #9 + #13 discuss Intent-Gated Execution and PIX lifecycle, but do NOT explicitly state that Medusa customer rows are "acceptable residue" under LGPD. Is this a decision or an oversight? Clarify in ADR or design doc.

3. **Audit trail PII retention is a known tension, not a gap:** The codebase **documents** the append-only audit's tension with LGPD (anonymize-grace-resolver.ts line 263, data-retention.md line 8, E-admin-redteam.md line 556, h3-epic open question). This is acknowledged; a resolution path exists (scrub payload, or indexed customerId column). But stakeholder decision is **pending**.

4. **W7 remediation (Bug #1 race + Bug #3 whitespace) not yet in scope for H3:** The `E-admin-lgpd-redteam.md` report is dated 2026-05-24 (same day as H3 task file). The sweeper-resolver-race.test.ts exists but fixes may not be committed yet. Check W7 remediation status before H3 spawns.

---

## Recommendations for G2 Approval

Before spawning H3 implementation agent, confirm:

1. **LoyaltyAccount policy:** Product/legal decision on scrub-vs-delete.
2. **Medusa strategy:** Compensation + retry job (recommended G2-a) or 2PC?
3. **OrderProjection strategy:** Full-replace JSON `{anonymized: true}` (recommended G2-b) or key-scrub?
4. **Append-only audit carve-out:** Is OrderEventLog payload PII acceptable under LGPD as "append-only audit" per regulatory guidance? Or must payloads be scrubbed?
5. **W7 remediation status:** Confirm Bug #1 (cancel-vs-resolve TOCTOU) and Bug #3 (whitespace auth bypass) are committed before H3 runs; they are **interdependent** (shared SETNX lock pattern).

---

## Report Metadata

- **Audit type:** Static code review (no tests run, no DB mutations)
- **Surfaces enumerated:** 13 (8 enumerated in H3 epic + 5 discovered via Prisma schema)
- **Code paths reviewed:** 5 anonymize-trigger routes, 4 test suites, 2 key subscribers, 1 executor function
- **Compliance basis:** LGPD Lei 13.709/2018, Art. 18 (Direitos do Titular), §III (eliminação dos dados pessoais tratados)
- **Prior audit reference:** E-admin-lgpd-redteam.md (Bug #2 catalogs same 8 surfaces, identifies same 5 missing implementations)
- **Related epic:** h3-lgpd-anonymize-scope-expansion.md (lists surfaces + acceptance criteria)

