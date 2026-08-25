-- Fase 5.1: asociación segura de usuario driver con un conductor.
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_id INTEGER;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_driver_fk;
ALTER TABLE users ADD CONSTRAINT users_driver_fk
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_driver_id
  ON users(driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_company_driver
  ON users(company_id,driver_id);

CREATE OR REPLACE FUNCTION validate_user_driver_company()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE driver_company BIGINT;
BEGIN
  IF NEW.driver_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'Un usuario driver asociado requiere company_id';
  END IF;
  SELECT company_id INTO driver_company FROM drivers WHERE id=NEW.driver_id;
  IF driver_company IS NULL OR driver_company<>NEW.company_id THEN
    RAISE EXCEPTION 'El usuario y el conductor deben pertenecer a la misma empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_user_driver_company ON users;
CREATE TRIGGER trg_validate_user_driver_company
  BEFORE INSERT OR UPDATE OF company_id,driver_id ON users
  FOR EACH ROW EXECUTE FUNCTION validate_user_driver_company();

CREATE OR REPLACE FUNCTION prevent_driver_company_change_when_assigned()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     AND EXISTS (SELECT 1 FROM users WHERE driver_id=NEW.id) THEN
    RAISE EXCEPTION 'No se puede cambiar la empresa de un conductor asociado';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_driver_company_change_when_assigned ON drivers;
CREATE TRIGGER trg_prevent_driver_company_change_when_assigned
  BEFORE UPDATE OF company_id ON drivers
  FOR EACH ROW EXECUTE FUNCTION prevent_driver_company_change_when_assigned();
