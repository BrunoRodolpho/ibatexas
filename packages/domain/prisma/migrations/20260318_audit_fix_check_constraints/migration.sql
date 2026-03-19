-- AUDIT-FIX: DL-F04 — Add CHECK constraints on reserved_covers to prevent
-- negative values and overbooking at the database level.
-- Run manually after review: psql $DATABASE_URL -f migration.sql

ALTER TABLE ibx_domain.time_slots
  ADD CONSTRAINT reserved_covers_non_negative CHECK (reserved_covers >= 0);

ALTER TABLE ibx_domain.time_slots
  ADD CONSTRAINT reserved_within_max CHECK (reserved_covers <= max_covers);
