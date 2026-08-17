-- FleetChile Pro - authentication and RBAC
CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_company_role ON users(company_id, role_id);

-- Fill the permission matrix for built-in roles.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','operations','maintenance','driver','viewer')
AND (
  (r.code='manager' AND p.code IN ('dashboard.read','fleet.manage','drivers.manage','clients.manage','trips.manage','loads.manage','gps.read','maintenance.manage','fuel.manage','documents.manage','reports.read')) OR
  (r.code='operations' AND p.code IN ('dashboard.read','fleet.manage','drivers.manage','clients.manage','trips.manage','loads.manage','gps.read','reports.read')) OR
  (r.code='maintenance' AND p.code IN ('dashboard.read','fleet.manage','maintenance.manage','documents.manage','gps.read')) OR
  (r.code='driver' AND p.code IN ('dashboard.read','gps.read','trips.manage','loads.manage')) OR
  (r.code='viewer' AND p.code IN ('dashboard.read','gps.read','reports.read'))
)
ON CONFLICT DO NOTHING;

-- The first user is created interactively through /api/auth/setup.
-- No password is stored in this migration.