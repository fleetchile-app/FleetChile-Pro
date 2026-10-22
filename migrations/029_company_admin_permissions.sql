BEGIN;

-- Matriz cerrada del administrador de empresa. No hereda el bypass legacy admin
-- ni incorpora automáticamente permisos que se creen en el futuro.
-- Beneficia a memberships actuales y futuras del rol, sin modificar identidades.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.scope='company' AND p.code IN (
  'company.users.manage','audit.read','dashboard.read','fleet.manage',
  'drivers.manage','clients.manage','trips.manage','loads.manage','gps.read',
  'maintenance.manage','fuel.manage','documents.manage','reports.read',
  'economics.read','economics.manage','economics.approve','economics.close','economics.export'
)
WHERE r.code='company_admin'
ON CONFLICT DO NOTHING;

COMMIT;
