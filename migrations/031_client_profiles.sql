BEGIN;
CREATE SEQUENCE IF NOT EXISTS client_code_seq;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_code TEXT;
UPDATE clients SET client_code='CLI-LEGACY-'||id::text WHERE client_code IS NULL;
ALTER TABLE clients ALTER COLUMN client_code SET DEFAULT ('CLI-'||lpad(nextval('client_code_seq')::text,8,'0'));
ALTER TABLE clients ALTER COLUMN client_code SET NOT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS normalized_rut TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS identity_type TEXT CHECK(identity_type IN ('person','company'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS street TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS street_number TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS commune_id BIGINT REFERENCES geo_communes(id) ON DELETE RESTRICT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS social_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_contact TEXT CHECK(preferred_contact IN ('call','whatsapp','email'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS segment TEXT CHECK(segment IN ('retail','wholesale'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS relationship TEXT NOT NULL DEFAULT 'customer' CHECK(relationship IN ('prospect','customer','recurring'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS branch_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_person_id BIGINT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_company_id ON clients(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_code ON clients(company_id,lower(client_code));
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_rut ON clients(company_id,normalized_rut) WHERE normalized_rut IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='client_assigned_person_company') THEN
  ALTER TABLE clients ADD CONSTRAINT client_assigned_person_company FOREIGN KEY(company_id,assigned_person_id) REFERENCES company_people(company_id,id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_clients_company_search ON clients(company_id,active,lower(name),id);
CREATE TABLE IF NOT EXISTS client_profile_events(
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,client_id BIGINT NOT NULL,
 actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,actor_name TEXT NOT NULL,
 action TEXT NOT NULL,before_data JSONB,after_data JSONB,reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,client_id) REFERENCES clients(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_client_profile_events ON client_profile_events(company_id,client_id,id DESC);
DROP TRIGGER IF EXISTS trg_client_profile_event_immutable ON client_profile_events;
CREATE OR REPLACE FUNCTION client_profile_event_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'El historial de clientes es inmutable'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_client_profile_event_immutable BEFORE UPDATE OR DELETE ON client_profile_events
 FOR EACH ROW EXECUTE FUNCTION client_profile_event_immutable();
CREATE TABLE IF NOT EXISTS client_consent_documents(
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,client_id BIGINT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('template','signed')),current BOOLEAN NOT NULL DEFAULT true,
 storage_key TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,mime_type TEXT NOT NULL CHECK(mime_type='application/pdf'),
 size INTEGER NOT NULL CHECK(size>0 AND size<=1048576),sha256 TEXT NOT NULL,
 signer_name TEXT,signer_capacity TEXT,signed_on DATE,
 uploaded_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,uploaded_by_name TEXT NOT NULL,
 reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,client_id) REFERENCES clients(company_id,id) ON DELETE RESTRICT,
 CHECK(kind<>'signed' OR (signer_name IS NOT NULL AND length(btrim(signer_name))>0 AND signed_on IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_consent_document ON client_consent_documents(company_id,client_id,kind) WHERE current;
CREATE TABLE IF NOT EXISTS client_privacy_status(
 company_id BIGINT NOT NULL,client_id BIGINT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','recorded','revoked')),
 updated_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),reason TEXT NOT NULL,
 PRIMARY KEY(company_id,client_id),FOREIGN KEY(company_id,client_id) REFERENCES clients(company_id,id) ON DELETE RESTRICT
);
COMMIT;
