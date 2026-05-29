-- AlterTable
-- LGPD Art. 18 erasure marker (RC-A2 / P0-LGPD-1): set once erasure completes so
-- anonymizeCustomer is idempotent (a re-submit / retry is a safe no-op).
ALTER TABLE "ibx_domain"."customers" ADD COLUMN "erased_at" TIMESTAMP(3);
