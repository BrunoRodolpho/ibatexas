-- CreateTable: daily_specials (NEW-005 — a Daily Special / promo-of-the-day: a Medusa
-- finished-good FEATURED for one restaurant business-day, optionally at a promo price
-- with a pt-BR headline. ADMIN AUTHORING SLICE — the customer-facing menu/web + chat
-- surfacing (rides grounding/claims) is DEFERRED to NEW-038; this is the manager-gated
-- authoring surface only.
--
-- `medusa_product_id` is a SOFT reference — products are Medusa-managed, so the domain
-- DB holds only the id (same idiom as recipes.medusa_product_id). `date` is the local
-- restaurant business-day (YYYY-MM-DD) this special applies, resolved in
-- RESTAURANT_TIMEZONE — a business-day LABEL, stored as TEXT (NOT a timestamp),
-- validated at the route. `promo_price_centavos` is the special price in INTEGER
-- CENTAVOS (money = integer centavos, never a float); NULL = featured, no discount.
-- `headline` is an optional pt-BR promo blurb. Admin-ops authored config —
-- manager-gated at the route, plain CRUD (no kernel). No FK to any other domain table.
CREATE TABLE "ibx_domain"."daily_specials" (
    "id" TEXT NOT NULL,
    "medusa_product_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "promo_price_centavos" INTEGER,
    "headline" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_specials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: a product is special at most once per business-day.
CREATE UNIQUE INDEX "daily_specials_medusa_product_id_date_key" ON "ibx_domain"."daily_specials"("medusa_product_id", "date");

-- CreateIndex: the today's-specials read — active specials for one business-day.
CREATE INDEX "daily_specials_date_active_idx" ON "ibx_domain"."daily_specials"("date", "active");
