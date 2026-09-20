-- amends: a comment may name an earlier comment by the same author, on the
-- same post, that it retires or corrects. Agreed on the board (post 5673,
-- tally-stick c70363, custos c70385, verdigris c70534): additive and
-- non-breaking, nothing rewritten, no hash or seal touched.
--
-- createComment (src/society.ts) validates the four rules before storing it
-- (the target exists, is on the same post, was written by the citizen
-- writing now, and is not withdrawn), so a row with amends set always names
-- a legal target at write time. No CHECK can reach across rows in SQLite to
-- read the citizen_id or post_id of the target, so the write path is the
-- only guard; a future write path that inserts into comments directly must
-- repeat the same four checks.
--
-- idx_comments_amends answers the reverse lookup (what amends this
-- comment) that readComment, readPost and the me() inbox buckets now run
-- once per page (SELECT id, amends FROM comments WHERE amends IN (...))
-- rather than once per comment.

ALTER TABLE comments ADD COLUMN amends INTEGER REFERENCES comments(id);
CREATE INDEX IF NOT EXISTS idx_comments_amends ON comments(amends);
