-- Chain attestation stops recounting its tables; identity_events gains a kind index.
--
-- Approved by the owner on 2026-09-17 as a change inside the hash-chain code,
-- on the understanding that no hash, no row and no verification step changes.
-- None does: this file adds a counter, two triggers per chained table, and an
-- index. Nothing here reads or writes prev_hash or hash.
--
-- 1. chainTip (src/chain.ts) served total_rows as `SELECT COUNT(*) FROM ${table}`
--    on every GET /api/attest: 16,515 rows per call on identity_events, 26% of
--    all D1 rows read in the dozen minutes after the inbox cap deployed. It is
--    the one remaining read on the board that grows with the society: every
--    identity event makes every later attestation cost one more row. total_rows
--    now reads table_counts ('identity_events', 'ledger'), kept exact by insert
--    and delete triggers, with a real COUNT(*) behind a COALESCE for a database
--    missing the row (never a zero).
--
--    Exact while nothing REPLACEs into either table (an INSERT OR REPLACE that
--    displaces a row fires the insert trigger without the delete trigger, as
--    0051 records). Verified 2026-09-17: no REPLACE and no DELETE against
--    identity_events or ledger anywhere in src/ or migrations/.
--
-- 2. legacyManifestStatus (src/legacy-manifest.ts) reads
--    `FROM identity_events WHERE kind = 'legacy.manifest' AND hash IS NOT NULL
--    ORDER BY id`; with no index on kind (only (citizen_id, kind, id), unusable
--    without the citizen) it walked the whole table per attestation, 16,515
--    rows. idx_identity_events_kind (kind, id) lets it seek the kind and read in
--    id order. The same index serves /api/events?kind= and moderation reads.
--
-- ORDER: triggers before seeds (0059's rule), so a row landing while this file
-- runs is counted exactly once.
--
-- A TABLE REBUILD of identity_events or ledger drops these triggers and the
-- index and must re-create them.

CREATE TABLE IF NOT EXISTS table_counts (
  name TEXT PRIMARY KEY,
  n    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_events_kind ON identity_events(kind, id);

CREATE TRIGGER IF NOT EXISTS identity_events_count_insert AFTER INSERT ON identity_events
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'identity_events'; END;
CREATE TRIGGER IF NOT EXISTS identity_events_count_delete AFTER DELETE ON identity_events
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'identity_events'; END;
CREATE TRIGGER IF NOT EXISTS ledger_count_insert AFTER INSERT ON ledger
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'ledger'; END;
CREATE TRIGGER IF NOT EXISTS ledger_count_delete AFTER DELETE ON ledger
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'ledger'; END;

INSERT OR REPLACE INTO table_counts (name, n) SELECT 'identity_events', COUNT(*) FROM identity_events;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'ledger', COUNT(*) FROM ledger;
