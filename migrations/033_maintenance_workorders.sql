BEGIN;

ALTER TABLE trucks ADD COLUMN IF NOT EXISTS hour_meter_hours NUMERIC CHECK (hour_meter_hours >= 0);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS operation_stage TEXT
 CHECK (operation_stage IN ('scheduled','received','in_progress','released','closed','cancelled'));
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS work_order_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS financially_closed_at TIMESTAMPTZ;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS delivered_by_driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS responsible_user_id BIGINT REFERENCES users(id);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS diagnosis TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS work_summary TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS release_note TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS previous_truck_status TEXT;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS received_hours NUMERIC CHECK (received_hours >= 0);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS released_odometer_km NUMERIC CHECK (released_odometer_km >= 0);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS released_hours NUMERIC CHECK (released_hours >= 0);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS routine JSONB;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS next_due_hours NUMERIC CHECK (next_due_hours >= 0);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS previous_work_order_id INTEGER REFERENCES maintenance(id);
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS zero_cost_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_order_successor ON maintenance(previous_work_order_id)
 WHERE previous_work_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_received_work_order_truck ON maintenance(company_id,truck_id)
 WHERE operation_stage IN ('received','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_company_id ON maintenance(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_company_truck ON maintenance(company_id,id,truck_id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='maintenance_workorder_consistency') THEN
  ALTER TABLE maintenance ADD CONSTRAINT maintenance_workorder_consistency CHECK (
   operation_stage IS NULL OR (
    work_order_version>0 AND
    status=CASE operation_stage WHEN 'scheduled' THEN 'Pendiente' WHEN 'received' THEN 'En proceso'
      WHEN 'in_progress' THEN 'En proceso' WHEN 'released' THEN 'Completada' WHEN 'closed' THEN 'Completada' ELSE 'Cancelada' END
    AND (operation_stage NOT IN ('received','in_progress','released','closed') OR received_at IS NOT NULL)
    AND (operation_stage NOT IN ('released','closed') OR (released_at IS NOT NULL AND released_at>=received_at))
    AND (operation_stage<>'closed' OR (financially_closed_at IS NOT NULL AND cost_clp IS NOT NULL))
   ));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='maintenance_delivery_driver_company') THEN
  ALTER TABLE maintenance ADD CONSTRAINT maintenance_delivery_driver_company FOREIGN KEY(company_id,delivered_by_driver_id) REFERENCES drivers(company_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='maintenance_previous_order_company') THEN
  ALTER TABLE maintenance ADD CONSTRAINT maintenance_previous_order_company FOREIGN KEY(company_id,previous_work_order_id) REFERENCES maintenance(company_id,id);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS maintenance_work_items (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, maintenance_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('part','labor','service')),
 description TEXT NOT NULL CHECK (length(trim(description)) > 0),
 quantity NUMERIC NOT NULL CHECK (quantity > 0),
 estimated_unit_cost_clp BIGINT CHECK (estimated_unit_cost_clp >= 0),
 actual_unit_cost_clp BIGINT CHECK (actual_unit_cost_clp >= 0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
 note TEXT, created_by BIGINT REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,maintenance_id) REFERENCES maintenance(company_id,id)
);
CREATE INDEX IF NOT EXISTS idx_work_items_order ON maintenance_work_items(company_id,maintenance_id,id);
CREATE TABLE IF NOT EXISTS maintenance_findings (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, maintenance_id INTEGER NOT NULL,
 description TEXT NOT NULL CHECK (length(trim(description)) > 0),
 severity TEXT NOT NULL CHECK (severity IN ('minor','major','critical')),
 state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','fixed','verified')),
 remedy TEXT, responsible_user_id BIGINT REFERENCES users(id), source_alert_id INTEGER REFERENCES alerts(id),
 fixed_by BIGINT REFERENCES users(id), verified_by BIGINT REFERENCES users(id), verified_at TIMESTAMPTZ,
 FOREIGN KEY(company_id,maintenance_id) REFERENCES maintenance(company_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_source_alert ON maintenance_findings(company_id,source_alert_id)
 WHERE source_alert_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS maintenance_meter_readings (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, maintenance_id INTEGER NOT NULL,
 truck_id INTEGER NOT NULL REFERENCES trucks(id), reading_at TIMESTAMPTZ NOT NULL,
 odometer_km NUMERIC CHECK (odometer_km >= 0), hour_meter_hours NUMERIC CHECK (hour_meter_hours >= 0),
 reason TEXT NOT NULL, actor_user_id BIGINT REFERENCES users(id),
 CHECK (odometer_km IS NOT NULL OR hour_meter_hours IS NOT NULL),
 FOREIGN KEY(company_id,maintenance_id,truck_id) REFERENCES maintenance(company_id,id,truck_id)
);
CREATE TABLE IF NOT EXISTS maintenance_work_order_events (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, maintenance_id INTEGER NOT NULL,
 event_type TEXT NOT NULL, actor_user_id BIGINT REFERENCES users(id), actor_name TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), details JSONB NOT NULL,
 FOREIGN KEY(company_id,maintenance_id) REFERENCES maintenance(company_id,id)
);
CREATE INDEX IF NOT EXISTS idx_work_order_events ON maintenance_work_order_events(company_id,maintenance_id,id);
CREATE OR REPLACE FUNCTION immutable_maintenance_history() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'El historial de mantención es inmutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_maintenance_meter_history ON maintenance_meter_readings;
CREATE TRIGGER trg_maintenance_meter_history BEFORE UPDATE OR DELETE ON maintenance_meter_readings
 FOR EACH ROW EXECUTE FUNCTION immutable_maintenance_history();
DROP TRIGGER IF EXISTS trg_maintenance_event_history ON maintenance_work_order_events;
CREATE TRIGGER trg_maintenance_event_history BEFORE UPDATE OR DELETE ON maintenance_work_order_events
 FOR EACH ROW EXECUTE FUNCTION immutable_maintenance_history();
CREATE OR REPLACE FUNCTION prevent_work_order_deletion() RETURNS trigger AS $$
BEGIN
 IF OLD.operation_stage IS NOT NULL THEN RAISE EXCEPTION 'La orden de mantención conserva su historial; no puede eliminarse'; END IF;
 RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_work_order_deletion ON maintenance;
CREATE TRIGGER trg_prevent_work_order_deletion BEFORE DELETE ON maintenance
 FOR EACH ROW EXECUTE FUNCTION prevent_work_order_deletion();
-- Old records retain their dates/costs/states. No fictional intake or release is backfilled.
COMMIT;
