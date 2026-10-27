BEGIN;
CREATE TABLE IF NOT EXISTS company_export_jobs(
 id UUID PRIMARY KEY,company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 1000),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed','expired')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,expires_at TIMESTAMPTZ,
 snapshot_at TIMESTAMPTZ,error_code TEXT,storage_key TEXT,size BIGINT,sha256 TEXT,manifest JSONB,
 request_key UUID NOT NULL,UNIQUE(company_id,requested_by,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_export_active ON company_export_jobs(company_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS company_export_queue ON company_export_jobs(status,created_at);
CREATE TABLE IF NOT EXISTS service_incidents(
 id BIGSERIAL PRIMARY KEY,source TEXT NOT NULL,code TEXT NOT NULL,severity TEXT NOT NULL CHECK(severity IN ('warning','error')),
 occurrences BIGINT NOT NULL DEFAULT 1,first_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 resolved_at TIMESTAMPTZ,acknowledged_at TIMESTAMPTZ,acknowledged_by BIGINT REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS service_incident_open ON service_incidents(source,code) WHERE resolved_at IS NULL;
COMMIT;
