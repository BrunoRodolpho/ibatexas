# H3 — LGPD anonymize scope expansion

**Status:** 🚧 GATED on G2 epic-start authorization. Do NOT spawn implementation agent before decision.
**Severity:** P0-9 — ANPD non-compliance under LGPD Art. 18.
**Closes:** the audit-2026-05-24 finding that 8 surfaces retain PII after `anonymizeCustomer` runs.
**Unblocks:** T4 (LGPD scrub conformance suite).

---

## Objective

Extend `packages/domain/src/services/customer.service.ts:591` `anonymizeCustomer(customerId)` so that all customer-linkable PII is scrubbed across the 8 enumerated surfaces. Add a contract test that snapshots every table reachable from `customerId` and asserts post-anonymize zero rows match the pre-anonymize PII fixtures.

## Live state (verified 2026-05-24 post-R3)

`anonymizeCustomer` currently scrubs only:
1. `Customer` row — `name` / `email` / `phone` / `cpf` / `medusaId`
2. `Address.deleteMany({where: {customerId}})`
3. `CustomerPreferences.deleteMany({where: {customerId}})`
4. `Review.comment` scrub (heavy-customer + core paths)

The cancel-vs-resolve race (`anonymize:active:` SETNX mutex) and the audit-record emit are both already in place from R2-2 and R1-3 respectively — those are NOT part of this task.

## Surfaces to extend coverage to

| # | Surface | Field(s) carrying PII | Approach |
|---|---|---|---|
| 1 | `OrderProjection` | `customerEmail`, `customerName`, `customerPhone`, `shippingAddressJson` | `updateMany` — substitute / null per field; full-replace JSON with `{anonymized: true}` |
| 2 | `ConversationMessage` | `content` (free-form pt-BR customer text) | `updateMany` set `content = "[anonymized]"` |
| 3 | `Conversation` | `customerId` (FK to soon-anonymized row) | `updateMany` set `customerId = null` IF schema allows; else leave the FK pointing at the anonymized profile row (which is already scrubbed) — confirm schema |
| 4 | `OrderStatusHistory` | `actorId` (FK to Customer when actor was the customer) | `updateMany` set `actorId = null` where it matches `customerId` AND the actor-type column (if present) is "customer" |
| 5 | `OrderEventLog` | `payload` JSON (may carry name/email/phone) | `updateMany` set `payload = JSON_BUILD_OBJECT('anonymized', true)` for rows where `actorId = customerId` — confirm via schema review |
| 6 | `LoyaltyAccount` | customer-linked balance + history | Confirm with stakeholder: scrub balance? Or delete + emit a `loyalty.account.anonymized` event? |
| 7 | `Reservation` | `specialRequests` (free-form pt-BR) | `updateMany` set `specialRequests = null` |
| 8 | **Medusa-side customer row** | cross-DB; `apps/commerce/` Medusa Customer row + addresses + orders metadata | Compensation pattern with retry job (see G2 default recommendation) — or 2PC if user prefers stronger guarantees |

## Sub-decisions for G2

### a. Medusa-side cross-DB scrub

- **Compensation (recommended):** emit `customer.anonymize.medusa.pending` envelope after the Prisma TX commits; a new subscriber consumes it, runs the Medusa-side scrub, emits a `customer.anonymize.medusa.confirmed` audit record. Retry job picks up pending entries after N minutes. Eventually consistent.
- **2PC alternative:** wrap both DBs in a distributed transaction. Requires shared transaction coordinator; significantly higher complexity.

### b. `OrderProjection.shippingAddressJson` strategy

- **Full-replace (recommended):** replace with `{anonymized: true}`. Loses the structure but is simple and verifiable.
- **Key-scrub:** walk the JSON and null specific keys. Preserves the structure but adds parsing complexity and a schema-drift risk.

### c. `LoyaltyAccount` policy

- Pure data retention question — needs stakeholder input from product / legal. Default: scrub `customerId` linkage and reset balance to zero; keep aggregate stats for accounting.

## Acceptance criteria

