-- NEW-035 — Ingredient recipe/BOM + per-dish COGS (extends NEW-003). Three changes:
--   1. ingredients: add a per-unit cost column (money = integer centavos).
--   2. recipes: a bill-of-materials header, one per Medusa finished-good.
--   3. recipe_ingredients: the BOM lines (recipe ⋈ ingredient + per-batch quantity).
-- The order-flow depletion subscriber (consume ingredients on order.placed) is
-- DEFERRED — not part of this migration.

-- AlterTable: ingredients — per-unit purchase cost in INTEGER CENTAVOS of ONE whole
-- `unit` (e.g. cost of 1 kg). NULLABLE: an ingredient with no cost set is EXCLUDED
-- from COGS (its recipe line is flagged, contributes 0) — COGS is never guessed.
ALTER TABLE "ibx_domain"."ingredients" ADD COLUMN "cost_centavos_per_unit" INTEGER;

-- CreateTable: recipes (NEW-035 — a bill-of-materials for ONE Medusa finished-good.
-- `medusa_product_id` is a SOFT reference — products are Medusa-managed, so the
-- domain DB holds only the id (UNIQUE → one recipe per product). `yield` is the
-- servings/units one batch produces, the divisor for per-serving COGS. Admin-ops
-- reference/config data, manager-gated; plain CRUD, no kernel.)
CREATE TABLE "ibx_domain"."recipes" (
    "id" TEXT NOT NULL,
    "medusa_product_id" TEXT NOT NULL,
    "yield" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one recipe per finished-good (soft reference to the Medusa product).
CREATE UNIQUE INDEX "recipes_medusa_product_id_key" ON "ibx_domain"."recipes"("medusa_product_id");

-- CreateIndex: active-recipe reads.
CREATE INDEX "recipes_active_idx" ON "ibx_domain"."recipes"("active");

-- CreateTable: recipe_ingredients (NEW-035 — one BOM line: a recipe consumes
-- `qty_milli` of an ingredient per batch. `qty_milli` is a SCALED INTEGER in
-- THOUSANDTHS of the ingredient's unit (milli-units), same idiom as
-- ingredients.stock_milli: 2.5 kg → 2500. Integer arithmetic — never a float.)
CREATE TABLE "ibx_domain"."recipe_ingredients" (
    "id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "qty_milli" INTEGER NOT NULL,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: an ingredient appears at most once per recipe.
CREATE UNIQUE INDEX "recipe_ingredients_recipe_id_ingredient_id_key" ON "ibx_domain"."recipe_ingredients"("recipe_id", "ingredient_id");

-- CreateIndex: reverse lookup — "which recipes use this ingredient" (also backs the
-- onDelete Restrict check when removing an ingredient).
CREATE INDEX "recipe_ingredients_ingredient_id_idx" ON "ibx_domain"."recipe_ingredients"("ingredient_id");

-- AddForeignKey: line → recipe, ON DELETE CASCADE (deleting a recipe removes its BOM).
ALTER TABLE "ibx_domain"."recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "ibx_domain"."recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: line → ingredient, ON DELETE RESTRICT (can't delete an ingredient
-- still used in a recipe).
ALTER TABLE "ibx_domain"."recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ibx_domain"."ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
