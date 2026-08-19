-- FleetChile Pro - Fase 4.1.1 / fundaciones economicas
-- Additive only. No legacy economic data is interpreted or backfilled.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_company_id_id
  ON trips(company_id, id);

CREATE TABLE IF NOT EXISTS trip_economic_profiles (
  trip_id BIGINT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revenue_defined BOOLEAN NOT NULL DEFAULT false,
  revenue_includes_vat BOOLEAN,
  revenue_confirmed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  revenue_confirmed_at TIMESTAMPTZ,
  economic_status TEXT NOT NULL DEFAULT 'open',
  tag_pending BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trip_economic_profiles_company_trip_fk
    FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_economic_profiles_status_valid
    CHECK (economic_status IN ('open','pending_reconciliation','ready_to_close','closed')),
  CONSTRAINT trip_economic_profiles_revenue_metadata_valid
    CHECK (
      revenue_defined
      OR (
        revenue_includes_vat IS NULL
        AND revenue_confirmed_by IS NULL
        AND revenue_confirmed_at IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_trip_economic_profiles_company_status
  ON trip_economic_profiles(company_id, economic_status, trip_id);

CREATE TABLE IF NOT EXISTS trip_revenue_history (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  previous_revenue_clp BIGINT,
  new_revenue_clp BIGINT,
  revenue_defined BOOLEAN NOT NULL,
  includes_vat BOOLEAN,
  zero_justification TEXT,
  change_reason TEXT,
  authorization_request_id BIGINT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trip_revenue_history_company_trip_fk
    FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_revenue_history_previous_nonnegative
    CHECK (previous_revenue_clp IS NULL OR previous_revenue_clp >= 0),
  CONSTRAINT trip_revenue_history_new_nonnegative
    CHECK (new_revenue_clp IS NULL OR new_revenue_clp >= 0),
  CONSTRAINT trip_revenue_history_definition_valid
    CHECK (
      (revenue_defined AND new_revenue_clp IS NOT NULL)
      OR (NOT revenue_defined AND new_revenue_clp IS NULL)
    ),
  CONSTRAINT trip_revenue_history_zero_justification_required
    CHECK (
      NOT revenue_defined
      OR new_revenue_clp <> 0
      OR NULLIF(BTRIM(zero_justification), '') IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_trip_revenue_history_company_trip_created
  ON trip_revenue_history(company_id, trip_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS economic_cost_categories (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  cost_group TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO economic_cost_categories(code,name,cost_group,active) VALUES
  ('fuel','Combustible','direct',true),
  ('toll','Peajes','direct',true),
  ('parking','Estacionamiento','direct',true),
  ('per_diem','Viáticos','direct',true),
  ('other_direct','Otros gastos directos','direct',true),
  ('commission','Comisiones','direct',false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS trip_cost_items (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  category_id BIGINT NOT NULL REFERENCES economic_cost_categories(id) ON DELETE RESTRICT,
  current_version_id BIGINT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trip_cost_items_company_trip_fk
    FOREIGN KEY (company_id, trip_id) REFERENCES trips(company_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_cost_items_status_valid
    CHECK (status IN ('active','reconciled','voided')),
  CONSTRAINT uq_trip_cost_items_company_id_id UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_trip_cost_items_company_trip_status
  ON trip_cost_items(company_id, trip_id, status, id);
CREATE INDEX IF NOT EXISTS idx_trip_cost_items_company_category
  ON trip_cost_items(company_id, category_id, status, id);

CREATE TABLE IF NOT EXISTS trip_cost_versions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_cost_item_id BIGINT NOT NULL REFERENCES trip_cost_items(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  cost_basis TEXT NOT NULL,
  amount_clp BIGINT NOT NULL,
  amount_includes_vat BOOLEAN,
  support_status TEXT,
  justification TEXT,
  description TEXT,
  effective_date DATE,
  status TEXT NOT NULL DEFAULT 'draft',
  supersedes_version_id BIGINT REFERENCES trip_cost_versions(id) ON DELETE RESTRICT,
  authorization_request_id BIGINT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trip_cost_versions_company_item_fk
    FOREIGN KEY (company_id, trip_cost_item_id)
    REFERENCES trip_cost_items(company_id, id) ON DELETE CASCADE,
  CONSTRAINT trip_cost_versions_version_positive CHECK (version_number > 0),
  CONSTRAINT trip_cost_versions_basis_valid
    CHECK (cost_basis IN ('planned','observed','allocated','indirect')),
  CONSTRAINT trip_cost_versions_amount_nonnegative CHECK (amount_clp >= 0),
  CONSTRAINT trip_cost_versions_support_valid
    CHECK (support_status IS NULL OR support_status IN ('documented','undocumented')),
  CONSTRAINT trip_cost_versions_undocumented_justification_required
    CHECK (
      support_status <> 'undocumented'
      OR NULLIF(BTRIM(justification), '') IS NOT NULL
    ),
  CONSTRAINT trip_cost_versions_status_valid
    CHECK (status IN ('draft','pending_approval','approved','rejected','superseded','reconciled','voided')),
  CONSTRAINT uq_trip_cost_versions_item_version UNIQUE (trip_cost_item_id, version_number),
  CONSTRAINT uq_trip_cost_versions_item_id UNIQUE (trip_cost_item_id, id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trip_cost_items_current_version_fk'
  ) THEN
    ALTER TABLE trip_cost_items
      ADD CONSTRAINT trip_cost_items_current_version_fk
      FOREIGN KEY (id, current_version_id)
      REFERENCES trip_cost_versions(trip_cost_item_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trip_cost_versions_company_item_created
  ON trip_cost_versions(company_id, trip_cost_item_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_trip_cost_versions_company_basis_status
  ON trip_cost_versions(company_id, cost_basis, status, effective_date, id);

INSERT INTO permissions(code,name,module) VALUES
  ('economics.read','Ver información económica operacional','economics'),
  ('economics.manage','Gestionar información económica operacional','economics'),
  ('economics.approve','Aprobar operaciones económicas','economics'),
  ('economics.close','Cerrar económicamente viajes','economics'),
  ('economics.export','Exportar información económica operacional','economics')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'economics.read','economics.manage','economics.approve','economics.close','economics.export'
)
WHERE
  r.code = 'admin'
  OR (r.code = 'operations' AND p.code IN ('economics.read','economics.manage','economics.export'))
  OR (r.code = 'manager' AND p.code IN ('economics.read','economics.manage','economics.approve','economics.close','economics.export'))
  OR (r.code = 'viewer' AND p.code = 'economics.read')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE trip_economic_profiles IS 'Perfil económico operacional del viaje. Su ausencia identifica viajes legacy no verificados.';
COMMENT ON TABLE trip_revenue_history IS 'Historial append-only de definiciones y cambios del ingreso operacional esperado del viaje.';
COMMENT ON TABLE trip_cost_items IS 'Identidad estable de un costo directo o asignado a un viaje.';
COMMENT ON TABLE trip_cost_versions IS 'Versiones append-only de costos del viaje; los costos indirectos no integran automáticamente el Delta Operacional.';

COMMIT;
