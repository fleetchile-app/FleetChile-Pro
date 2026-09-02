BEGIN;

-- FleetChile Pro - Platform/Company identity foundation
-- Additive migration. Legacy users.company_id/users.role_id remain available.

ALTER TABLE permissions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'company';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='permissions_scope_valid') THEN
    ALTER TABLE permissions ADD CONSTRAINT permissions_scope_valid CHECK (scope IN ('platform','company')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_memberships (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, company_id)
);
CREATE TABLE IF NOT EXISTS platform_memberships (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_memberships_company_active ON user_memberships(company_id,active,user_id);
CREATE INDEX IF NOT EXISTS idx_user_memberships_user_active ON user_memberships(user_id,active,company_id);
CREATE INDEX IF NOT EXISTS idx_platform_memberships_active ON platform_memberships(user_id,active);

INSERT INTO roles(code,name,description) VALUES
 ('platform_superadmin','Superadmin de plataforma','Administración transversal de la plataforma'),
 ('company_admin','Administrador de empresa','Administración de una empresa')
ON CONFLICT (code) DO NOTHING;
INSERT INTO permissions(code,name,module,scope) VALUES
 ('platform.companies.manage','Administrar empresas','platform','platform'),
 ('platform.users.manage','Administrar usuarios de plataforma','platform','platform'),
 ('platform.context.switch','Cambiar contexto empresarial','platform','platform'),
 ('company.users.manage','Administrar usuarios de empresa','admin','company')
ON CONFLICT (code) DO UPDATE SET scope=excluded.scope;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE (r.code='platform_superadmin' AND p.scope='platform')
   OR (r.code='company_admin' AND p.code='company.users.manage')
ON CONFLICT DO NOTHING;

-- Backfill only unambiguous company membership; legacy admin intent is not
-- converted to platform_superadmin automatically.
INSERT INTO user_memberships(user_id,company_id,role_id,active)
SELECT u.id,u.company_id,CASE WHEN r.code='admin' THEN cr.id ELSE u.role_id END,u.active
FROM users u JOIN roles r ON r.id=u.role_id JOIN roles cr ON cr.code='company_admin'
WHERE u.company_id IS NOT NULL AND u.role_id IS NOT NULL
ON CONFLICT (user_id,company_id) DO NOTHING;

COMMIT;
