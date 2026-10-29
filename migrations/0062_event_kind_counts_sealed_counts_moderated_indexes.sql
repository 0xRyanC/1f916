-- Three reads that still walked whole tables after 0061, measured on the D1 meter
-- 16:45-16:57 UTC on 2026-09-17 (2.02B rows/day pace):
--
--   34%  kindTotalsMap: SELECT kind, COUNT(*) FROM identity_events GROUP BY kind
--        (GET /api/events denominator), 16,519 rows per call
--   18%  chain attestation sealed_entries_total: COUNT(*) FROM <table>
--        WHERE id >= sealed_from_id AND hash IS NOT NULL, 16,505 rows per call
--   16%  moderationState's live-state reconciliation: SELECT id, mod_state FROM
--        comments / posts / listings WHERE mod_state IS NOT NULL, 66,505 and
--        5,748 rows per call (no index on mod_state)
--
-- Nothing here changes a hash, a row, or what is served. The owner approved
-- maintained counts inside the chain code on 2026-09-17 under that condition.
--
-- 1. identity_event_kind_counts(kind, n): insert/delete triggers on
--    identity_events. kind is never rewritten (verified 2026-09-17: no UPDATE
--    of identity_events in src/ or migrations/). The reader checks SUM(n)
--    against 0061's maintained identity_events total and falls back to the real
--    GROUP BY when they disagree, so a missing or partial seed is slow, never
--    wrong.
--
-- 2. Sealed-row counts in table_counts as '<table>.sealed'. sealed_from_id is
--    MIN(id) WHERE hash IS NOT NULL, so every sealed row has id >= it, and the
--    served count is exactly COUNT(*) WHERE hash IS NOT NULL. Kept by triggers on
--    insert and delete (WHEN hash IS NOT NULL) and on UPDATE OF hash (+1/-1 by
--    whether it became or stopped being NULL); hash is never updated today, the
--    update trigger is defensive. The reader keeps the exact old statement as its
--    COALESCE fallback.
--
-- 3. Partial covering indexes (id, mod_state) WHERE mod_state IS NOT NULL on
--    posts, comments and listings. The reconciliation reads then touch only
--    moderated rows. Their predicates match the index conditions exactly, which is
--    what lets SQLite use a partial index.
--
-- ORDER: tables, indexes and triggers first, seeds last (0059's rule).
-- A TABLE REBUILD of identity_events, ledger, posts, comments or listings must
-- re-create what this file adds.

CREATE TABLE IF NOT EXISTS table_counts (
  name TEXT PRIMARY KEY,
  n    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_event_kind_counts (
  kind TEXT PRIMARY KEY,
  n    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_moderated ON posts(id, mod_state) WHERE mod_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_moderated ON comments(id, mod_state) WHERE mod_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_moderated ON listings(id, mod_state) WHERE mod_state IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS identity_event_kind_count_insert AFTER INSERT ON identity_events
BEGIN
  INSERT INTO identity_event_kind_counts (kind, n) VALUES (NEW.kind, 1)
    ON CONFLICT (kind) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS identity_event_kind_count_delete AFTER DELETE ON identity_events
BEGIN
  UPDATE identity_event_kind_counts SET n = n - 1 WHERE kind = OLD.kind;
END;

CREATE TRIGGER IF NOT EXISTS identity_events_sealed_count_insert AFTER INSERT ON identity_events
WHEN NEW.hash IS NOT NULL
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'identity_events.sealed'; END;
CREATE TRIGGER IF NOT EXISTS identity_events_sealed_count_delete AFTER DELETE ON identity_events
WHEN OLD.hash IS NOT NULL
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'identity_events.sealed'; END;
CREATE TRIGGER IF NOT EXISTS identity_events_sealed_count_update AFTER UPDATE OF hash ON identity_events
BEGIN
  UPDATE table_counts SET n = n + (NEW.hash IS NOT NULL) - (OLD.hash IS NOT NULL) WHERE name = 'identity_events.sealed';
END;
CREATE TRIGGER IF NOT EXISTS ledger_sealed_count_insert AFTER INSERT ON ledger
WHEN NEW.hash IS NOT NULL
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'ledger.sealed'; END;
CREATE TRIGGER IF NOT EXISTS ledger_sealed_count_delete AFTER DELETE ON ledger
WHEN OLD.hash IS NOT NULL
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'ledger.sealed'; END;
CREATE TRIGGER IF NOT EXISTS ledger_sealed_count_update AFTER UPDATE OF hash ON ledger
BEGIN
  UPDATE table_counts SET n = n + (NEW.hash IS NOT NULL) - (OLD.hash IS NOT NULL) WHERE name = 'ledger.sealed';
END;

INSERT OR REPLACE INTO identity_event_kind_counts (kind, n)
  SELECT kind, COUNT(*) FROM identity_events GROUP BY kind;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'identity_events.sealed', COUNT(*) FROM identity_events WHERE hash IS NOT NULL;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'ledger.sealed', COUNT(*) FROM ledger WHERE hash IS NOT NULL;
