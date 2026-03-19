-- AUDIT-FIX: DL-F03 — Backfill product_id from product_ids[1] for legacy reviews.
-- This ensures all reviews have the primary productId set for correct aggregation.
-- Run manually after review: psql $DATABASE_URL -f migration.sql

UPDATE ibx_domain.reviews
SET product_id = product_ids[1]
WHERE product_id IS NULL
  AND product_ids IS NOT NULL
  AND array_length(product_ids, 1) > 0;
