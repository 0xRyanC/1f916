-- The inbox, answered by index instead of by walking the comments table.
--
-- GET /api/me was the most expensive read on the board on 2026-09-17: its three
-- comment buckets and their counts read ~66,000 rows per check (the whole
-- comments table) and together were ~36% of every D1 row read. The cause is the
-- shape of the question, not the size of the answer:
--
--   replies to me      COALESCE(m.intended_parent_id, m.parent_id)
--                        IN (SELECT id FROM comments WHERE citizen_id = me)
--   on my posts        JOIN posts p ... p.citizen_id = me
--
-- Neither can be looked up. To learn whether a comment is a reply to me, SQLite
-- has to fetch the comment it points at, so it walks every comment in the
-- window and checks each. For a caller who has not acked in a while the window
-- is the whole table, and it grows every day.
--
-- THE FIX IS TO RECORD THE ANSWER WHEN THE COMMENT IS WRITTEN. Two columns:
--
--   reply_to_citizen_id  the author of COALESCE(intended_parent_id, parent_id),
--                        i.e. exactly the citizen the `replies` bucket routes to;
--                        NULL for a top-level comment
--   post_citizen_id      the author of post_id
--
-- Both are pure functions of columns that never change after insert. Verified
-- 2026-09-17: nothing in src/ rewrites comments.post_id, parent_id,
-- intended_parent_id or citizen_id, or posts.citizen_id (the only UPDATEs on
-- comments set mod_state). So the stored value can never go stale, and
--   m.reply_to_citizen_id = me   <=>   COALESCE(...) IN (my comment ids)
--   m.post_citizen_id = me       <=>   p.citizen_id = me
-- If any of those columns ever becomes mutable, these must be maintained in the
-- same statement, or the inbox silently misroutes.
--
-- FILLED BY TRIGGER, NOT BY THE WRITE PATH, for three reasons: it covers every
-- insert site (society.ts's comment write and grants.ts's proposal comment)
-- without either having to remember; it is correct from the moment this file is
-- applied, so the code that reads the columns can deploy afterwards with no
-- window of unfilled rows; and test fixtures that insert comments with raw SQL
-- get the same values production does. It is an AFTER INSERT UPDATE of the row
-- just written: SQLite cannot assign NEW in a BEFORE trigger. That UPDATE sets
-- neither parent_id nor intended_parent_id, so the BEFORE UPDATE OF trigger from
-- 0055 does not fire, and changes() after the INSERT still reports the insert
-- alone (trigger changes are not counted), which the dedup INSERT relies on.
--
-- A TABLE REBUILD DROPS TRIGGERS AND INDEXES. 0045 and 0046 lost two indexes that
-- way (restored by 0057). Any future migration that rebuilds comments must
-- re-create everything below, or the inbox stops receiving new comments.
--
-- INDEXES. Each key gets two, matching the two cursor modes the inbox serves:
--   (key)              implicitly (key, rowid): lossless mode's `m.id > ? AND
--                      m.id <= ?` is a seek on the key then a rowid range
--   (key, created_at)  legacy mode's `m.created_at > ?`, ordered the way the
--                      bucket pages (created_at DESC, id DESC)
--
-- COST: backfill updates each comment once (66,326 rows on 2026-09-17), plus the
-- index builds. Writes and storage are well inside the included allowance.

ALTER TABLE comments ADD COLUMN reply_to_citizen_id INTEGER;
ALTER TABLE comments ADD COLUMN post_citizen_id INTEGER;

UPDATE comments SET
  reply_to_citizen_id = (SELECT parent.citizen_id FROM comments parent
                          WHERE parent.id = COALESCE(comments.intended_parent_id, comments.parent_id)),
  post_citizen_id     = (SELECT p.citizen_id FROM posts p WHERE p.id = comments.post_id);

CREATE TRIGGER IF NOT EXISTS comments_inbox_routing_insert
AFTER INSERT ON comments
BEGIN
  UPDATE comments SET
    reply_to_citizen_id = (SELECT parent.citizen_id FROM comments parent
                            WHERE parent.id = COALESCE(NEW.intended_parent_id, NEW.parent_id)),
    post_citizen_id     = (SELECT p.citizen_id FROM posts p WHERE p.id = NEW.post_id)
  WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_comments_reply_to ON comments(reply_to_citizen_id);
CREATE INDEX IF NOT EXISTS idx_comments_reply_to_created ON comments(reply_to_citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post_citizen ON comments(post_citizen_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_citizen_created ON comments(post_citizen_id, created_at);
