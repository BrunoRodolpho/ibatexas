# 04 Audit: Data Layer & Schema Integrity

## Executive Summary

The data layer is well-structured with appropriate separation between the `ibx_domain` Prisma schema and Medusa's schema. Price fields correctly use integer centavos (`Int`), allergens are explicit arrays, and the Prisma client singleton pattern prevents connection exhaustion. However, **three critical/high issues** threaten data integrity under concurrency:

1. **[C] TOCTOU race condition in reservation creation** — availability check and counter increment are not atomic, allowing double-booking under concurrent requests.
2. **[C] Cascade delete from TimeSlot destroys Reservations** — deleting a time slot silently deletes all associated reservations, with no guard at the application layer.
3. **[H] Review model has dual productId / productIds fields with incomplete migration** — queries may return inconsistent data; legacy `productIds` array is never cleaned up.

Additionally, `reservedCovers` has no database-level constraint preventing negative values, `startTime` is stored as a string instead of a time type, and several N+1 query patterns exist in the reservation availability check.

---

## Scope

- Prisma schema: `packages/domain/prisma/schema.prisma` (12 models, 2 enums)
- Domain services: 7 files in `packages/domain/src/services/`
- TypeScript types: `packages/types/src/` (product, reservation, cart, intelligence, admin)
- Seed scripts: 5 files in `packages/domain/src/`
- Design docs: `docs/design/domain-model.md`, `docs/design/bounded-contexts.md`
- Migration history: No `migrations/` directory found (schema likely applied via `prisma db push`)

---

## System Invariants (Must Always Be True)

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Prices are ALWAYS integer centavos (never floats) | PASS — `priceInCentavos Int`, `feeInCentavos Int` throughout |
| 2 | Allergens are ALWAYS explicit arrays (never inferred) | PASS — `allergenExclusions String[]` with explicit `[]` defaults in service layer |
| 3 | Foreign key references are always valid (no orphaned records) | PARTIAL — `Reservation.customerId` has no FK relation to `Customer`; it references a Medusa customer ID |
| 4 | Cascade deletes never destroy business-critical data | FAIL — `TimeSlot → Reservation` cascade (see Finding F-01) |
| 5 | Schema matches design docs | PARTIAL — drift on Customer model (see Finding F-06) |

---

## Assumptions That May Be False

| # | Assumption | Evidence For | Evidence Against | Risk if Wrong |
|---|-----------|-------------|-----------------|---------------|
| A1 | `reservedCovers` accurately reflects active reservations | Incremented/decremented in transactions | TOCTOU race in `create()` — check is outside transaction (line 225-234) | Double-booking; overbooking a time slot |
| A2 | `reservedCovers` can never go negative | Code always decrements by `partySize` | No CHECK constraint at DB level; concurrent cancel+no_show on same reservation could double-decrement | Negative counter = phantom "available" covers |
| A3 | Review.productId migration from productIds is complete | New reviews write both fields | Legacy reviews may have `productId: null`; `aggregateAll()` filters `productId: { not: null }` | Legacy reviews invisible to aggregation; incorrect rating averages |
| A4 | `prisma db push` is the migration strategy | No `migrations/` directory exists | No migration history = no audit trail, no rollback capability | Schema drift between environments; data loss on destructive changes |
| A5 | Reservation.customerId always refers to a valid Customer | Service layer passes authenticated customerId | No FK from Reservation to Customer; orphaned reservations if Customer deleted | Ownership checks silently pass for deleted customers |
| A6 | TimeSlot deletion is an admin-only operation | No public API for deleting time slots | No application-layer guard; cascade deletes all reservations | Customer reservations silently destroyed |

---

## Findings

### F-01 [C] CRITICAL: TOCTOU Race Condition in Reservation Creation

**File:** `packages/domain/src/services/reservation.service.ts:225-263`

