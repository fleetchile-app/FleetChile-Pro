-- FleetChile Pro - Fase 4.3 / autorizaciones económicas
-- Solicitudes explícitas y resolución transaccional; no aplica todavía el cambio económico.
BEGIN;

CREATE TABLE IF NOT EXISTS economic_authorization_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL,
  requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cost_version_id BIGINT,
  requested_revenue_clp BIGINT,
  resolved_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ,
  resolution_reason TEXT,
  reauthenticated_at TIMESTAMPTZ,
  CONSTRAINT economic_authorizations_company_trip_fk
    FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id) ON DELETE CASCADE,
  CONSTRAINT economic_authorizations_type_valid
    CHECK (request_type IN ('revenue_change','cost_version')),
  CONSTRAINT economic_authorizations_status_valid
    CHECK (status IN ('pending','approved','rejected')),
  CONSTRAINT economic_authorizations_reason_required
    CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  CONSTRAINT economic_authorizations_resolution_consistent
    CHECK ((status='pending' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL AND reauthenticated_at IS NULL)
      OR (status IN ('approved','rejected') AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
        AND NULLIF(BTRIM(resolution_reason), '') IS NOT NULL AND reauthenticated_at IS NOT NULL)),
  CONSTRAINT economic_authorizations_different_users
    CHECK (resolved_by IS NULL OR resolved_by <> requested_by),
  CONSTRAINT economic_authorizations_revenue_nonnegative
    CHECK (requested_revenue_clp IS NULL OR requested_revenue_clp >= 0),
  CONSTRAINT economic_authorizations_target_valid
    CHECK ((request_type='revenue_change' AND cost_version_id IS NULL)
      OR (request_type='cost_version' AND cost_version_id IS NOT NULL))
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='economic_authorizations_cost_version_fk') THEN
    ALTER TABLE economic_authorization_requests ADD CONSTRAINT economic_authorizations_cost_version_fk
      FOREIGN KEY (cost_version_id) REFERENCES trip_cost_versions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_revenue_history_authorization_fk') THEN
    ALTER TABLE trip_revenue_history ADD CONSTRAINT trip_revenue_history_authorization_fk
      FOREIGN KEY (authorization_request_id) REFERENCES economic_authorization_requests(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_cost_versions_authorization_fk') THEN
    ALTER TABLE trip_cost_versions ADD CONSTRAINT trip_cost_versions_authorization_fk
      FOREIGN KEY (authorization_request_id) REFERENCES economic_authorization_requests(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_economic_authorizations_company_status
  ON economic_authorization_requests(company_id,status,requested_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_economic_authorizations_company_trip
  ON economic_authorization_requests(company_id,trip_id,requested_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_economic_authorizations_pending_target
  ON economic_authorization_requests(company_id,cost_version_id)
  WHERE status='pending' AND cost_version_id IS NOT NULL;

COMMIT;
