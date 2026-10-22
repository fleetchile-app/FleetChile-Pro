BEGIN;

-- Additive personnel declaration and access policy. Existing companies are
-- explicitly in regularization mode; no contracts or exemptions are invented.
CREATE TABLE IF NOT EXISTS company_personnel_policies (
 company_id BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
 enforced BOOLEAN NOT NULL DEFAULT false,
 regularization_before TIMESTAMPTZ NOT NULL DEFAULT now(),
 time_zone TEXT NOT NULL DEFAULT 'America/Santiago',
 activated_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 activated_at TIMESTAMPTZ
);
INSERT INTO company_personnel_policies(company_id,enforced)
 SELECT id,false FROM companies ON CONFLICT(company_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_company_id ON user_memberships(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_company_id ON drivers(company_id,id);
CREATE TABLE IF NOT EXISTS company_people (
 id BIGSERIAL PRIMARY KEY,
 company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 membership_id BIGINT REFERENCES user_memberships(id) ON DELETE RESTRICT,
 driver_id INTEGER REFERENCES drivers(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
 rut TEXT CHECK(rut IS NULL OR rut ~ '^[0-9]{1,8}-[0-9K]$'),
 birth_date DATE,
 job_title TEXT NOT NULL DEFAULT '' CHECK(length(job_title)<=160),
 contract_exempt BOOLEAN NOT NULL DEFAULT false,
 exemption_reason TEXT,
 exemption_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 exemption_at TIMESTAMPTZ,
 created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 updated_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(company_id,id), UNIQUE(company_id,rut), UNIQUE(company_id,user_id),
 UNIQUE(membership_id), UNIQUE(company_id,driver_id),
 CHECK((user_id IS NULL)=(membership_id IS NULL)),
 CHECK(NOT contract_exempt OR (exemption_by IS NOT NULL AND exemption_at IS NOT NULL AND exemption_reason IS NOT NULL AND length(btrim(exemption_reason))>0)),
 FOREIGN KEY(company_id,membership_id) REFERENCES user_memberships(company_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(company_id,driver_id) REFERENCES drivers(company_id,id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION validate_company_person_membership() RETURNS trigger AS $$
BEGIN
 IF NEW.membership_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM user_memberships m WHERE m.id=NEW.membership_id
   AND m.company_id=NEW.company_id AND m.user_id=NEW.user_id
 ) THEN RAISE EXCEPTION 'Membership de persona incompatible con usuario o empresa' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_company_person_membership ON company_people;
CREATE TRIGGER trg_company_person_membership BEFORE INSERT OR UPDATE ON company_people
 FOR EACH ROW EXECUTE FUNCTION validate_company_person_membership();

CREATE TABLE IF NOT EXISTS person_contracts (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, person_id BIGINT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('indefinite','fixed','day','event')),
 start_date DATE NOT NULL, end_date DATE, event_name TEXT,
 voided_at TIMESTAMPTZ, voided_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,person_id) REFERENCES company_people(company_id,id) ON DELETE RESTRICT,
 CHECK((type='indefinite' AND end_date IS NULL) OR (type<>'indefinite' AND end_date IS NOT NULL AND end_date>=start_date)),
 CHECK(type<>'day' OR end_date=start_date),
 CHECK(type<>'event' OR (event_name IS NOT NULL AND length(btrim(event_name))>0))
);
CREATE TABLE IF NOT EXISTS person_conditions (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, person_id BIGINT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('permission','medical_leave','vacation','suspended')),
 start_date DATE NOT NULL, end_date DATE NOT NULL CHECK(end_date>=start_date),
 cancelled_at TIMESTAMPTZ, cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,person_id) REFERENCES company_people(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS person_driver_licenses (
 id BIGSERIAL PRIMARY KEY, company_id BIGINT NOT NULL, person_id BIGINT NOT NULL,
 classes TEXT[] NOT NULL CHECK(cardinality(classes)>0 AND array_position(classes,NULL) IS NULL AND classes <@ ARRAY['A1','A2','A3','A4','A5','B','C','CR','D','E','F','A1_OLD','A2_OLD']::text[]),
 issued_date DATE, printed_expiry DATE NOT NULL, effective_expiry DATE NOT NULL CHECK(effective_expiry>=printed_expiry),
 current BOOLEAN NOT NULL DEFAULT true,
 created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,person_id) REFERENCES company_people(company_id,id) ON DELETE RESTRICT,
 CHECK(issued_date IS NULL OR issued_date<=printed_expiry)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_current_license ON person_driver_licenses(company_id,person_id) WHERE current;
CREATE INDEX IF NOT EXISTS idx_people_company_name ON company_people(company_id,lower(name),id);
CREATE INDEX IF NOT EXISTS idx_person_contract_dates ON person_contracts(company_id,person_id,start_date,end_date) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_person_condition_dates ON person_conditions(company_id,person_id,start_date,end_date) WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS person_events (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,person_id BIGINT NOT NULL,
 actor_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 actor_name TEXT NOT NULL,action TEXT NOT NULL,
 before_data JSONB,after_data JSONB,reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,person_id) REFERENCES company_people(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_person_events ON person_events(company_id,person_id,id DESC);
CREATE OR REPLACE FUNCTION personnel_event_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'El historial de personas es inmutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_person_event_immutable ON person_events;
CREATE TRIGGER trg_person_event_immutable BEFORE UPDATE OR DELETE ON person_events
 FOR EACH ROW EXECUTE FUNCTION personnel_event_immutable();

CREATE TABLE IF NOT EXISTS personnel_notifications (
 id BIGSERIAL PRIMARY KEY,company_id BIGINT NOT NULL,person_id BIGINT NOT NULL,
 event_key TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(company_id,event_key),
 FOREIGN KEY(company_id,person_id) REFERENCES company_people(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_personnel_notifications ON personnel_notifications(company_id,id DESC);
CREATE TABLE IF NOT EXISTS personnel_notification_reads (
 notification_id BIGINT NOT NULL REFERENCES personnel_notifications(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 read_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(notification_id,user_id)
);

-- Newly provisioned companies enforce declarations from their first account.
CREATE OR REPLACE FUNCTION create_personnel_company_policy() RETURNS trigger AS $$
BEGIN
 INSERT INTO company_personnel_policies(company_id,enforced) VALUES(NEW.id,true) ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_new_company_personnel_policy ON companies;
CREATE TRIGGER trg_new_company_personnel_policy AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION create_personnel_company_policy();

INSERT INTO permissions(code,name,module,scope) VALUES
 ('company.people.read','Consultar personas de la empresa','company','company'),
 ('company.people.manage','Gestionar declaraciones y condiciones de personas','company','company'),
 ('company.licenses.manage','Gestionar licencias de conductores','company','company')
 ON CONFLICT(code) DO NOTHING;
INSERT INTO roles(code,name,description) VALUES
 ('administrative','Administrativo','Registro de personas y vigencias de su empresa; sin gobierno de plataforma')
 ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('company.people.read','company.people.manage','company.licenses.manage')
 WHERE r.code IN ('company_admin','manager') OR
 (r.code='operations' AND p.code='company.licenses.manage') OR
 (r.code='administrative' AND p.code IN ('company.people.read','company.people.manage'))
 ON CONFLICT DO NOTHING;
COMMIT;