**Evidence:**
```
// Line 225-234: Availability check OUTSIDE transaction
const slot = await prisma.timeSlot.findUnique({ where: { id: input.timeSlotId } })
const availableCovers = slot.maxCovers - slot.reservedCovers
if (availableCovers < input.partySize) { throw ... }
const tableIds = await assignTables(input.timeSlotId, input.partySize)

// Line 243-263: Counter increment INSIDE transaction
const reservation = await prisma.$transaction(async (tx) => {
  // ...create reservation...
  await tx.timeSlot.update({
    where: { id: input.timeSlotId },
    data: { reservedCovers: { increment: input.partySize } },
  })
})
```

**Blast Radius:** Two concurrent requests for the last 2 covers on a slot with `maxCovers=52, reservedCovers=50`:
- Request A reads `availableCovers = 2`, passes check
- Request B reads `availableCovers = 2`, passes check
- Both enter `$transaction` and increment → `reservedCovers = 54` (overbooking by 2)

**Time to Failure:** First busy Friday night with concurrent WhatsApp + web reservations for the same popular slot.

**Production Simulation:** Two users simultaneously booking the last dinner slot via WhatsApp and web respectively. Both succeed; restaurant is overbooked.

**Fix:** Move the availability check + `assignTables()` inside the transaction, or use a database-level `CHECK (reserved_covers <= max_covers)` constraint, or use `SELECT ... FOR UPDATE` on the time slot row.

---

### F-02 [C] CRITICAL: Cascade Delete from TimeSlot Destroys Reservations

**File:** `packages/domain/prisma/schema.prisma:97`

**Evidence:**
```prisma
// Reservation model:
timeSlot   TimeSlot @relation(fields: [timeSlotId], references: [id], onDelete: Cascade)
```

Also cascades to Waitlist (line 132):
```prisma
// Waitlist model:
timeSlot   TimeSlot @relation(fields: [timeSlotId], references: [id], onDelete: Cascade)
```

**Blast Radius:** If an admin deletes a TimeSlot (e.g., via raw SQL, future admin UI, or a bug in slot regeneration), ALL reservations and waitlist entries for that slot are silently deleted. Customers who have confirmed reservations receive no notification; the data is gone.

**Time to Failure:** First time anyone deletes or regenerates time slots for a date range that has active reservations.

**Production Simulation:** Admin runs `ibx db seed:domain` on a production database that already has reservations. The `createMany` with `skipDuplicates` would not delete existing slots, but any manual cleanup or regeneration would.

**Fix:** Change to `onDelete: Restrict` for both Reservation and Waitlist relations to TimeSlot. Application code should handle slot deletion by first checking for active reservations.

---

### F-03 [H] HIGH: Review Model Dual-Field Inconsistency (productIds / productId)

**File:** `packages/domain/prisma/schema.prisma:147-148`

**Evidence:**
```prisma
productIds String[] @map("product_ids") // legacy: multiple product ids
productId  String?  @map("product_id")  // primary product this review is for
```

In `review.service.ts:41-47`, the aggregation logic filters on the new field:
```typescript
async aggregateAll() {
  return prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { not: null } },
    // ...
  })
}
```

In `customer.service.ts:76-88`, new reviews write BOTH fields:
```typescript
create: {
  productId,
  productIds: [productId],
  // ...
}
```

**Blast Radius:** Any legacy reviews with `productId: null` but valid `productIds[]` are excluded from rating aggregation. Product ratings displayed on the homepage and in Typesense may be inaccurate (undercounting reviews).

**Time to Failure:** Already happening if any reviews were created before the `productId` field was added. Seed data writes both fields, so only real user data from the pre-migration period is affected.

**Fix:** Run a data migration to backfill `productId` from `productIds[0]` for all rows where `productId IS NULL AND product_ids != '{}'`. Then remove the legacy `productIds` field or mark it deprecated with a plan to drop.

---

### F-04 [H] HIGH: No CHECK Constraint on reservedCovers — Can Go Negative

**File:** `packages/domain/prisma/schema.prisma:69`

**Evidence:**
```prisma
reservedCovers  Int      @default(0) @map("reserved_covers")
```

No database-level constraint. The decrement operations in:
- `cancel()` at line 350: `reservedCovers: { decrement: reservation.partySize }`
- `transition('no_show')` at line 375: `reservedCovers: { decrement: reservation.partySize }`

