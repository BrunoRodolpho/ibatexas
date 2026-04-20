-- AlterTable
ALTER TABLE "ibx_domain"."order_notes" ADD COLUMN "is_internal" BOOLEAN NOT NULL DEFAULT false;
