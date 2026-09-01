-- FleetChile Pro - Fase 5.6 / POD y evidencias
-- Additive only. Legacy delivery columns remain available for compatibility.

ALTER TABLE trip_delivery_proofs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'CLOSED',
  ADD COLUMN IF NOT EXISTS client_submission_id TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trip_delivery_proofs_status_valid') THEN
    ALTER TABLE trip_delivery_proofs
      ADD CONSTRAINT trip_delivery_proofs_status_valid
      CHECK (status IN ('DRAFT','CLOSED','VOID')) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_delivery_proofs_submission
  ON trip_delivery_proofs(trip_id,client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_delivery_proofs_closed_load
  ON trip_delivery_proofs(load_id)
  WHERE load_id IS NOT NULL AND status='CLOSED';

CREATE INDEX IF NOT EXISTS idx_delivery_proofs_trip_status
  ON trip_delivery_proofs(trip_id,status,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS delivery_proof_files (
  id BIGSERIAL PRIMARY KEY,
  proof_id BIGINT NOT NULL REFERENCES trip_delivery_proofs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_proof_files_type_valid CHECK (type IN ('signature','photo')),
  CONSTRAINT delivery_proof_files_sha256_valid CHECK (sha256 ~ '^[0-9a-fA-F]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_delivery_proof_files_proof
  ON delivery_proof_files(proof_id,created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_proof_files_storage_key
  ON delivery_proof_files(storage_key);
