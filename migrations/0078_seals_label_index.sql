-- GET /api/projects (src/projects.ts) reads every citizen's newest seal under a
-- `project.<host>` label. The only index on seals leads with citizen_id, so a
-- question asked across citizens by label prefix would read the whole table on
-- every call. This index leads with label, so the read is a range over the
-- `project.` labels and nothing else, in the order the route serves them.
-- The route answers correctly before this is applied; it is only slower.
CREATE INDEX IF NOT EXISTS idx_seals_label_citizen ON seals(label, citizen_id, id);
