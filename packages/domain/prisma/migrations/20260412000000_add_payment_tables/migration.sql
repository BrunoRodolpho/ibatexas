-- CreateEnum
CREATE TYPE "ibx_domain"."PaymentStatus" AS ENUM (
  'awaiting_payment',
  'payment_pending',
  'payment_expired',
  'payment_failed',
  'cash_pending',
  'paid',
  'switching_method',
  'partially_refunded',
  'refunded',
  'disputed',
  'pay_canceled',
  'waived'
);

-- AlterTable: add current_payment_id to order_projections
ALTER TABLE "ibx_domain"."order_projections"
  ADD COLUMN "current_payment_id" TEXT;

-- CreateTable: payments
CREATE TABLE "ibx_domain"."payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "ibx_domain"."PaymentStatus" NOT NULL DEFAULT 'awaiting_payment',
    "amount_in_centavos" INTEGER NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "pix_expires_at" TIMESTAMP(3),
    "refunded_amount_centavos" INTEGER NOT NULL DEFAULT 0,
    "regeneration_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "last_stripe_event_ts" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: payment_status_history
CREATE TABLE "ibx_domain"."payment_status_history" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "from_status" "ibx_domain"."PaymentStatus" NOT NULL,
    "to_status" "ibx_domain"."PaymentStatus" NOT NULL,
    "actor" "ibx_domain"."OrderActor" NOT NULL DEFAULT 'system',
    "actor_id" TEXT,
    "reason" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable: order_notes
CREATE TABLE "ibx_domain"."order_notes" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "author" "ibx_domain"."OrderActor" NOT NULL,
    "author_id" TEXT,
    "content" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: payments
CREATE INDEX "payments_order_id_idx" ON "ibx_domain"."payments"("order_id");
CREATE INDEX "payments_status_idx" ON "ibx_domain"."payments"("status");
CREATE INDEX "payments_order_id_status_idx" ON "ibx_domain"."payments"("order_id", "status");
CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_key" ON "ibx_domain"."payments"("stripe_payment_intent_id");
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "ibx_domain"."payments"("idempotency_key");

-- CreateIndex: partial unique index — enforces single active (non-terminal) payment per order
-- Terminal statuses: refunded, pay_canceled, waived, payment_failed, payment_expired
CREATE UNIQUE INDEX "payment_active_per_order"
  ON "ibx_domain"."payments"("order_id")
  WHERE "status" NOT IN ('refunded', 'pay_canceled', 'waived', 'payment_failed', 'payment_expired');

-- CreateIndex: payment_status_history
CREATE INDEX "payment_status_history_payment_id_created_at_idx"
  ON "ibx_domain"."payment_status_history"("payment_id", "created_at");

-- CreateIndex: order_notes
CREATE INDEX "order_notes_order_id_created_at_idx"
  ON "ibx_domain"."order_notes"("order_id", "created_at");

-- AddForeignKey: payments -> order_projections
ALTER TABLE "ibx_domain"."payments"
  ADD CONSTRAINT "payments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "ibx_domain"."order_projections"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: payment_status_history -> payments
ALTER TABLE "ibx_domain"."payment_status_history"
  ADD CONSTRAINT "payment_status_history_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "ibx_domain"."payments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: order_notes -> order_projections
ALTER TABLE "ibx_domain"."order_notes"
  ADD CONSTRAINT "order_notes_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "ibx_domain"."order_projections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
