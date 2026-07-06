-- CreateTable: staff_shifts (NEW-016 escala core — one scheduled work shift per
-- staff member. Assign shifts to staff + list the schedule over a date range.
-- Admin-ops data, manager-gated; plain CRUD. Clock-in + labor-cost analytics are
-- deliberately OUT of scope. FK → staff(id) ON DELETE CASCADE: removing a staff
-- member removes their schedule (mirrors addresses / customer_preferences →
-- customers).)
CREATE TABLE "ibx_domain"."staff_shifts" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: per-staff schedule, chronological (the "this employee's shifts" read).
CREATE INDEX "staff_shifts_staff_id_starts_at_idx" ON "ibx_domain"."staff_shifts"("staff_id", "starts_at");

-- CreateIndex: restaurant-wide schedule board over a date range.
CREATE INDEX "staff_shifts_starts_at_idx" ON "ibx_domain"."staff_shifts"("starts_at");

-- AddForeignKey
ALTER TABLE "ibx_domain"."staff_shifts" ADD CONSTRAINT "staff_shifts_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "ibx_domain"."staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
