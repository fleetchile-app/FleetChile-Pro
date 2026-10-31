-- Tracking identity is immutable in the API; tokens are never stored in plaintext.
CREATE TABLE IF NOT EXISTS driver_tracking_sessions (
 id uuid PRIMARY KEY,
 company_id bigint NOT NULL REFERENCES companies(id),
 user_id bigint NOT NULL REFERENCES users(id),
 auth_session_id bigint NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
 token_hash text NOT NULL,
 trip_id integer NOT NULL,
 driver_id integer NOT NULL,
 truck_id integer NOT NULL,
 resource_version integer NOT NULL,
 itinerary_version integer NOT NULL,
 outing_id bigint,
 interval_seconds integer NOT NULL DEFAULT 30 CHECK(interval_seconds BETWEEN 15 AND 300),
 last_state text NOT NULL CHECK(last_state IN ('active','waiting','returning','closed')),
 phase_since timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 closed_at timestamptz,
 review_required boolean NOT NULL DEFAULT false,
 close_reason text,
 FOREIGN KEY(company_id,trip_id) REFERENCES trips(company_id,id),
 FOREIGN KEY(company_id,driver_id) REFERENCES drivers(company_id,id),
 FOREIGN KEY(company_id,truck_id) REFERENCES trucks(company_id,id),
 FOREIGN KEY(outing_id,company_id) REFERENCES operational_outings(id,company_id),
 CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_tracking_open ON driver_tracking_sessions(auth_session_id,trip_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS driver_tracking_company ON driver_tracking_sessions(company_id);
CREATE TABLE IF NOT EXISTS driver_tracking_positions (
 company_id bigint NOT NULL REFERENCES companies(id),
 tracking_session_id uuid NOT NULL REFERENCES driver_tracking_sessions(id) ON DELETE CASCADE,
 client_position_id uuid NOT NULL,
 payload_hash text NOT NULL,
 telemetry_id bigint NOT NULL REFERENCES telemetry(id) ON DELETE CASCADE,
 captured_at timestamptz NOT NULL,
 accuracy_m double precision NOT NULL CHECK(accuracy_m>=0),
 state text NOT NULL CHECK(state IN ('active','waiting','returning')),
 PRIMARY KEY(tracking_session_id,client_position_id)
);
CREATE INDEX IF NOT EXISTS driver_tracking_positions_company ON driver_tracking_positions(company_id);

-- Keep legacy authorization fallback; extend only valid trip/outing snapshots.
CREATE OR REPLACE FUNCTION operational_outing_telemetry_guard() RETURNS trigger AS $$
DECLARE cid bigint;
BEGIN
 SELECT company_id INTO cid FROM trucks WHERE id=NEW.truck_id;
 IF NEW.outing_id IS NOT NULL THEN
  IF NEW.trip_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM operational_outings o WHERE o.id=NEW.outing_id AND o.company_id=cid
    AND o.truck_id=NEW.truck_id AND o.closed_at IS NULL
    AND (o.status='returning' OR (o.status IN ('waiting','in_service') AND EXISTS(
     SELECT 1 FROM operational_outing_services s JOIN trips t ON t.id=s.trip_id AND t.company_id=s.company_id
     WHERE s.outing_id=o.id AND s.company_id=o.company_id AND t.status IN ('Completado','Cancelado')
      AND t.truck_id=o.truck_id AND t.driver_id=o.driver_id
      AND s.sequence=(SELECT max(sequence) FROM operational_outing_services WHERE outing_id=o.id AND company_id=o.company_id))))
    AND (o.commercial_modules IS NULL OR o.commercial_modules ? 'gps')) THEN
   RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='La posición requiere una salida abierta autorizada para GPS';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.trip_id IS NOT NULL AND EXISTS(SELECT 1 FROM trips WHERE id=NEW.trip_id AND company_id=cid AND truck_id=NEW.truck_id
  AND status IN ('En carga','En tránsito','Detenido','Llegó a destino','Descargando')
  AND (commercial_modules IS NULL OR commercial_modules ? 'gps')) THEN RETURN NEW; END IF;
 PERFORM commercial_require(cid,'gps',NEW.truck_id);
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
