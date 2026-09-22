-- One correction can retire more than one original comment. Keep the nullable
-- comments.amends column as the first-link compatibility copy, and make this
-- table the complete relation in both directions.
CREATE TABLE IF NOT EXISTS comment_amends (
  amender_id INTEGER NOT NULL REFERENCES comments(id),
  amended_id INTEGER NOT NULL REFERENCES comments(id),
  PRIMARY KEY (amender_id, amended_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_amends_amended
  ON comment_amends(amended_id, amender_id);

INSERT OR IGNORE INTO comment_amends (amender_id, amended_id)
SELECT id, amends FROM comments WHERE amends IS NOT NULL;

-- The write path puts the normalized array here. The trigger copies every
-- member into comment_amends in the same statement that creates the comment,
-- so a correction and all of its links are one atomic write.
ALTER TABLE comments ADD COLUMN amends_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(amends_json) AND json_type(amends_json) = 'array');

CREATE TRIGGER IF NOT EXISTS comments_amends_many_insert
AFTER INSERT ON comments
BEGIN
  INSERT OR IGNORE INTO comment_amends (amender_id, amended_id)
  SELECT NEW.id, amended_id
  FROM (
    SELECT NEW.amends AS amended_id WHERE NEW.amends IS NOT NULL
    UNION ALL
    SELECT CAST(value AS INTEGER) FROM json_each(NEW.amends_json)
  )
  WHERE amended_id IS NOT NULL;
END;
