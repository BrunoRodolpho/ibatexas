-- DropForeignKey
ALTER TABLE "ibx_domain"."loyalty_accounts" DROP CONSTRAINT "loyalty_accounts_customer_id_fkey";

-- AlterTable
ALTER TABLE "ibx_domain"."holidays" ADD COLUMN     "all_day" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "end_time" VARCHAR(5),
ADD COLUMN     "start_time" VARCHAR(5);

-- AlterTable
ALTER TABLE "ibx_domain"."loyalty_accounts" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ibx_domain"."order_projections" ADD COLUMN     "delivery_type" TEXT,
ADD COLUMN     "payment_method" TEXT,
ADD COLUMN     "tip_in_centavos" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ibx_domain"."reservations" ADD COLUMN     "display_id" SERIAL NOT NULL;

-- CreateTable
CREATE TABLE "ibx_domain"."schedule_overrides" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_overrides_date_key" ON "ibx_domain"."schedule_overrides"("date");

-- AddForeignKey
ALTER TABLE "ibx_domain"."waitlist" ADD CONSTRAINT "waitlist_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

