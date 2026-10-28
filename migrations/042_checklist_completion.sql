BEGIN;
-- Add provenance only. Historical answers, states, dates and authors are not fabricated.
ALTER TABLE vehicle_checklists ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE vehicle_checklists ADD COLUMN IF NOT EXISTS created_by_name TEXT;
ALTER TABLE vehicle_checklists ADD COLUMN IF NOT EXISTS completed_by BIGINT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE vehicle_checklists ADD COLUMN IF NOT EXISTS completed_by_name TEXT;
ALTER TABLE vehicle_checklists ADD COLUMN IF NOT EXISTS supersedes_id BIGINT REFERENCES vehicle_checklists(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS checklist_one_regularization ON vehicle_checklists(supersedes_id) WHERE supersedes_id IS NOT NULL;
COMMIT;
