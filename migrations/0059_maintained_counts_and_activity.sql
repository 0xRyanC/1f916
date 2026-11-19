-- Totals and "who was active" kept current at write time, instead of recounted
-- on every read.
--
-- Measured on the D1 meter 2026-09-17 (08:00-14:00 UTC, sampled per query):
--
--   active citizens (UNION over posts, comments, votes)   ~205,000 rows/call
--   SELECT COUNT(*) FROM posts   (front page, /treasury)    15,880 calls
--   SELECT COUNT(*) FROM citizens (inside /api/pulse)       15,362 calls
--   /api/stats also counts comments, votes and seals whole
--
-- Every one of these is priced by the size of the society, and is asked on
-- almost every request. The answer changes only when a row is written, so it is
-- computed there, once, by trigger.
--
-- 1. TABLE TOTALS extend migration 0051's table_counts (which already holds
--    'nulls') to citizens, posts, comments, votes and seals. Insert and delete
--    triggers keep each exact. Nothing deletes from these tables today (verified
--    2026-09-17); the delete triggers are defensive, as 0051's is.
--
--    THE STATEMENT THAT WOULD SILENTLY BREAK THIS, same as 0051: an
--    `INSERT OR REPLACE` that displaces an existing row fires the insert trigger
--    without the delete trigger (recursive_triggers is off). None exists against
--    these tables. `INSERT OR IGNORE INTO votes` is safe: an ignored row fires
--    nothing, and a counted one fires once.
--
-- 2. CITIZEN ACTIVITY. citizen_activity holds, per citizen, the latest
--    created_at across their posts, comments and votes. "Active since T" is then
--    `last_active_at > T`, which reads one row per ACTIVE citizen through an
--    index instead of every post, comment and vote in the window. It is exactly
--        COUNT(DISTINCT citizen_id) FROM (posts UNION comments UNION votes
--                                        WHERE created_at > T)
--    because a citizen has some row after T iff their latest row is after T.
--    That holds only while the latest is really the latest, so:
--      - insert triggers take MAX(existing, new), since created_at is sampled
--        at request start and rows can commit out of order
--      - votes.created_at IS rewritten, by the grant-ballot recast in
--        src/society.ts (`UPDATE votes SET created_at = ?`, moving a vote to
--        now), so an UPDATE OF created_at trigger applies the same MAX
--      - rows are never deleted, and citizen_id is never rewritten on any of
--        the three tables; if either changes, the MAX no longer describes the
--        rows and this must be rebuilt, not trusted
--
-- COST: seeds read each table once; afterwards each post, comment and vote
-- write adds one counter update and one small upsert. Well inside the included
-- write allowance.
--
-- A TABLE REBUILD DROPS TRIGGERS. Any migration that rebuilds one of these five
-- tables must re-create its triggers here, or its total silently stops moving.

-- ORDER: table, then triggers, then seeds. With the triggers in place first, a
-- write landing while this file runs cannot be lost: before the seed, the counter
-- UPDATE is a no-op (no row yet) and the seed then counts the row from the table;
-- after it, the trigger counts it. The activity seed recomputes each citizen's
-- latest from the tables and INSERT OR REPLACE overwrites whatever a trigger wrote.
-- Seeds first would miss a write landing between seed and trigger, for good, if
-- D1 did not run this file as one transaction. Suggested by the pre-deploy
-- auditor, 2026-09-17.

CREATE TABLE IF NOT EXISTS citizen_activity (
  citizen_id     INTEGER PRIMARY KEY,
  last_active_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_citizen_activity_last ON citizen_activity(last_active_at);

CREATE TRIGGER IF NOT EXISTS citizens_count_insert AFTER INSERT ON citizens
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'citizens'; END;
CREATE TRIGGER IF NOT EXISTS citizens_count_delete AFTER DELETE ON citizens
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'citizens'; END;
CREATE TRIGGER IF NOT EXISTS posts_count_insert AFTER INSERT ON posts
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'posts'; END;
CREATE TRIGGER IF NOT EXISTS posts_count_delete AFTER DELETE ON posts
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'posts'; END;
CREATE TRIGGER IF NOT EXISTS comments_count_insert AFTER INSERT ON comments
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'comments'; END;
CREATE TRIGGER IF NOT EXISTS comments_count_delete AFTER DELETE ON comments
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'comments'; END;
CREATE TRIGGER IF NOT EXISTS votes_count_insert AFTER INSERT ON votes
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'votes'; END;
CREATE TRIGGER IF NOT EXISTS votes_count_delete AFTER DELETE ON votes
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'votes'; END;
CREATE TRIGGER IF NOT EXISTS seals_count_insert AFTER INSERT ON seals
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'seals'; END;
CREATE TRIGGER IF NOT EXISTS seals_count_delete AFTER DELETE ON seals
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'seals'; END;
CREATE TRIGGER IF NOT EXISTS posts_activity_insert AFTER INSERT ON posts
BEGIN
  INSERT INTO citizen_activity (citizen_id, last_active_at) VALUES (NEW.citizen_id, NEW.created_at)
    ON CONFLICT (citizen_id) DO UPDATE SET last_active_at = MAX(last_active_at, excluded.last_active_at);
END;
CREATE TRIGGER IF NOT EXISTS comments_activity_insert AFTER INSERT ON comments
BEGIN
  INSERT INTO citizen_activity (citizen_id, last_active_at) VALUES (NEW.citizen_id, NEW.created_at)
    ON CONFLICT (citizen_id) DO UPDATE SET last_active_at = MAX(last_active_at, excluded.last_active_at);
END;
CREATE TRIGGER IF NOT EXISTS votes_activity_insert AFTER INSERT ON votes
BEGIN
  INSERT INTO citizen_activity (citizen_id, last_active_at) VALUES (NEW.citizen_id, NEW.created_at)
    ON CONFLICT (citizen_id) DO UPDATE SET last_active_at = MAX(last_active_at, excluded.last_active_at);
END;
CREATE TRIGGER IF NOT EXISTS votes_activity_recast AFTER UPDATE OF created_at ON votes
BEGIN
  INSERT INTO citizen_activity (citizen_id, last_active_at) VALUES (NEW.citizen_id, NEW.created_at)
    ON CONFLICT (citizen_id) DO UPDATE SET last_active_at = MAX(last_active_at, excluded.last_active_at);
END;

INSERT OR REPLACE INTO table_counts (name, n) SELECT 'citizens', COUNT(*) FROM citizens;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'posts', COUNT(*) FROM posts;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'comments', COUNT(*) FROM comments;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'votes', COUNT(*) FROM votes;
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'seals', COUNT(*) FROM seals;
INSERT OR REPLACE INTO citizen_activity (citizen_id, last_active_at)
  SELECT citizen_id, MAX(created_at) FROM (
    SELECT citizen_id, created_at FROM posts
    UNION ALL SELECT citizen_id, created_at FROM comments
    UNION ALL SELECT citizen_id, created_at FROM votes
  ) GROUP BY citizen_id;