If a reservation is both cancelled AND marked as no_show (due to a race between a cron job and a user cancellation), `reservedCovers` decrements twice.

**Blast Radius:** Negative `reservedCovers` would cause `availableCovers = maxCovers - reservedCovers` to return MORE than `maxCovers`, making the system believe there are phantom available seats.

**Time to Failure:** A customer cancels their reservation at almost exactly the 15-minute no-show window. The cron job and the cancel API race.

**Fix:** Add a raw SQL migration: `ALTER TABLE ibx_domain.time_slots ADD CONSTRAINT reserved_covers_non_negative CHECK (reserved_covers >= 0)`. Also add application-level guard in `cancel()` and `transition()` to check current status before decrementing.

---

### F-05 [M] MEDIUM: N+1 Query Pattern in checkAvailability

**File:** `packages/domain/src/services/reservation.service.ts:107-153`

**Evidence:**
```typescript
for (const slot of slots) {
  // For EACH slot, two additional queries:
  const reservedTableIds = await prisma.reservationTable.findMany({...}) // Query per slot
  const freeTables = await prisma.table.findMany({...})                  // Query per slot
}
```

For a date with 8 time slots (4 lunch + 4 dinner), this generates 1 + (8 * 2) = 17 queries.

**Blast Radius:** Slow response times on availability checks, especially when WhatsApp bot queries for a full day. Database connection pool pressure under concurrent requests.

**Time to Failure:** Noticeable latency on busy days; could compound with connection pool limits if many users check availability simultaneously.

**Fix:** Pre-fetch all reservationTables and free tables for the entire date in two queries, then compute availability in-memory.

---

### F-06 [M] MEDIUM: Schema vs Design Doc Drift

**File:** `packages/domain/prisma/schema.prisma` vs `docs/design/domain-model.md` and `docs/design/bounded-contexts.md`

| Entity | Design Doc Says | Schema Has | Gap |
|--------|----------------|------------|-----|
| Customer.source | Not in domain-model.md | `source String?` (schema line 176) | Doc outdated |
| Customer.firstContactAt | Not in domain-model.md | `firstContactAt DateTime?` (schema line 177) | Doc outdated |
| Review.productId | Not in domain-model.md entity map | `productId String?` (schema line 148) | Doc shows only `productIds[]` |
| TimeSlot.reservedCovers | Not in domain-model.md entity map | `reservedCovers Int` (schema line 69) | Doc omits this critical counter |
| Staff entity | bounded-contexts.md section 5 lists `Staff` | Not in Prisma schema | Entity not yet implemented |
| CustomerProfile.type | bounded-contexts.md says `type: customer/staff` | Not in CustomerPreferences model | Staff distinction not modeled |
| DeliveryZone field naming | domain-model.md says `deliveryFee` | Schema says `feeInCentavos` | Naming inconsistency |

**Blast Radius:** New developers building features from design docs will make incorrect assumptions about the data model.

---

### F-07 [M] MEDIUM: startTime Stored as String Instead of Time Type

**File:** `packages/domain/prisma/schema.prisma:66`

**Evidence:**
```prisma
startTime       String   // '19:30'
```

Postgres has a native `TIME` type. Storing as String means:
- No database-level validation (accepts `"99:99"` or `"abc"`)
- No native time arithmetic (cannot use `startTime + interval '90 min'` in SQL)
- Sorting works only because the format is consistent (HH:MM), but there's no constraint enforcing format

**Blast Radius:** Low risk today (all writes go through application layer which validates format), but prevents using database-level time operations for future features (overlapping slot detection, gap analysis).

---

### F-08 [M] MEDIUM: Reservation.customerId Has No FK to Customer

**File:** `packages/domain/prisma/schema.prisma:86`

**Evidence:**
```prisma
model Reservation {
  customerId      String            @map("customer_id")
  // ... no @relation to Customer
}
```

Compare with `Review` which DOES have a Customer relation (line 156). Also `Waitlist.customerId` (line 127) has no FK.

**Blast Radius:** If a Customer is deleted, their Reservations and Waitlist entries become orphaned. `assertOwnership()` would still check against the `customerId` string, but the customer no longer exists. No referential integrity guarantee.

