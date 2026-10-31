'use strict';
// Only authentication capabilities and GPS deduplication receipts are ephemeral.
// telemetry, audit_logs and driver_mobile_actions are intentionally NOT excluded.
const EPHEMERAL = Object.freeze({
  user_sessions: 'Revocar todas las sesiones de autenticación al restaurar; no reactivar tokens.',
  driver_tracking_sessions: 'Capacidades GPS ligadas por FK a user_sessions; requieren nueva autenticación.',
  driver_tracking_positions: 'Recibos de deduplicación ligados a sesiones GPS; las posiciones reales permanecen en telemetry.'
});
const excluded = t => Object.hasOwn(EPHEMERAL, t.name);
const exclusions = tables => tables.filter(excluded).map(t => ({ schema: t.schema, table: t.name, reason: EPHEMERAL[t.name] }));
module.exports = { EPHEMERAL, excluded, exclusions };
