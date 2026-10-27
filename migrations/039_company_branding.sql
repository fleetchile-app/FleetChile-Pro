BEGIN;

-- Append-only identity revisions: contractual data and entitlements stay separate.
CREATE TABLE IF NOT EXISTS company_branding_revisions (
 company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0),
 display_name TEXT NOT NULL CHECK(length(display_name)<=120),
 palette TEXT NOT NULL CHECK(palette IN ('ocean','forest','slate')),
 contact_name TEXT NOT NULL DEFAULT '' CHECK(length(contact_name)<=120),
 contact_email TEXT NOT NULL DEFAULT '' CHECK(length(contact_email)<=254),
 contact_phone TEXT NOT NULL DEFAULT '' CHECK(length(contact_phone)<=40),
 logo BYTEA CHECK(octet_length(logo)<=300000),
 logo_width INTEGER,
 logo_height INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 500),
 PRIMARY KEY(company_id,version),
 CHECK((logo IS NULL AND logo_width IS NULL AND logo_height IS NULL) OR
       (logo IS NOT NULL AND logo_width BETWEEN 1 AND 600 AND logo_height BETWEEN 1 AND 240))
);
CREATE OR REPLACE FUNCTION company_branding_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'El historial de identidad y documentos es inmutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS company_branding_revision_immutable ON company_branding_revisions;
CREATE TRIGGER company_branding_revision_immutable BEFORE UPDATE OR DELETE ON company_branding_revisions
 FOR EACH ROW EXECUTE FUNCTION company_branding_immutable();

CREATE TABLE IF NOT EXISTS company_issued_documents (
 id UUID PRIMARY KEY,
 company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
 template_version TEXT NOT NULL,
 branding_version INTEGER NOT NULL CHECK(branding_version>=0),
 identity_snapshot JSONB NOT NULL,
 emitted_at TIMESTAMPTZ NOT NULL,
 emitted_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 pdf BYTEA NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 FOREIGN KEY(company_id,driver_id) REFERENCES drivers(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS company_issued_documents_driver ON company_issued_documents(company_id,driver_id,emitted_at DESC);
DROP TRIGGER IF EXISTS company_issued_document_immutable ON company_issued_documents;
CREATE TRIGGER company_issued_document_immutable BEFORE UPDATE OR DELETE ON company_issued_documents
 FOR EACH ROW EXECUTE FUNCTION company_branding_immutable();
COMMIT;
