-- FleetChile Pro - administration settings
CREATE TABLE IF NOT EXISTS system_settings (
  id BIGSERIAL PRIMARY KEY,
  setting_key TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO system_settings(setting_key,category,label,value,description) VALUES
 ('company.default_region','organization','Región predeterminada','"Biobío"','Región utilizada como valor inicial en formularios'),
 ('operation.currency','operation','Moneda','"CLP"','Moneda principal de la operación'),
 ('operation.distance_unit','operation','Unidad de distancia','"km"','Unidad utilizada para kilometraje y rutas'),
 ('operation.weight_unit','operation','Unidad de peso','"kg"','Unidad utilizada para cargas'),
 ('operation.trip_prefix','operation','Prefijo de viajes','"V"','Prefijo para numeración automática de viajes'),
 ('gps.refresh_seconds','gps','Actualización GPS (segundos)','30','Frecuencia de actualización de la vista operacional'),
 ('documents.expiry_days','documents','Aviso de vencimientos (días)','30','Días de anticipación para documentos por vencer'),
 ('notifications.email_enabled','notifications','Notificaciones por correo','true','Habilita el envío de avisos por correo cuando se implemente el proveedor'),
 ('notifications.maintenance_alerts','notifications','Alertas de mantención','true','Genera avisos por mantenciones próximas'),
 ('appearance.company_name','appearance','Nombre mostrado','"FleetChile"','Nombre visible en la aplicación')
ON CONFLICT (setting_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings(category);
