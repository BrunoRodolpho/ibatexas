-- CreateTable
CREATE TABLE "ibx_domain"."customer_broadcast_consent" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_broadcast_consent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_broadcast_consent_phone_key" ON "ibx_domain"."customer_broadcast_consent"("phone");

-- CreateIndex
CREATE INDEX "customer_broadcast_consent_opted_out_idx" ON "ibx_domain"."customer_broadcast_consent"("opted_out");
