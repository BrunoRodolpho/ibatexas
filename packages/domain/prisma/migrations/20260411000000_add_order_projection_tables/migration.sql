-- CreateEnum
CREATE TYPE "ibx_domain"."OrderFulfillmentStatus" AS ENUM ('pending', 'confirmed', 'preparing', 'ready', 'in_delivery', 'delivered', 'canceled');

-- CreateEnum
CREATE TYPE "ibx_domain"."OrderActor" AS ENUM ('admin', 'system', 'system_backfill', 'customer');

-- CreateTable
CREATE TABLE "ibx_domain"."order_projections" (
    "id" TEXT NOT NULL,
    "display_id" INTEGER NOT NULL,
    "customer_id" TEXT,
    "customer_email" TEXT,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "fulfillment_status" "ibx_domain"."OrderFulfillmentStatus" NOT NULL DEFAULT 'pending',
    "payment_status" TEXT,
    "total_in_centavos" INTEGER NOT NULL DEFAULT 0,
    "subtotal_in_centavos" INTEGER NOT NULL DEFAULT 0,
    "shipping_in_centavos" INTEGER NOT NULL DEFAULT 0,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "items_json" JSONB,
    "items_schema_version" INTEGER NOT NULL DEFAULT 1,
    "shipping_address_json" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "medusa_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."order_status_history" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" "ibx_domain"."OrderFulfillmentStatus" NOT NULL,
    "to_status" "ibx_domain"."OrderFulfillmentStatus" NOT NULL,
    "actor" "ibx_domain"."OrderActor" NOT NULL DEFAULT 'system',
    "actor_id" TEXT,
    "reason" TEXT,
    "version" INTEGER NOT NULL,
    "backfill_batch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."order_event_log" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_projections_customer_id_idx" ON "ibx_domain"."order_projections"("customer_id");

-- CreateIndex
CREATE INDEX "order_projections_fulfillment_status_idx" ON "ibx_domain"."order_projections"("fulfillment_status");

-- CreateIndex
CREATE INDEX "order_projections_display_id_idx" ON "ibx_domain"."order_projections"("display_id");

-- CreateIndex
CREATE INDEX "order_projections_medusa_created_at_idx" ON "ibx_domain"."order_projections"("medusa_created_at");

-- CreateIndex
CREATE INDEX "order_projections_fulfillment_status_medusa_created_at_idx" ON "ibx_domain"."order_projections"("fulfillment_status", "medusa_created_at" DESC);

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "ibx_domain"."order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_status_history_created_at_idx" ON "ibx_domain"."order_status_history"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_event_log_idempotency_key_key" ON "ibx_domain"."order_event_log"("idempotency_key");

-- CreateIndex
CREATE INDEX "order_event_log_order_id_created_at_idx" ON "ibx_domain"."order_event_log"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_event_log_order_id_event_type_idx" ON "ibx_domain"."order_event_log"("order_id", "event_type");

-- CreateIndex
CREATE INDEX "order_event_log_event_type_timestamp_idx" ON "ibx_domain"."order_event_log"("event_type", "timestamp");

-- AddForeignKey
ALTER TABLE "ibx_domain"."order_projections" ADD CONSTRAINT "order_projections_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ibx_domain"."order_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
