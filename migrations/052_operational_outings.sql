-- Explicit opt-in only: completed historical trips do not create outings.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outing_locations_company_id ON operational_locations(company_id,id);
CREATE TABLE IF NOT EXISTS operational_outings (
 id bigserial PRIMARY KEY,
 company_id bigint NOT NULL REFERENCES companies(id),
 truck_id integer NOT NULL,
 driver_id integer NOT NULL,
 trailer_id integer,
 base_location_id bigint NOT NULL,
 commercial_modules jsonb,
 status text NOT NULL DEFAULT 'in_service' CHECK(status IN ('in_service','waiting','returning','arrived_base','released')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 release_reason text,
 created_by bigint REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 UNIQUE(id,company_id),
 FOREIGN KEY(company_id,truck_id) REFERENCES trucks(company_id,id),
 FOREIGN KEY(company_id,driver_id) REFERENCES drivers(company_id,id),
 FOREIGN KEY(company_id,trailer_id) REFERENCES trucks(company_id,id),
 FOREIGN KEY(company_id,base_location_id) REFERENCES operational_locations(company_id,id),
 CHECK((closed_at IS NOT NULL) = (status IN ('arrived_base','released'))),
 CHECK(status<>'released' OR coalesce(length(trim(release_reason)),0)>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_outings_open_truck ON operational_outings(company_id,truck_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS operational_outings_open_driver ON operational_outings(company_id,driver_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS operational_outings_open_trailer ON operational_outings(company_id,trailer_id) WHERE closed_at IS NULL AND trailer_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS operational_outing_services (
 id bigserial PRIMARY KEY,
 company_id bigint NOT NULL REFERENCES companies(id),
 outing_id bigint NOT NULL,
 trip_id integer NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(outing_id,company_id) REFERENCES operational_outings(id,company_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id),
 UNIQUE(company_id,trip_id), UNIQUE(outing_id,sequence)
);
CREATE TABLE IF NOT EXISTS operational_outing_events (
 id bigserial PRIMARY KEY,
 company_id bigint NOT NULL REFERENCES companies(id),
 outing_id bigint NOT NULL,
 kind text NOT NULL,
 reason text,
 trip_id integer,
 details jsonb,
 created_by bigint REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(outing_id,company_id) REFERENCES operational_outings(id,company_id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id)
);
CREATE TABLE IF NOT EXISTS operational_outing_positions (
 id bigserial PRIMARY KEY,
 company_id bigint NOT NULL REFERENCES companies(id),
 outing_id bigint NOT NULL,
 lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90),
 lng double precision NOT NULL CHECK(lng BETWEEN -180 AND 180),
 accuracy_m double precision CHECK(accuracy_m>=0),
 recorded_at timestamptz NOT NULL,
 created_by bigint REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(outing_id,company_id) REFERENCES operational_outings(id,company_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS operational_outing_positions_latest ON operational_outing_positions(company_id,outing_id,recorded_at DESC,id DESC);

ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS outing_id bigint REFERENCES operational_outings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS telemetry_outing_time ON telemetry(outing_id,recorded_at DESC) WHERE outing_id IS NOT NULL;
-- Keep the existing telemetry entitlement rules and add only explicit return GPS.
CREATE OR REPLACE FUNCTION operational_outing_telemetry_guard() RETURNS trigger AS $$
DECLARE cid bigint;
BEGIN
 SELECT company_id INTO cid FROM trucks WHERE id=NEW.truck_id;
 IF NEW.outing_id IS NOT NULL THEN
  IF NEW.trip_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM operational_outings WHERE id=NEW.outing_id AND company_id=cid
   AND truck_id=NEW.truck_id AND status='returning' AND closed_at IS NULL
   AND (commercial_modules IS NULL OR commercial_modules ? 'gps')) THEN
   RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='La posición requiere una salida en retorno con GPS contratado';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.trip_id IS NOT NULL AND EXISTS(SELECT 1 FROM trips WHERE id=NEW.trip_id AND company_id=cid AND truck_id=NEW.truck_id
  AND status IN ('En tránsito','Detenido') AND (commercial_modules IS NULL OR commercial_modules ? 'gps')) THEN RETURN NEW; END IF;
 PERFORM commercial_require(cid,'gps',NEW.truck_id);
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commercial_operation_guard ON telemetry;
CREATE TRIGGER commercial_operation_guard BEFORE INSERT OR UPDATE ON telemetry FOR EACH ROW EXECUTE FUNCTION operational_outing_telemetry_guard();

-- Preserve the outing's resource reservation after a service is completed.
CREATE OR REPLACE FUNCTION operational_outing_trip_guard() RETURNS trigger AS $$
DECLARE outing operational_outings; latest_trip bigint; rev trip_resource_revisions; before_state jsonb; after_state jsonb;
BEGIN
 SELECT o.* INTO outing FROM operational_outings o JOIN operational_outing_services s ON s.outing_id=o.id AND s.company_id=o.company_id
  WHERE s.trip_id=OLD.id AND s.company_id=OLD.company_id AND o.closed_at IS NULL;
 IF outing.id IS NULL THEN RETURN NEW; END IF;
 SELECT trip_id INTO latest_trip FROM operational_outing_services WHERE outing_id=outing.id AND company_id=outing.company_id ORDER BY sequence DESC LIMIT 1;
 IF latest_trip<>OLD.id AND NEW.status NOT IN ('Completado','Cancelado') THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='Un servicio anterior de una salida abierta no se puede reactivar';
 END IF;
 IF ROW(NEW.company_id,NEW.truck_id,NEW.driver_id,NEW.trailer_id) IS NOT DISTINCT FROM ROW(OLD.company_id,OLD.truck_id,OLD.driver_id,OLD.trailer_id) THEN RETURN NEW; END IF;
 IF latest_trip<>OLD.id OR OLD.status IN ('Completado','Cancelado') OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.truck_id IS NULL OR NEW.driver_id IS NULL OR NEW.resource_version<>OLD.resource_version+1 THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='Solo se reemplazan recursos del último servicio activo mediante asignación versionada';
 END IF;
 -- The assignment endpoint writes its authoritative revision after UPDATE trips.
 -- This constraint trigger runs at COMMIT, so it can validate that revision.
 SELECT * INTO rev FROM trip_resource_revisions WHERE trip_id=NEW.id AND company_id=NEW.company_id AND version=NEW.resource_version;
 IF rev.id IS NULL OR rev.actor_user_id IS NULL OR nullif(trim(rev.reason),'') IS NULL
  OR coalesce((rev.snapshot->'truck'->>'id')::integer,(rev.snapshot->>'truck_id')::integer) IS DISTINCT FROM NEW.truck_id
  OR coalesce((rev.snapshot->'driver'->>'id')::integer,(rev.snapshot->>'driver_id')::integer) IS DISTINCT FROM NEW.driver_id
  OR coalesce((rev.snapshot->'trailer'->>'id')::integer,(rev.snapshot->>'trailer_id')::integer) IS DISTINCT FROM NEW.trailer_id THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='El reemplazo requiere la revisión de recursos auditada del servicio';
 END IF;
 IF ROW(NEW.truck_id,NEW.driver_id,NEW.trailer_id) IS NOT DISTINCT FROM ROW(outing.truck_id,outing.driver_id,outing.trailer_id) THEN RETURN NEW; END IF;
 PERFORM id FROM drivers WHERE company_id=NEW.company_id AND id IN (OLD.driver_id,NEW.driver_id) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM trucks WHERE company_id=NEW.company_id AND id IN (OLD.truck_id,OLD.trailer_id,NEW.truck_id,NEW.trailer_id) ORDER BY id FOR NO KEY UPDATE NOWAIT;
 SELECT * INTO outing FROM operational_outings WHERE id=outing.id AND closed_at IS NULL FOR UPDATE NOWAIT;
 IF outing.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='La salida cambió durante el reemplazo'; END IF;
 IF EXISTS(SELECT 1 FROM operational_outings o WHERE o.company_id=NEW.company_id AND o.closed_at IS NULL AND o.id<>outing.id
  AND (o.driver_id=NEW.driver_id OR o.truck_id IN (NEW.truck_id,NEW.trailer_id) OR o.trailer_id IN (NEW.truck_id,NEW.trailer_id))) THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='Los recursos de reemplazo tienen otra salida abierta';
 END IF;
 before_state:=to_jsonb(outing);
 UPDATE operational_outings SET truck_id=NEW.truck_id,trailer_id=NEW.trailer_id,driver_id=NEW.driver_id,version=version+1 WHERE id=outing.id RETURNING to_jsonb(operational_outings.*) INTO after_state;
 INSERT INTO operational_outing_events(company_id,outing_id,kind,reason,trip_id,created_by,details)
  VALUES(NEW.company_id,outing.id,'resource_change',rev.reason,NEW.id,rev.actor_user_id,jsonb_build_object('resource_version',NEW.resource_version,'before',before_state,'after',after_state));
 INSERT INTO audit_logs(company_id,user_id,action,entity,entity_id,before_data,after_data)
  VALUES(NEW.company_id,rev.actor_user_id,'resource_change','operational_outing',outing.id::text,before_state,after_state);
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS operational_outing_trip_guard ON trips;
CREATE CONSTRAINT TRIGGER operational_outing_trip_guard AFTER UPDATE ON trips DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operational_outing_trip_guard();

CREATE OR REPLACE FUNCTION operational_outing_seat_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.active AND NOT NEW.active) THEN
  -- NOWAIT avoids a cycle with a dispatcher holding the vehicle lock.
  PERFORM 1 FROM trucks WHERE id=OLD.truck_id FOR NO KEY UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM operational_outings WHERE company_id=OLD.company_id AND closed_at IS NULL
   AND (truck_id=OLD.truck_id OR trailer_id=OLD.truck_id)) THEN
   RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='El equipo tiene una salida operacional abierta; no se libera su cupo';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS operational_outing_seat_guard ON commercial_equipment_seats;
CREATE TRIGGER operational_outing_seat_guard BEFORE UPDATE OR DELETE ON commercial_equipment_seats FOR EACH ROW EXECUTE FUNCTION operational_outing_seat_guard();

CREATE OR REPLACE FUNCTION operational_outing_maintenance_guard() RETURNS trigger AS $$
BEGIN
 IF NEW.status='En proceso' THEN
  PERFORM 1 FROM trucks WHERE company_id=NEW.company_id AND id=NEW.truck_id FOR NO KEY UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM operational_outings WHERE company_id=NEW.company_id AND closed_at IS NULL
   AND (truck_id=NEW.truck_id OR trailer_id=NEW.truck_id)) THEN
   RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='El equipo tiene una salida operacional abierta; no se admite a taller';
  END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS operational_outing_maintenance_guard ON maintenance;
CREATE TRIGGER operational_outing_maintenance_guard BEFORE INSERT OR UPDATE ON maintenance FOR EACH ROW EXECUTE FUNCTION operational_outing_maintenance_guard();
