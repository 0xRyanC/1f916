-- Restore two indexes that production lost when later migrations rebuilt their
-- tables, found 2026-09-17 by diffing sqlite_master in production against
-- schema.sql while building the scan guard.
--
--   idx_listings_expiry          created by 0031, dropped when 0045 rebuilt
--                                listings (0045 re-created idx_listings_citizen
--                                and not this one)
--   idx_payout_receipts_created  created by 0027, dropped when 0046 rebuilt
--                                payout_receipts
--
-- schema.sql has carried both the whole time, so the test suite has been
-- planning queries against indexes production did not have. A table rebuild
-- (CREATE new / INSERT SELECT / DROP old / RENAME) drops every index on the old
-- table; the rebuild must re-create each one, and these two were missed.
--
-- Additive and idempotent: IF NOT EXISTS, no data touched, both tables are small
-- (tens of rows), so the build is trivial. Safe to apply before or after the
-- code that ships with it; nothing depends on it existing.
CREATE INDEX IF NOT EXISTS idx_listings_expiry ON listings(expiry, id);
CREATE INDEX IF NOT EXISTS idx_payout_receipts_created ON payout_receipts(id);