**Why it matters:** With `Address.onDelete: Cascade` and `CustomerPreferences.onDelete: Cascade`, deleting a Customer cleans up those relations. But Reservation and Waitlist silently remain with a dangling `customerId`.

---

### F-09 [L] LOW: No Migration History — Using `prisma db push`

**File:** `packages/domain/prisma/migrations/` — directory does not exist

**Evidence:** No `migrations/` directory found. Schema is likely applied via `prisma db push`, which:
- Has no audit trail of schema changes
- Cannot roll back destructive changes
- May silently drop columns/tables if a field is removed from schema.prisma
- No way to verify that staging and production schemas match

**Blast Radius:** A developer removes a field from schema.prisma and runs `prisma db push` → data loss for that column in that environment. No way to detect schema drift between environments.

**Fix:** Transition to `prisma migrate dev` / `prisma migrate deploy` workflow.

---

### F-10 [L] LOW: Cascade Delete on Customer → Address and CustomerOrderItem

**File:** `packages/domain/prisma/schema.prisma:204, 239`

**Evidence:**
```prisma
// Address
customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

// CustomerOrderItem
customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
```

Deleting a Customer cascades to:
- All Addresses (acceptable — personal data cleanup)
- All CustomerOrderItems (problematic — these power the co-purchase matrix and analytics)
- CustomerPreferences (acceptable — personal data cleanup)

The comment on `CustomerOrderItem` (schema line 228) explicitly says: "Not deleted on order cancellation (needed for analytics)." Yet the cascade on Customer delete WILL delete these records.

**Blast Radius:** If a customer requests account deletion (LGPD compliance), their entire order history used for intelligence/recommendations is destroyed.

**Fix:** Change `CustomerOrderItem.customer` to `onDelete: SetNull` to preserve analytics data after customer deletion, consistent with how `Review` already uses `onDelete: SetNull`.

---

### F-11 [L] LOW: assignTables() Called Outside Transaction in create()

**File:** `packages/domain/src/services/reservation.service.ts:235`

**Evidence:**
```typescript
const tableIds = await assignTables(input.timeSlotId, input.partySize) // Outside $transaction

const reservation = await prisma.$transaction(async (tx) => {
  // Creates reservation with tableIds determined above
})
```

`assignTables()` queries current table availability, but by the time the transaction creates the `ReservationTable` rows, another concurrent request may have assigned the same tables.

**Blast Radius:** Two reservations could be assigned the same physical table for the same time slot. The `ReservationTable` composite key `(reservationId, tableId)` prevents duplicate assignment within a single reservation, but does NOT prevent the same `tableId` being used across different reservations for the same slot.

**Fix:** Move `assignTables()` logic inside the transaction. Add a unique constraint or application-level check that prevents a table from being assigned to multiple active reservations in the same time slot.

---

### F-12 [L] LOW: specialRequests Stored as JSON with String Default

**File:** `packages/domain/prisma/schema.prisma:89`

**Evidence:**
```prisma
specialRequests Json              @default("[]") @map("special_requests")
```

The JSON column accepts any valid JSON. The application layer uses a Zod schema (`SpecialRequestSchema`) to validate input, but there's no guarantee that data already in the database conforms to the `SpecialRequest` interface (especially seed data — see `seed-orders.ts:480` which passes `JSON.stringify(template.specialRequests)` where `specialRequests` is `string[]`, not `SpecialRequest[]`).

**Blast Radius:** The `toDTO()` mapper casts `r.specialRequests` as `SpecialRequest[]` (line 48). If seed data or legacy data is `string[]` instead, the DTO will have wrong shape, potentially crashing consumers that expect `.type` and `.notes` fields.

---

## Cross-Agent Findings

### XF: Three-Layer customerId Defense Failure (security-auditor + ai-agent-auditor + data-layer-auditor)

All three layers that could validate `customerId` on reservation operations are broken or absent:

| Layer | Component | Finding | Effect |
|-------|-----------|---------|--------|
| 1. Auth middleware | `apps/api/src/middleware/auth.ts:44-51` | security-auditor F-03: `requireAuth` calls `done()` after 401 but handler continues | Route handler executes with `customerId = undefined` |
| 2. Tool registry | `withCustomerId` wrapper | ai-agent-auditor XF-04: LLM-supplied `customerId` passed without verifying match to `ctx.customerId` | Cross-user data access via agent tools |
| 3. Database | `packages/domain/prisma/schema.prisma:86` | data-layer F-08: No FK on `Reservation.customerId` | DB accepts any string including non-existent customers |

**Combined attack surface:** An unauthenticated request passes through the broken auth middleware with `customerId = undefined`. The agent tool layer does not override with the session's real customerId. The database writes a reservation with whatever value was supplied (or `undefined`/arbitrary string) because no FK constraint rejects it. The minimum fix is at the tool layer (XF-04, 1-line change); the defense-in-depth fix adds the FK constraint at the DB layer.

### From security-auditor (Wave 1)
- **requireAuth middleware calls `done()` after 401 but route handler still executes** — DB writes happen for unauthenticated requests. This compounds F-08 (no FK on Reservation.customerId): an unauthenticated request could create reservations with arbitrary customerId values.

### From ai-agent-auditor (Wave 1)
- **withCustomerId passes through LLM-supplied customerId without verifying it matches ctx.customerId** — cross-user data access possible on reservation tools. This compounds F-01 (TOCTOU race): a malicious LLM-supplied customerId could exploit the race window to create reservations under another customer's identity.

### From redis-auditor (Wave 2)
- **`customer:recentlyViewed:{customerId}` Redis list has no TTL** — `cart-intelligence.ts:196-198` does `LPUSH` + `LTRIM` but never calls `EXPIRE`, despite docs claiming 7-day TTL. Every customer who views a product creates an immortal key. Data layer relevance: the profile hydration path in `get-customer-profile.ts` reads from the `customer:profile:{customerId}` hash (which has TTL), but the separate `recentlyViewed` list is orphaned and grows unbounded. This creates an inconsistency where the profile hash expires and is re-hydrated from Postgres (via `CustomerService.getProfileData()`), but the stale `recentlyViewed` list persists indefinitely with potentially outdated product IDs. Documented as C-02 in `docs/audit/05-redis-state-management.md`.
- **Cancel + no-show race double-counts profile counters** — Confirmed that availability data is NOT cached in Redis (reservation tools query Prisma directly), so the negative `reservedCovers` issue from F-04 does not propagate to Redis availability state. However, the customer profile hash tracks `reservationCount`, `cancellationCount`, and `noShowCount` via `hIncrBy` (`cart-intelligence.ts:278, 310, 325`). If the cancel + no-show race from F-04 fires both NATS events (`reservation.cancelled` AND `reservation.no_show`) for the same reservation, both subscribers increment their respective counters, inflating the profile stats. Low severity (informational counters, not decision-making), but corrupts intelligence data used for customer insights.

---

## Recommendations Summary

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| P0 | F-01: Fix TOCTOU race in reservation create | 2-4h | Prevents overbooking |
| P0 | F-02: Change TimeSlot→Reservation to onDelete: Restrict | 30min | Prevents silent data loss |
| P1 | F-03: Backfill productId from productIds, plan to deprecate | 1-2h | Accurate product ratings |
| P1 | F-04: Add CHECK constraint on reserved_covers >= 0 | 30min | Prevents phantom seats |
| P1 | F-10: Change CustomerOrderItem onDelete to SetNull | 30min | Preserves analytics on customer deletion |
| P2 | F-05: Fix N+1 in checkAvailability | 1-2h | Performance improvement |
| P2 | F-06: Update design docs to match schema | 1h | Developer onboarding |
| P2 | F-08: Add FK from Reservation to Customer | 1h | Referential integrity |
| P2 | F-11: Move assignTables inside transaction | 1h | Prevents double table assignment |
| P3 | F-07: Consider migrating startTime to time type | 2h | Better DB-level validation |
| P3 | F-09: Transition to prisma migrate workflow | 2-4h | Migration audit trail |
| P3 | F-12: Validate specialRequests JSON shape | 1h | Data consistency |