- `anonymizeCustomer` extended to scrub all 8 surfaces per chosen approaches.
- Cross-DB Medusa scrub implemented per G2-a decision; if compensation, the new subscriber + retry job are wired and tested.
- T4 conformance suite added: a single fixture customer with PII populated in every reachable table, run `anonymizeCustomer`, assert zero PII rows remain via per-table queries.
- Audit record emit extends `customer.anonymize.execute` to a sub-record per surface OR a single record with a `scrubbed: [list]` array — pick one and document.
- ANPD compliance checklist refresh — adjacent doc update (e.g. `docs/compliance/lgpd-anonymize-coverage.md`) listing every surface and the proof.
- Existing tests (incl. R2-2 race tests) still pass.
- Commits follow the `fix(...,audit-2026-05-24-H3-N): ...` convention; one per surface where practical (allows incremental review).

## Required tests

- Per-surface unit test: populate the surface, anonymize, assert scrubbed.
- T4 LGPD scrub conformance — snapshot-based: pre-anonymize fixtures via factory, post-anonymize assertion. Run against a real Postgres testcontainer (NOT mocks — per the existing test discipline for Prisma race tests).
- Cross-DB compensation test (G2-a): if compensation chosen, assert the eventual-consistency guarantee with a real Medusa testcontainer or a stub Medusa client.

## Observability

- Add a metric counting per-surface scrub counts (for ops visibility): `lgpd.anonymize.surface.{name}.rows_scrubbed`.
- Operator runbook update: anonymize replay command + how to verify a specific customer was fully scrubbed across both DBs.

## Rollback

- Hard rollback (PR revert): in-flight anonymize calls running against the new extended scope continue to completion via the existing code; nothing structurally breaks. New anonymize calls revert to scrubbing the original 4 surfaces. **Operational impact:** customers anonymized post-rollback will have PII residue again — flag the rollback to ANPD compliance team if it persists more than 24h.

## Dependencies

- Independent of H2 (different code paths).
- Blocks T4 LGPD scrub conformance suite.
- Stakeholder gating: `LoyaltyAccount` policy (G2-c) needs product / legal input.

## Ready-to-spawn sub-agent prompt

> You are the H3 LGPD anonymize epic agent. Approach decisions made by user: G2-a = compensation pattern + retry job; G2-b = full-replace shippingAddressJson; G2-c = scrub customerId linkage + reset balance to zero. Implement per `docs/adjudicate-migration/audit-2026-05-24/tasks/h3-lgpd-anonymize-scope-expansion.md`. Hard requirements: (1) extend `anonymizeCustomer` at `packages/domain/src/services/customer.service.ts:591` to cover all 8 surfaces; (2) wire the new `customer.anonymize.medusa.pending` subscriber + retry job in `apps/api/src/subscribers/` and `apps/api/src/jobs/`; (3) emit per-surface audit sub-records; (4) add T4 conformance suite per [hardening-conformance-followup.md](./hardening-conformance-followup.md) using a real Postgres testcontainer; (5) update `docs/compliance/lgpd-anonymize-coverage.md` (create if missing). Repo conventions: pt-BR for user-facing copy, Redis locks always use UUID + Lua conditional release, ESM `.js` extensions, vitest, no comments unless WHY is non-obvious. Commit per surface where logical; ~6-12 commits expected. Run `pnpm typecheck` for api + domain. Run T4 conformance test against the testcontainer; assert all 8 surfaces show zero PII rows post-anonymize. **If the schema disagrees with the surface enumeration (e.g. `Conversation.customerId` is not actually nullable), STOP and report up before mutating the schema.**

*Substitute alternative G2 picks accordingly.*

## Risk classification

- **Blast radius:** high (destructive customer-data ops; ANPD compliance)
- **Reversibility:** zero on already-anonymized customers (irreversible by design)
- **Replay impact:** required for forensic reconstruction of anonymize chain
- **Deployment risk:** medium-high — cross-DB scrub introduces eventual-consistency window; needs careful runbook
