// Totals and activity maintained at write time (migration 0059), read here.
//
// Every read below used to count its table from scratch: the front page counted
// every post, /api/pulse every citizen, /api/stats every post, comment, vote and
// seal and then walked all three activity tables twice. On 2026-09-17 those were
// among the most-called statements on the board, each priced by the size of the
// society. The triggers in 0059 keep the answers current as rows are written.

export type MaintainedTable = "citizens" | "posts" | "comments" | "votes" | "seals";

// A scalar SQL expression for a table's total. It reads the maintained counter
// and falls back to a real COUNT(*) only when the counter row is ABSENT (a
// database that never got 0059). SQLite's COALESCE evaluates left to right and
// stops at the first non-NULL argument, so the fallback subquery never runs
// while the row exists; verified 2026-09-17 with a second argument that raises
// when evaluated.
//
// It must never default to 0. These totals are published as the society's
// census, and a served zero would read as "nothing here", the unscoped zero the
// record forbids. Slow is a fine failure mode; wrong is not.
//
// An expression rather than a helper that issues its own query, so a caller that
// needs the total inside a D1 batch (the front page reads the count and the feed
// from one snapshot) keeps that guarantee: the counter is updated in the same
// transaction as the row it counts.
export function maintainedTotalSql(table: MaintainedTable): string {
  return `COALESCE((SELECT n FROM table_counts WHERE name = '${table}'), (SELECT COUNT(*) FROM ${table}))`;
}

// Citizens who wrote a post, comment or vote strictly after `since` (bind ?1).
// Exactly the old COUNT(DISTINCT citizen_id) over the UNION of the three tables
// in that window, because citizen_activity holds each citizen's latest
// created_at across all three; the invariants that equivalence rests on are in
// the migration. Reads one index entry per active citizen, not every row written
// in the window.
export const ACTIVE_CITIZENS_SQL = "SELECT COUNT(*) AS n FROM citizen_activity WHERE last_active_at > ?1";
