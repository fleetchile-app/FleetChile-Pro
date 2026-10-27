BEGIN;
CREATE TABLE IF NOT EXISTS company_access_profiles(
 id BIGSERIAL PRIMARY KEY,
 company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 base_role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 permissions JSONB NOT NULL CHECK(jsonb_typeof(permissions)='array'),
 active BOOLEAN NOT NULL DEFAULT true,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 UNIQUE(company_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_access_profile_name ON company_access_profiles(company_id,lower(name));
ALTER TABLE user_memberships ADD COLUMN IF NOT EXISTS access_profile_id BIGINT;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='membership_access_profile_company') THEN
  ALTER TABLE user_memberships ADD CONSTRAINT membership_access_profile_company
   FOREIGN KEY(company_id,access_profile_id) REFERENCES company_access_profiles(company_id,id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION validate_company_access_profile() RETURNS trigger AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM roles WHERE id=NEW.base_role_id AND code IN ('manager','operations','maintenance','driver','viewer','administrative')) THEN
  RAISE EXCEPTION 'El perfil requiere un rol empresarial no privilegiado';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.permissions) x(code) WHERE NOT EXISTS(
  SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
  WHERE rp.role_id=NEW.base_role_id AND p.scope='company' AND p.code=x.code)) THEN
  RAISE EXCEPTION 'Un perfil no amplía los permisos de su rol base';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.company_id<>OLD.company_id OR NEW.base_role_id<>OLD.base_role_id) THEN
  RAISE EXCEPTION 'Empresa y rol base son inmutables';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS validate_company_access_profile ON company_access_profiles;
CREATE TRIGGER validate_company_access_profile BEFORE INSERT OR UPDATE ON company_access_profiles
 FOR EACH ROW EXECUTE FUNCTION validate_company_access_profile();
CREATE OR REPLACE FUNCTION validate_membership_access_profile() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.role_id<>OLD.role_id THEN NEW.access_profile_id=NULL; END IF;
 IF NEW.access_profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_access_profiles
  WHERE company_id=NEW.company_id AND id=NEW.access_profile_id AND base_role_id=NEW.role_id AND active) THEN
  RAISE EXCEPTION 'Perfil no disponible para la empresa y rol de la membership';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS validate_membership_access_profile ON user_memberships;
CREATE TRIGGER validate_membership_access_profile BEFORE INSERT OR UPDATE OF role_id,access_profile_id ON user_memberships
 FOR EACH ROW EXECUTE FUNCTION validate_membership_access_profile();
CREATE OR REPLACE FUNCTION company_membership_permissions(mid BIGINT) RETURNS TABLE(code TEXT) AS $$
 SELECT p.code FROM user_memberships m JOIN role_permissions rp ON rp.role_id=m.role_id
 JOIN permissions p ON p.id=rp.permission_id AND p.scope='company'
 LEFT JOIN company_access_profiles a ON a.id=m.access_profile_id AND a.company_id=m.company_id AND a.base_role_id=m.role_id
 WHERE m.id=mid AND m.active AND (m.access_profile_id IS NULL OR (a.active AND a.permissions ? p.code))
 ORDER BY p.code
$$ LANGUAGE SQL STABLE;

CREATE TABLE IF NOT EXISTS enterprise_events(
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,actor_name TEXT NOT NULL,
 kind TEXT NOT NULL,entity_id TEXT,reason TEXT NOT NULL,before_data JSONB,after_data JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS enterprise_event_immutable ON enterprise_events;
CREATE TRIGGER enterprise_event_immutable BEFORE UPDATE OR DELETE ON enterprise_events
 FOR EACH ROW EXECUTE FUNCTION company_branding_immutable();

INSERT INTO roles(code,name,description) VALUES('platform_support','Soporte acotado','Sin administración global; acceso temporal por empresa autorizada') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='platform_support' AND p.code='platform.context.switch' ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS company_support_grants(
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 scopes JSONB NOT NULL CHECK(jsonb_typeof(scopes)='array' AND scopes <@ '["people","branding","profiles","imports"]'::jsonb AND jsonb_array_length(scopes)>0),
 expires_at TIMESTAMPTZ NOT NULL,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by BIGINT NOT NULL REFERENCES users(id),revoked_at TIMESTAMPTZ,revoked_by BIGINT REFERENCES users(id),
 UNIQUE(company_id,id),CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS company_support_cases(
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 grant_id BIGINT NOT NULL,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL,opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL,closed_at TIMESTAMPTZ,
 FOREIGN KEY(company_id,grant_id) REFERENCES company_support_grants(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS company_support_case_lookup ON company_support_cases(user_id,company_id,expires_at);
CREATE TABLE IF NOT EXISTS company_import_batches(
 id UUID PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('clients','vehicles','people')),
 rows JSONB NOT NULL,preview JSONB NOT NULL,source_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 committed_at TIMESTAMPTZ,result JSONB
);
COMMIT;
