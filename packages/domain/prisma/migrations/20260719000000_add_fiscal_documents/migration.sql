-- CreateEnum: FiscalStatus (NEW-014 — NFC-e emission lifecycle; mirrors
-- @ibatexas/types FiscalStatus, sync-tested)
CREATE TYPE "ibx_domain"."FiscalStatus" AS ENUM ('pending', 'approved', 'rejected', 'timeout', 'error');

-- CreateTable: fiscal_documents (NEW-014 — one fiscal record per order;
-- provider persisted on every row so mock emissions are always identifiable)
CREATE TABLE "ibx_domain"."fiscal_documents" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "ibx_domain"."FiscalStatus" NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "access_key" TEXT,
    "xml_url" TEXT,
    "pdf_url" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_order_id_key" ON "ibx_domain"."fiscal_documents"("order_id");

-- CreateIndex
CREATE INDEX "fiscal_documents_status_idx" ON "ibx_domain"."fiscal_documents"("status");

-- AddForeignKey
ALTER TABLE "ibx_domain"."fiscal_documents" ADD CONSTRAINT "fiscal_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ibx_domain"."order_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
