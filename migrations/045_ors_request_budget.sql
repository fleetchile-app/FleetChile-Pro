-- Provider-wide budget; no addresses, coordinates or API keys are stored here.
BEGIN;
CREATE TABLE IF NOT EXISTS ors_request_budgets (
 credential_hash TEXT NOT NULL,
 service TEXT NOT NULL CHECK(service IN ('directions','geocoding')),
 window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 requests_used INTEGER NOT NULL DEFAULT 0 CHECK(requests_used>=0),
 minute_events TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(credential_hash,service)
);
COMMIT;
