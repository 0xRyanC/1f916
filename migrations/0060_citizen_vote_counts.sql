-- votes_cast per citizen, maintained at write time instead of counted per row
-- of the census.
--
-- GET /api/citizens serves up to 1,000 citizens a page, each with
--   (SELECT COUNT(*) FROM votes v WHERE v.citizen_id = citizens.id) AS votes_cast
-- which counts every vote every listed citizen ever cast, on every call: 85,433
-- rows per call on the D1 meter at 14:52-14:56 UTC on 2026-09-17, roughly 70% of
-- all rows read once the inbox and the totals stopped walking their tables. It
-- grows with the votes table and with the census.
--
-- citizen_vote_counts holds that COUNT(*) per citizen, kept by triggers:
--   votes AFTER INSERT   n + 1 for NEW.citizen_id
--   votes AFTER DELETE   n - 1 for OLD.citizen_id (defensive; nothing deletes votes)
--   citizens AFTER INSERT  a 0 row, so every citizen has a row and the reader's
--                          fallback never runs in steady state
-- It is exact while votes.citizen_id is never rewritten (verified 2026-09-17:
-- the only UPDATE on votes sets created_at, for the grant-ballot recast, which
-- does not change who cast it) and nothing REPLACEs into votes (`INSERT OR
-- IGNORE` is safe: an ignored row fires nothing).
--
-- The reader keeps a real count behind it:
--   COALESCE((SELECT n FROM citizen_vote_counts WHERE citizen_id = c.id),
--            (SELECT COUNT(*) FROM votes v WHERE v.citizen_id = c.id))
-- COALESCE stops at the first non-NULL argument, so the count runs only for a
-- citizen with no row (a database that never got this migration), and a missing
-- row is never read as zero.
--
-- ORDER: table, triggers, then seed, for the reason 0059 gives: a vote landing
-- while this file runs is counted by its trigger or by the seed, never lost and
-- never twice (the seed is INSERT OR REPLACE of the real count).
--
-- A TABLE REBUILD of votes or citizens drops these triggers and must re-create
-- them.

CREATE TABLE IF NOT EXISTS citizen_vote_counts (
  citizen_id INTEGER PRIMARY KEY,
  n          INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS votes_cast_count_insert AFTER INSERT ON votes
BEGIN
  INSERT INTO citizen_vote_counts (citizen_id, n) VALUES (NEW.citizen_id, 1)
    ON CONFLICT (citizen_id) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS votes_cast_count_delete AFTER DELETE ON votes
BEGIN
  UPDATE citizen_vote_counts SET n = n - 1 WHERE citizen_id = OLD.citizen_id;
END;
CREATE TRIGGER IF NOT EXISTS citizens_vote_count_row AFTER INSERT ON citizens
BEGIN
  INSERT OR IGNORE INTO citizen_vote_counts (citizen_id, n) VALUES (NEW.id, 0);
END;

INSERT OR REPLACE INTO citizen_vote_counts (citizen_id, n)
  SELECT c.id, (SELECT COUNT(*) FROM votes v WHERE v.citizen_id = c.id) FROM citizens c;
