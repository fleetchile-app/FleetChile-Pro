BEGIN;
-- Global control records deliberately have no FK to the deleted company.
CREATE TABLE IF NOT EXISTS platform_company_purge_challenges (
 id UUID PRIMARY KEY, target_company_id BIGINT NOT NULL, actor_id BIGINT NOT NULL REFERENCES users(id),
 session_hash TEXT NOT NULL, phrase_hash TEXT NOT NULL, company_stamp TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purge_challenge_actor ON platform_company_purge_challenges(actor_id,created_at);
CREATE TABLE IF NOT EXISTS platform_company_purge_jobs (
 id UUID PRIMARY KEY, target_company_id BIGINT NOT NULL UNIQUE, company_name TEXT NOT NULL,
 actor_id BIGINT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, counts JSONB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('files_pending','complete')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform_company_purge_files (
 job_id UUID NOT NULL REFERENCES platform_company_purge_jobs(id), storage_key TEXT NOT NULL,
 deleted_at TIMESTAMPTZ, PRIMARY KEY(job_id,storage_key)
);
COMMIT;
