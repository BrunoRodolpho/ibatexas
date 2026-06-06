# WS-1 — Schema migration: `Customer.lastCustomerMessageAt`

**Wave:** 1 (foundation)
**Status:** GATED on stakeholder pick of open questions 1, 8.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Alternative B — Postgres-backed materialized view" + §"Schema migration".

---

## Objective

Add a single nullable `lastCustomerMessageAt` column to the `Customer` Prisma model so the recommended Alternative B (Postgres-backed projection) has a durable place to materialize the "when did the customer last message us via WhatsApp" timestamp. Forward-only migration; existing customer rows start with `NULL` and are populated on next inbound message (write side wires in WS-2; backfill is WS-13).

## Blocking design-doc picks

- **Q1 (Join axis: `phoneHash` or `customerId`?)** — recommended default is `customerId`; **this task assumes that pick**. If stakeholder picks `phoneHash` (i.e., they want Alternative A's keying despite recommending Alternative B), this task is rewritten or replaced.
- **Q8 (Future channel extension: keep `lastCustomerMessageAt` specific now vs. generalize to `lastInboundAt` per-channel)** — recommended default is "keep specific now". If stakeholder picks "generalize", the column name/shape changes (e.g., JSON map of `{ "whatsapp": Date, "sms": Date }` or a sibling table `CustomerChannelState`).

## Impacted files

- [`packages/domain/prisma/schema.prisma`](../../../../../packages/domain/prisma/schema.prisma) — `Customer` model around line 555+ (sibling to existing nullable timestamp fields).
- [`packages/domain/prisma/migrations/`](../../../../../packages/domain/prisma/migrations/) — new migration directory `YYYYMMDDHHMMSS_customer_last_customer_message_at/migration.sql`.
- [`packages/domain/src/types.ts`](../../../../../packages/domain/src/types.ts) (or wherever the `Customer` type is re-exported) — Prisma client regen will surface the new field; downstream type imports may need updates if any consumer mocks the shape.

## Dependencies

- **None.** This task is foundation — every other WS-N task downstream needs the column to exist.

## Acceptance criteria

- New column declared as `lastCustomerMessageAt DateTime? @map("last_customer_message_at")` (nullable).
- Forward migration created via `pnpm --filter @ibatexas/domain prisma migrate dev --name customer_last_customer_message_at --create-only` and reviewed before apply.
- Migration SQL is idempotent (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` or equivalent shape); the column is added with no default and no NOT NULL constraint.
- Prisma client regenerated (`pnpm --filter @ibatexas/domain prisma generate`).
- No write-path code changes in this task — pure schema + client. WS-2 hooks the writes.
- No index on the column — the read path queries by `Customer.id` (already PK-indexed); the column is a projection target not a query predicate.

## Test strategy

- No new behaviour tests in this task — it's a schema-only change.
- Verify Prisma client typechecks: `pnpm --filter @ibatexas/domain tsc --noEmit`.
- Verify the migration applies cleanly against a fresh dev DB: `ibx db reset && ibx db migrate`.
- Verify schema-shape baseline tests (if present in `packages/domain/__tests__/`) still pass.

## Rollout notes

- The column ADD is online-safe in Postgres (no rewrite for nullable columns without defaults).
- Coordinate the deploy so WS-2 (writer) lands in the SAME deploy or the immediate-next deploy — otherwise the column sits unwritten and every read returns `NULL` (the conservative-REFUSE default).
- The migration can land in production with zero downtime; it does not block any other migration in flight.

## Rollback notes

- Forward-only by convention (no DROP COLUMN). If the column needs to be removed (e.g., the design changes to alt A), write a new forward migration that drops it; don't `prisma migrate reset`.
- If WS-2 ships before WS-1 (operational error), WS-2 will throw on the `UPDATE` because the column doesn't exist; WS-2 must be deploy-gated behind a feature flag or a presence check.

## Merge-conflict risk

- **LOW.** Only touches `schema.prisma` (one model addition) and creates a brand-new migration directory. Won't collide with WS-3..14 because those don't touch Prisma.
- Watch for collision with other in-flight schema changes (e.g., if loyalty-fk-migration or analytics-dashboards branches add other `Customer` columns). Sequence after those if they land first.

## Ready-to-spawn sub-agent prompt

> You are the WS-1 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Add a single nullable column `lastCustomerMessageAt DateTime? @map("last_customer_message_at")` to the `Customer` Prisma model. Generate the forward migration. No write-path code, no consumer wiring — those are WS-2 and downstream tasks.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Alternative B" and §"Schema migration" fully.
> 2. Edit `packages/domain/prisma/schema.prisma` — add the field to the `Customer` model (sibling to existing nullable DateTime fields).
> 3. Generate the migration: `pnpm --filter @ibatexas/domain prisma migrate dev --name customer_last_customer_message_at --create-only`.
> 4. Review the generated SQL; ensure it is a non-blocking nullable ADD COLUMN with no default.
> 5. Run `pnpm --filter @ibatexas/domain prisma generate`.
> 6. Verify `pnpm --filter @ibatexas/domain tsc --noEmit` passes.
>
> **Hard stops:**
> - If schema.prisma already has a column with the name, STOP and report the collision.
> - If the migration SQL has anything other than `ADD COLUMN`, STOP.
> - Do NOT add an index. Do NOT add a default. Do NOT make it NOT NULL.
>
> **Commit:** `feat(domain,whatsapp-state-builder): add Customer.lastCustomerMessageAt nullable column`
>
> **Out of scope:** writer logic (WS-2), helper module (WS-3), backfill (WS-13).

## Estimated complexity

**XS** — single column addition + migration scaffold. ~30 min of work.
