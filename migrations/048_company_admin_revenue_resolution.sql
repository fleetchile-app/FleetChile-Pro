BEGIN;
ALTER TABLE economic_authorization_requests ADD COLUMN IF NOT EXISTS self_resolution BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE economic_authorization_requests DROP CONSTRAINT IF EXISTS economic_authorizations_different_users;
ALTER TABLE economic_authorization_requests ADD CONSTRAINT economic_authorizations_different_users CHECK (
 (NOT self_resolution AND (resolved_by IS NULL OR resolved_by<>requested_by)) OR
 (self_resolution AND request_type='revenue_change' AND resolved_by IS NOT NULL AND resolved_by=requested_by)
);
CREATE OR REPLACE FUNCTION guard_revenue_self_resolution() RETURNS trigger AS $$ BEGIN
 IF NEW.self_resolution AND NOT EXISTS(
  SELECT 1 FROM user_memberships m JOIN roles r ON r.id=m.role_id JOIN users u ON u.id=m.user_id
  WHERE m.user_id=NEW.resolved_by AND m.company_id=NEW.company_id AND m.active AND u.active AND r.code IN ('company_admin','manager')
  AND EXISTS(SELECT 1 FROM company_membership_permissions(m.id) p WHERE p.code='economics.approve')
 ) THEN RAISE EXCEPTION 'Solo un administrador empresarial activo o gerente con permiso de aprobación puede resolver su propio ingreso' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS revenue_self_resolution_guard ON economic_authorization_requests;
CREATE TRIGGER revenue_self_resolution_guard BEFORE INSERT OR UPDATE ON economic_authorization_requests FOR EACH ROW EXECUTE FUNCTION guard_revenue_self_resolution();
COMMIT;
