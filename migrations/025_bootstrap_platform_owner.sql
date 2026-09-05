BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Bootstrap técnico idempotente. La contraseña nunca se almacena en texto plano.
DO $$
DECLARE
  owner_user_id BIGINT;
  platform_role_id BIGINT;
BEGIN
  SELECT id INTO platform_role_id FROM roles WHERE code='platform_superadmin';
  IF platform_role_id IS NULL THEN
    RAISE EXCEPTION 'No existe el rol platform_superadmin';
  END IF;

  INSERT INTO users(company_id,role_id,name,email,password_hash,active,must_change_password)
  VALUES (NULL,platform_role_id,'FleetChile Platform Owner','root@fleetchile.local','scrypt$8c7efc2201b4a425acd061fff04da8d5$d42273de1ec502cbbcc30deefe72c7e1361039d1b028f6eb8e2f4085eb330b322175630fc293574c26edc651d7a32252abf5d85a0671378228b8e54f7e39b992',true,true)
  ON CONFLICT (email) DO NOTHING
  RETURNING id INTO owner_user_id;

  IF owner_user_id IS NOT NULL THEN
    INSERT INTO platform_memberships(user_id,role_id,active)
    VALUES(owner_user_id,platform_role_id,true)
    ON CONFLICT (user_id) DO NOTHING;
    INSERT INTO platform_owners(slot,user_id,owner_type,active)
    VALUES(1,owner_user_id,'primary',true)
    ON CONFLICT DO NOTHING;
    INSERT INTO audit_logs(company_id,user_id,action,entity,entity_id,after_data)
    VALUES(NULL,owner_user_id,'bootstrap','platform_owner','1',jsonb_build_object('owner_type','primary','slot',1));
  END IF;
END $$;

COMMIT;
