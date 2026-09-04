BEGIN;

-- Ownership is deliberately separate from roles and memberships.
CREATE TABLE IF NOT EXISTS platform_owners (
  slot SMALLINT PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('primary','backup')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_owners_active ON platform_owners(active);

CREATE OR REPLACE FUNCTION validate_platform_owner_slot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(8246);
  IF (NEW.slot <= 2 AND NEW.owner_type <> 'primary') OR (NEW.slot >= 3 AND NEW.owner_type <> 'backup') THEN
    RAISE EXCEPTION 'El tipo de propietario no corresponde al slot';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_validate_platform_owner_slot ON platform_owners;
CREATE TRIGGER trg_validate_platform_owner_slot
BEFORE INSERT OR UPDATE ON platform_owners
FOR EACH ROW EXECUTE FUNCTION validate_platform_owner_slot();

COMMIT;
