-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ibx_domain";

-- CreateEnum
CREATE TYPE "ibx_domain"."TableLocation" AS ENUM ('indoor', 'outdoor', 'bar', 'terrace');

-- CreateEnum
CREATE TYPE "ibx_domain"."ReservationStatus" AS ENUM ('pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show');

-- CreateTable
CREATE TABLE "ibx_domain"."tables" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "location" "ibx_domain"."TableLocation" NOT NULL,
    "accessible" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."time_slots" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" VARCHAR(5) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 90,
    "max_covers" INTEGER NOT NULL,
    "reserved_covers" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."reservations" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "party_size" INTEGER NOT NULL,
    "status" "ibx_domain"."ReservationStatus" NOT NULL DEFAULT 'pending',
    "special_requests" JSONB NOT NULL DEFAULT '[]',
    "confirmed_at" TIMESTAMP(3),
    "checked_in_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "time_slot_id" TEXT NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."reservation_tables" (
    "reservation_id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,

    CONSTRAINT "reservation_tables_pkey" PRIMARY KEY ("reservation_id","table_id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."waitlist" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "party_size" INTEGER NOT NULL,
    "notified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "time_slot_id" TEXT NOT NULL,

    CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."reviews" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_ids" TEXT[],
    "product_id" TEXT,
    "customer_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "channel" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."customers" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "medusa_id" TEXT,
    "source" TEXT,
    "first_contact_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."addresses" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "complement" TEXT,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "cep" CHAR(8) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."customer_preferences" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "dietary_restrictions" TEXT[],
    "allergen_exclusions" TEXT[],
    "favorite_categories" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."customer_order_items" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT,
    "medusa_order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price_in_centavos" INTEGER NOT NULL,
    "ordered_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."delivery_zones" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cep_prefixes" TEXT[],
    "fee_in_centavos" INTEGER NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tables_number_key" ON "ibx_domain"."tables"("number");

-- CreateIndex
CREATE INDEX "time_slots_date_idx" ON "ibx_domain"."time_slots"("date");

-- CreateIndex
CREATE UNIQUE INDEX "time_slots_date_startTime_key" ON "ibx_domain"."time_slots"("date", "startTime");

-- CreateIndex
CREATE INDEX "reservations_customer_id_idx" ON "ibx_domain"."reservations"("customer_id");

-- CreateIndex
CREATE INDEX "reservations_time_slot_id_idx" ON "ibx_domain"."reservations"("time_slot_id");

-- CreateIndex
CREATE INDEX "reservations_status_idx" ON "ibx_domain"."reservations"("status");

-- CreateIndex
CREATE INDEX "waitlist_customer_id_idx" ON "ibx_domain"."waitlist"("customer_id");

-- CreateIndex
CREATE INDEX "waitlist_time_slot_id_idx" ON "ibx_domain"."waitlist"("time_slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_customer_id_time_slot_id_key" ON "ibx_domain"."waitlist"("customer_id", "time_slot_id");

-- CreateIndex
CREATE INDEX "reviews_customer_id_idx" ON "ibx_domain"."reviews"("customer_id");

-- CreateIndex
CREATE INDEX "reviews_order_id_idx" ON "ibx_domain"."reviews"("order_id");

-- CreateIndex
CREATE INDEX "reviews_rating_idx" ON "ibx_domain"."reviews"("rating");

-- CreateIndex
CREATE INDEX "reviews_product_id_idx" ON "ibx_domain"."reviews"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_customer_id_key" ON "ibx_domain"."reviews"("order_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "ibx_domain"."customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_medusa_id_key" ON "ibx_domain"."customers"("medusa_id");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "ibx_domain"."customers"("phone");

-- CreateIndex
CREATE INDEX "addresses_customer_id_idx" ON "ibx_domain"."addresses"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_preferences_customer_id_key" ON "ibx_domain"."customer_preferences"("customer_id");

-- CreateIndex
CREATE INDEX "customer_order_items_customer_id_product_id_idx" ON "ibx_domain"."customer_order_items"("customer_id", "product_id");

-- CreateIndex
CREATE INDEX "customer_order_items_medusa_order_id_idx" ON "ibx_domain"."customer_order_items"("medusa_order_id");

-- CreateIndex
CREATE INDEX "customer_order_items_customer_id_idx" ON "ibx_domain"."customer_order_items"("customer_id");

-- AddForeignKey
ALTER TABLE "ibx_domain"."reservations" ADD CONSTRAINT "reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."reservations" ADD CONSTRAINT "reservations_time_slot_id_fkey" FOREIGN KEY ("time_slot_id") REFERENCES "ibx_domain"."time_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."reservation_tables" ADD CONSTRAINT "reservation_tables_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "ibx_domain"."reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."reservation_tables" ADD CONSTRAINT "reservation_tables_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "ibx_domain"."tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."waitlist" ADD CONSTRAINT "waitlist_time_slot_id_fkey" FOREIGN KEY ("time_slot_id") REFERENCES "ibx_domain"."time_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."reviews" ADD CONSTRAINT "reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."addresses" ADD CONSTRAINT "addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."customer_preferences" ADD CONSTRAINT "customer_preferences_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."customer_order_items" ADD CONSTRAINT "customer_order_items_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

┌─────────────────────────────────────────────────────────┐
│  Update available 5.22.0 -> 7.5.0                       │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘
