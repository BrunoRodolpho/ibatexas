-- NEW-034 — staff clock-in/out + per-staff hourly rate for labor-cost analytics.
-- EXTENDS NEW-016 (staff_shifts) + the staff reference table with NULLABLE columns
-- only:
--   • staff_shifts.actual_start / actual_end — the clock-in / clock-out wall stamps
--     (null until the staff clocks in / out). Cost is computed on ACTUAL hours only
--     when BOTH stamps are present for a shift, else on the SCHEDULED hours.
--   • staff.hourly_rate_centavos — per-staff pay rate in integer centavos/hour
--     (Hard Rule #2 — money is centavos, never floats). NULLABLE: a staff member
--     with no rate set is EXCLUDED from labor cost (never guessed).
--
-- Two ALTERs on EXISTING tables — NO new tables, NO index changes → NO db-tables.ts
-- registry change (the drift guard tracks Prisma `model` declarations, both of
-- which are already registered).
ALTER TABLE "ibx_domain"."staff_shifts" ADD COLUMN "actual_start" TIMESTAMP(3);
ALTER TABLE "ibx_domain"."staff_shifts" ADD COLUMN "actual_end" TIMESTAMP(3);

ALTER TABLE "ibx_domain"."staff" ADD COLUMN "hourly_rate_centavos" INTEGER;
