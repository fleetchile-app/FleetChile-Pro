BEGIN;
-- Existing customers are not silently declared paid or disabled. Explicit activation
-- is required. New customers created through the platform API start controlled.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS commercial_enforced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS commercial_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS commercial_modules JSONB;
CREATE TABLE IF NOT EXISTS commercial_plans (
 id BIGSERIAL PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,
 max_equipment INTEGER NOT NULL CHECK(max_equipment>0),allowed_modules JSONB NOT NULL,included_modules JSONB NOT NULL,
 actor_user_id BIGINT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(code,revision)
);
CREATE TABLE IF NOT EXISTS commercial_requests (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),client_key TEXT NOT NULL,
 desired JSONB NOT NULL,payload_hash TEXT NOT NULL,reason TEXT NOT NULL,actor_user_id BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(company_id,client_key),UNIQUE(company_id,id)
);
CREATE TABLE IF NOT EXISTS commercial_quotes (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),request_id BIGINT,
 client_key TEXT NOT NULL,payload_hash TEXT NOT NULL,base_version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('initial','renewal','expansion')),
 configuration JSONB NOT NULL,period_from TIMESTAMPTZ NOT NULL,period_until TIMESTAMPTZ NOT NULL,valid_until TIMESTAMPTZ NOT NULL,
 amount_clp BIGINT NOT NULL CHECK(amount_clp>=0),reason TEXT NOT NULL,
 actor_user_id BIGINT NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(period_until>period_from),UNIQUE(company_id,client_key),UNIQUE(company_id,id),
 FOREIGN KEY(company_id,request_id) REFERENCES commercial_requests(company_id,id)
);
CREATE TABLE IF NOT EXISTS commercial_quote_events (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,quote_id BIGINT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('accepted','rejected','paid')),actor_user_id BIGINT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL,payment_reference TEXT,amount_clp BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,quote_id) REFERENCES commercial_quotes(company_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_quote_decision ON commercial_quote_events(quote_id) WHERE kind IN ('accepted','rejected');
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_quote_paid ON commercial_quote_events(quote_id) WHERE kind='paid';
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_payment_reference ON commercial_quote_events(payment_reference) WHERE kind='paid';
CREATE TABLE IF NOT EXISTS commercial_contracts (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,quote_id BIGINT NOT NULL UNIQUE,version INTEGER NOT NULL,
 configuration JSONB NOT NULL,period_from TIMESTAMPTZ NOT NULL,period_until TIMESTAMPTZ NOT NULL,
 enabled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(company_id,quote_id) REFERENCES commercial_quotes(company_id,id),UNIQUE(company_id,version)
);
CREATE INDEX IF NOT EXISTS idx_commercial_period ON commercial_contracts(company_id,period_from,period_until,id DESC);
CREATE TABLE IF NOT EXISTS commercial_equipment_seats (
 company_id BIGINT NOT NULL REFERENCES companies(id),truck_id INTEGER NOT NULL REFERENCES trucks(id),
 category TEXT NOT NULL CHECK(category IN ('truck','tractor','trailer','equipment')),active BOOLEAN NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(company_id,truck_id),UNIQUE(truck_id)
);
CREATE TABLE IF NOT EXISTS commercial_seat_events (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id),truck_id INTEGER NOT NULL REFERENCES trucks(id),
 before_data JSONB,after_data JSONB NOT NULL,reason TEXT NOT NULL,actor_user_id BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['commercial_plans','commercial_requests','commercial_quotes','commercial_quote_events','commercial_contracts','commercial_seat_events'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS commercial_immutable ON %I',t);
  EXECUTE format('CREATE TRIGGER commercial_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_resource_revision()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION commercial_lock(cid BIGINT) RETURNS void AS $$
BEGIN PERFORM pg_advisory_xact_lock(738038,cid::integer); END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION commercial_current(cid BIGINT) RETURNS SETOF commercial_contracts AS $$
 SELECT * FROM commercial_contracts WHERE company_id=cid AND period_from<=clock_timestamp()
 AND period_until>clock_timestamp() AND enabled_at<=clock_timestamp() ORDER BY id DESC LIMIT 1
$$ LANGUAGE sql VOLATILE;
CREATE OR REPLACE FUNCTION commercial_require(cid BIGINT,feature TEXT DEFAULT NULL,vehicle INTEGER DEFAULT NULL) RETURNS void AS $$
DECLARE c commercial_contracts; enforced BOOLEAN;
BEGIN
 PERFORM commercial_lock(cid);
 SELECT commercial_enforced INTO enforced FROM companies WHERE id=cid;
 IF NOT coalesce(enforced,false) THEN RETURN; END IF;
 SELECT * INTO c FROM commercial_current(cid);
 IF c.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P7501',MESSAGE='La empresa no tiene un período pagado vigente'; END IF;
 IF feature IS NOT NULL AND NOT (c.configuration->'modules' ? feature) THEN RAISE EXCEPTION USING ERRCODE='P7502',MESSAGE='El módulo no está contratado'; END IF;
 IF vehicle IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commercial_equipment_seats WHERE company_id=cid AND truck_id=vehicle AND active) THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='El equipo no está habilitado en los cupos pagados';
 END IF;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION commercial_category(kind TEXT) RETURNS TEXT AS $$
 SELECT CASE lower(regexp_replace(translate(kind,'óÓáÁéÉíÍúÚ','oOaAeEiIuU'),'[ _-]','','g'))
 WHEN 'camion' THEN 'truck' WHEN 'camionrigido' THEN 'truck' WHEN 'rigido' THEN 'truck'
 WHEN 'tractocamion' THEN 'tractor' WHEN 'tracto' THEN 'tractor' WHEN 'tractor' THEN 'tractor'
 WHEN 'remolque' THEN 'trailer' WHEN 'semirremolque' THEN 'trailer' WHEN 'trailer' THEN 'trailer'
 WHEN 'equipo' THEN 'equipment' WHEN 'equipment' THEN 'equipment' ELSE NULL END
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION commercial_running_gps(cid BIGINT,vehicle INTEGER DEFAULT NULL) RETURNS BOOLEAN AS $$
 SELECT EXISTS(SELECT 1 FROM trips WHERE company_id=cid AND status IN ('En tránsito','Detenido')
  AND (vehicle IS NULL OR truck_id=vehicle) AND (commercial_modules IS NULL OR commercial_modules ? 'gps'))
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION commercial_guard_seat() RETURNS trigger AS $$
DECLARE c commercial_contracts; actual_company BIGINT; actual_category TEXT; used INTEGER; future_cap INTEGER;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.company_id,NEW.truck_id) IS DISTINCT FROM ROW(OLD.company_id,OLD.truck_id) THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='La identidad de una habilitación no se sustituye sobrescribiendo su historial'; END IF;
 PERFORM commercial_lock(NEW.company_id);
 -- Do not wait for an identity edit that may itself be awaiting the company
 -- lock. Return a retryable conflict instead of creating a lock cycle.
 PERFORM 1 FROM trucks WHERE id=NEW.truck_id FOR KEY SHARE NOWAIT;
 SELECT company_id,commercial_category(tipo) INTO actual_company,actual_category FROM trucks WHERE id=NEW.truck_id;
 IF actual_company IS DISTINCT FROM NEW.company_id OR actual_category IS DISTINCT FROM NEW.category THEN
  RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='Selecciona un equipo y categoría de esta empresa'; END IF;
 IF NEW.active THEN
  PERFORM commercial_require(NEW.company_id);
  SELECT * INTO c FROM commercial_current(NEW.company_id);
  IF c.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P7501',MESSAGE='Configura y confirma el pago antes de habilitar equipos'; END IF;
  SELECT count(*) INTO used FROM commercial_equipment_seats WHERE company_id=NEW.company_id AND category=NEW.category AND active AND truck_id<>NEW.truck_id;
  IF used>=coalesce((c.configuration->'quantities'->>NEW.category)::integer,0) THEN RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='No quedan cupos pagados en esta categoría'; END IF;
  SELECT min((configuration->'quantities'->>NEW.category)::integer) INTO future_cap FROM
   (SELECT DISTINCT ON (period_from,period_until) configuration FROM commercial_contracts WHERE company_id=NEW.company_id AND period_until>clock_timestamp() ORDER BY period_from,period_until,id DESC) future;
  IF used>=future_cap THEN RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='Amplía también la renovación prepagada antes de habilitar este equipo'; END IF;
 ELSIF TG_OP='UPDATE' AND OLD.active THEN
  IF EXISTS(SELECT 1 FROM trips WHERE company_id=NEW.company_id AND (truck_id=NEW.truck_id OR trailer_id=NEW.truck_id) AND status NOT IN ('Completado','Cancelado'))
   OR EXISTS(SELECT 1 FROM maintenance WHERE company_id=NEW.company_id AND truck_id=NEW.truck_id AND status='En proceso') THEN
   RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='El equipo tiene viajes o mantenciones abiertos; no se libera su cupo'; END IF;
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commercial_seat_guard ON commercial_equipment_seats;
CREATE TRIGGER commercial_seat_guard BEFORE INSERT OR UPDATE ON commercial_equipment_seats FOR EACH ROW EXECUTE FUNCTION commercial_guard_seat();
CREATE OR REPLACE FUNCTION commercial_guard_contract() RETURNS trigger AS $$
DECLARE q commercial_quotes; expected INTEGER;
BEGIN
 PERFORM commercial_lock(NEW.company_id);
 SELECT commercial_version+1 INTO expected FROM companies WHERE id=NEW.company_id FOR NO KEY UPDATE;
 SELECT * INTO q FROM commercial_quotes WHERE id=NEW.quote_id AND company_id=NEW.company_id;
 IF q.id IS NULL OR NEW.version<>expected OR q.base_version<>expected-1 OR NEW.configuration IS DISTINCT FROM q.configuration
  OR NEW.period_from IS DISTINCT FROM q.period_from OR NEW.period_until IS DISTINCT FROM q.period_until
  OR NOT EXISTS(SELECT 1 FROM commercial_quote_events WHERE quote_id=q.id AND kind='accepted')
  OR NOT EXISTS(SELECT 1 FROM commercial_quote_events WHERE quote_id=q.id AND kind='paid' AND amount_clp=q.amount_clp AND nullif(trim(payment_reference),'') IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='P7501',MESSAGE='El contrato requiere propuesta aceptada, pago confirmado y versión vigente';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commercial_contract_guard ON commercial_contracts;
CREATE TRIGGER commercial_contract_guard BEFORE INSERT ON commercial_contracts FOR EACH ROW EXECUTE FUNCTION commercial_guard_contract();
CREATE OR REPLACE FUNCTION commercial_guard_operation() RETURNS trigger AS $$
DECLARE cid BIGINT; unit INTEGER; linked trips; ongoing BOOLEAN:=false; contract commercial_contracts;
BEGIN
 IF TG_TABLE_NAME='trips' THEN
  cid:=NEW.company_id;
  IF TG_OP='UPDATE' THEN
   NEW.commercial_modules:=OLD.commercial_modules;
   ongoing:=(OLD.actual_departure IS NOT NULL OR OLD.status IN ('En carga','En tránsito','Detenido','Llegó a destino','Descargando'))
    AND OLD.status NOT IN ('Completado','Cancelado') AND NEW.status NOT IN ('Planificado','Asignado')
    AND ROW(NEW.truck_id,NEW.trailer_id,NEW.driver_id,NEW.client_id) IS NOT DISTINCT FROM ROW(OLD.truck_id,OLD.trailer_id,OLD.driver_id,OLD.client_id);
   IF ongoing THEN RETURN NEW; END IF;
   IF ROW(NEW.truck_id,NEW.trailer_id,NEW.driver_id) IS NOT DISTINCT FROM ROW(OLD.truck_id,OLD.trailer_id,OLD.driver_id)
    AND NOT (NEW.status IN ('Asignado','En carga','En tránsito') AND NEW.status IS DISTINCT FROM OLD.status) THEN RETURN NEW; END IF;
  END IF;
  PERFORM commercial_require(cid,'operations',NEW.truck_id);
  IF NEW.trailer_id IS NOT NULL THEN PERFORM commercial_require(cid,'operations',NEW.trailer_id); END IF;
  SELECT * INTO contract FROM commercial_current(cid);
  IF contract.id IS NOT NULL THEN NEW.commercial_modules:=contract.configuration->'modules'; END IF;
 ELSIF TG_TABLE_NAME='maintenance' THEN
  IF TG_OP='UPDATE' AND NEW.truck_id IS NOT DISTINCT FROM OLD.truck_id AND
   (OLD.status='En proceso' AND NEW.status IN ('En proceso','Completada','Cancelada') OR OLD.status='Completada' AND NEW.status='Completada') THEN RETURN NEW; END IF;
  -- Releasing a paid/legacy job may generate its unique preventive successor.
  -- This is a pending reminder, not permission to admit another service.
  IF TG_OP='INSERT' AND NEW.previous_work_order_id IS NOT NULL AND NEW.status='Pendiente' AND NEW.operation_stage='scheduled'
   AND EXISTS(SELECT 1 FROM maintenance WHERE company_id=NEW.company_id AND truck_id=NEW.truck_id AND id=NEW.previous_work_order_id AND status='Completada' AND released_at IS NOT NULL AND routine IS NOT NULL) THEN RETURN NEW; END IF;
  PERFORM commercial_require(NEW.company_id,'maintenance',NEW.truck_id);
 ELSIF TG_TABLE_NAME='fuel' THEN
  PERFORM commercial_require(NEW.company_id,'fuel',NEW.truck_id);
 ELSIF TG_TABLE_NAME='telemetry' THEN
  SELECT company_id INTO cid FROM trucks WHERE id=NEW.truck_id;
  IF NEW.trip_id IS NOT NULL AND EXISTS(SELECT 1 FROM trips WHERE id=NEW.trip_id AND company_id=cid AND truck_id=NEW.truck_id AND status IN ('En tránsito','Detenido') AND (commercial_modules IS NULL OR commercial_modules ? 'gps')) THEN RETURN NEW; END IF;
  PERFORM commercial_require(cid,'gps',NEW.truck_id);
 ELSIF TG_TABLE_NAME='trucks' THEN
  PERFORM commercial_lock(least(OLD.company_id,NEW.company_id));
  IF OLD.company_id IS DISTINCT FROM NEW.company_id THEN PERFORM commercial_lock(greatest(OLD.company_id,NEW.company_id)); END IF;
  IF EXISTS(SELECT 1 FROM commercial_equipment_seats WHERE truck_id=OLD.id AND active) AND
   ROW(NEW.company_id,NEW.tipo,NEW.patente,NEW.vin) IS DISTINCT FROM ROW(OLD.company_id,OLD.tipo,OLD.patente,OLD.vin) THEN
   RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='La identidad de un equipo habilitado solo cambia mediante sustitución controlada'; END IF;
  IF ROW(NEW.lat,NEW.lng) IS DISTINCT FROM ROW(OLD.lat,OLD.lng) AND NOT commercial_running_gps(NEW.company_id,NEW.id) THEN PERFORM commercial_require(NEW.company_id,'gps',NEW.id); END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('En ruta','Mantención') THEN
   PERFORM commercial_require(NEW.company_id,CASE WHEN NEW.status='Mantención' THEN 'maintenance' ELSE 'operations' END,NEW.id); END IF;
 ELSIF TG_TABLE_NAME IN ('trip_loads','trip_delivery_proofs') THEN
  SELECT * INTO linked FROM trips WHERE id=NEW.trip_id;
  IF TG_TABLE_NAME='trip_delivery_proofs' AND (linked.commercial_modules IS NULL OR linked.commercial_modules ? 'pod') AND (linked.actual_departure IS NOT NULL OR linked.status IN ('En carga','En tránsito','Detenido','Llegó a destino','Descargando')) THEN RETURN NEW; END IF;
  PERFORM commercial_require(linked.company_id,CASE WHEN TG_TABLE_NAME='trip_loads' THEN 'operations' ELSE 'pod' END,linked.truck_id);
 ELSIF TG_TABLE_NAME IN ('routes','loads') THEN
  IF TG_TABLE_NAME='routes' THEN unit:=NEW.truck_id;
  ELSIF nullif(trim(NEW.truck),'') IS NOT NULL THEN
   SELECT id INTO unit FROM trucks WHERE company_id=NEW.company_id AND (patente=NEW.truck OR id::text=NEW.truck);
  END IF;
  PERFORM commercial_require(NEW.company_id,'operations',unit);
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['trips','maintenance','fuel','telemetry','trip_delivery_proofs'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS commercial_operation_guard ON %I',t);
  EXECUTE format('CREATE TRIGGER commercial_operation_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION commercial_guard_operation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['trip_loads','routes','loads'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS commercial_operation_guard ON %I',t);
  EXECUTE format('CREATE TRIGGER commercial_operation_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION commercial_guard_operation()',t);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS commercial_operation_guard ON trucks;
CREATE TRIGGER commercial_operation_guard BEFORE UPDATE ON trucks FOR EACH ROW EXECUTE FUNCTION commercial_guard_operation();
DROP TRIGGER IF EXISTS commercial_load_transfer_guard ON trip_loads;
CREATE TRIGGER commercial_load_transfer_guard BEFORE UPDATE OF trip_id ON trip_loads FOR EACH ROW EXECUTE FUNCTION commercial_guard_operation();
COMMIT;
