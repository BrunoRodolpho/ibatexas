-- CreateTable: ingredients (NEW-003 stock slice — RAW ingredients the kitchen
-- holds in stock: flour, meat, etc. that go INTO dishes. NOT a Medusa finished
-- good (whose stock is Medusa's own inventory_quantity). Tracks on-hand stock + a
-- low-stock threshold so the admin surface can raise a low-stock read.
--
-- QUANTITIES are SCALED INTEGERS in THOUSANDTHS of `unit` (milli-units): 2.5 kg →
-- stock_milli = 2500. Integer arithmetic — precise, never a float. `unit` is a
-- free-form label validated at the route.
--
-- Admin-ops reference/config data — manager-gated at the route, plain CRUD (no
-- kernel). No FK to any other domain table and no children. Recipe/BOM linkage,
-- per-dish depletion and COGS are DEFERRED (out of this slice).
CREATE TABLE "ibx_domain"."ingredients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "stock_milli" INTEGER NOT NULL DEFAULT 0,
    "low_stock_milli" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique ingredient name — reference/config data, no duplicate rows
-- (no two "Farinha de trigo" ingredients).
CREATE UNIQUE INDEX "ingredients_name_key" ON "ibx_domain"."ingredients"("name");

-- CreateIndex: active-ingredient reads — the list + low-stock scans filter on active.
CREATE INDEX "ingredients_active_idx" ON "ibx_domain"."ingredients"("active");
