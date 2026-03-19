# Phase 1: Data Layer & Schema Integrity Fixes

**Audit report:** `docs/audit/04-data-layer-schema.md`
**Date:** 2026-03-18
**Status:** All assigned findings fixed

---

## Fixes Applied

### 1. CRITICAL DL-F01: TOCTOU Race Condition in Reservation Creation

**File:** `packages/domain/src/services/reservation.service.ts`

**Problem:** Availability check (findUnique + reservedCovers comparison) and `assignTables()` ran OUTSIDE the `$transaction` callback. Two concurrent requests could both pass the availability check and overbook a time slot.

**Fix:** Restructured `create()` so the entire flow runs inside a single Prisma interactive transaction:
1. `SELECT ... FOR UPDATE` locks the time slot row
2. Availability check runs under the lock
3. `assignTables()` runs inside the transaction (also fixes DL-F11)
4. Reservation is created
5. `reservedCovers` is incremented
6. Transaction commits

Imported `Prisma` (for `Prisma.sql` tagged template) and `PrismaClient` type. Added `TxClient` type alias for the transaction client.

### 2. CRITICAL DL-F02: Cascade Delete from TimeSlot Destroys Reservations

**File:** `packages/domain/prisma/schema.prisma`

**Problem:** `onDelete: Cascade` on Reservation -> TimeSlot and Waitlist -> TimeSlot meant deleting a TimeSlot silently destroyed all reservations and waitlist entries.

**Fix:** Changed both relations to `onDelete: Restrict`:
- `Reservation.timeSlot` (was line 97)
- `Waitlist.timeSlot` (was line 132)

Application code must now explicitly handle or check for active reservations before deleting a time slot.

### 3. HIGH DL-F04: No CHECK Constraint on reservedCovers

**Migration:** `packages/domain/prisma/migrations/20260318_audit_fix_check_constraints/migration.sql`

**Problem:** No database-level constraint preventing `reservedCovers` from going negative or exceeding `maxCovers`.

**Fix:** Created SQL migration (NOT auto-run) that adds two CHECK constraints:
- `reserved_covers_non_negative`: `reserved_covers >= 0`
- `reserved_within_max`: `reserved_covers <= max_covers`

**Action required:** Run manually after review: `psql $DATABASE_URL -f migration.sql`

### 4. HIGH DL-F03: Dual-Field Inconsistency (productIds / productId in Review)

**Files:**
- `packages/domain/prisma/schema.prisma` (deprecation comment)
- `packages/domain/prisma/migrations/20260318_audit_fix_review_product_id_backfill/migration.sql`

**Problem:** Legacy reviews may have `productId: null` but valid `productIds[]`, causing them to be excluded from rating aggregation.

**Fix:**
- Created SQL migration (NOT auto-run) to backfill: `UPDATE reviews SET product_id = product_ids[1] WHERE product_id IS NULL`
- Added deprecation comment on `productIds` field with a 3-step plan: backfill, stop writing, drop column

**Action required:** Run manually after review: `psql $DATABASE_URL -f migration.sql`

### 5. MEDIUM DL-F08: Reservation.customerId Has No FK to Customer

**File:** `packages/domain/prisma/schema.prisma`

**Problem:** `Reservation.customerId` was a plain string with no foreign key to `Customer`, allowing orphaned reservations.

**Fix:** Added Prisma relation `customer Customer @relation(fields: [customerId], references: [id])` on Reservation, and the inverse `reservations Reservation[]` on Customer. The `customerId` references `ibx_domain.customers.id` (same schema), not Medusa's customer table.

### 6. MEDIUM DL-F05: N+1 Query Pattern in checkAvailability

**File:** `packages/domain/src/services/reservation.service.ts`

**Problem:** For each time slot, two additional queries fetched reserved tables and free tables. A date with 8 slots generated 17 queries.

**Fix:** Replaced the per-slot loop with:
1. One bulk query for all reserved table assignments across the date's slots
2. One bulk query for all active tables
3. In-memory computation of per-slot availability

Total queries reduced from `1 + (slots * 2)` to 3.

### 7. LOW DL-F10: Cascade Delete on Customer -> CustomerOrderItem

**File:** `packages/domain/prisma/schema.prisma`

**Problem:** Deleting a Customer cascaded to all CustomerOrderItems, destroying analytics data (co-purchase matrix, recommendations).

**Fix:** Changed `CustomerOrderItem.customer` to `onDelete: SetNull`. Made `customerId` nullable (`String?` and `Customer?`) to support SetNull behavior. Preserves order history for analytics after customer deletion (LGPD compliance).

### 8. LOW DL-F11: assignTables Called Outside Transaction

**File:** `packages/domain/src/services/reservation.service.ts`

**Problem:** `assignTables()` ran outside the `$transaction` in `create()`, allowing concurrent requests to assign the same tables.

**Fix:** Resolved as part of DL-F01. The `assignTables()` function now accepts an optional `db` parameter (transaction client or default prisma) and is called inside the transaction in `create()`.

---

## Files Changed

| File | Changes |
|------|---------|
| `packages/domain/src/services/reservation.service.ts` | DL-F01, DL-F05, DL-F11 |
| `packages/domain/prisma/schema.prisma` | DL-F02, DL-F03, DL-F08, DL-F10 |

## Migrations Created (NOT auto-run)

| Migration | Finding |
|-----------|---------|
| `packages/domain/prisma/migrations/20260318_audit_fix_check_constraints/migration.sql` | DL-F04 |
| `packages/domain/prisma/migrations/20260318_audit_fix_review_product_id_backfill/migration.sql` | DL-F03 |

## Test Results

```
packages/tools/src/reservation/ — 8 files, 53 tests passed
packages/tools/src/intelligence/ — 8 files, 86 tests passed
```

All 139 tests pass with no failures.
