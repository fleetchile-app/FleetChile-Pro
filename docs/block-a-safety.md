# Punto A — Seguridad y coherencia operacional

Implementación integrada sobre viajes, flota, checklist y autenticación. No cambia
`resolveActorContext()`, el catálogo de permisos ni ROOT/OWNER. No requiere una
migración nueva. Los registros existentes no se reescriben.

## Reglas aplicadas

- Crear un viaje con recursos, asignarlos/reasignarlos o autorizar circulación
  usa el mismo control de empresa, conductor, documentos y disponibilidad.
- El vehículo no puede estar en Mantención, Fuera de servicio, Inactivo o
  Suspendido, tener una mantención En proceso ni una alerta de checklist
  rechazado sin resolver. Una mantención solamente Pendiente no lo bloquea.
- Las fichas de vehículos reflejan también esos bloqueos operacionales.
- Un checklist rechazado por administración genera la misma alerta crítica
  que el rechazado por el conductor. La eliminación legacy de esa alerta no
  permite eludir la resolución con responsable, motivo y auditoría.
- Las reservas se comparan por empresa y por camión o conductor, excluyendo
  el propio viaje y viajes Completados/Cancelados. Dos intervalos que sólo
  comparten el instante de llegada/salida no se consideran superpuestos.
- Una fecha omitida representa un extremo desconocido, no disponibilidad
  garantizada. Deben registrarse fechas suficientes o liberarse la reserva.
  Al ejecutar, otro viaje ya en ejecución bloquea aunque su ETA haya pasado.
- Se bloquean los recursos antes de consultar las reservas y se mantiene el
  bloqueo hasta confirmar o revertir la transacción. No se bloquean los viajes
  competidores para consultar sus reservas.
- Detener, completar y cancelar no requieren una nueva autorización vial.
  Esto no modifica las restricciones de acceso laboral ya existentes.
- Cambiar la contraseña propia requiere comprobar la clave actual bajo bloqueo;
  revoca las otras sesiones y conserva la que reautenticó. Restablecer una clave
  por administración o desactivar una cuenta global revoca todas sus sesiones.
  La revocación y la modificación se revierten juntas si falla la auditoría.
- POST `/api/fuel` y `/api/maintenance` quedan retirados con HTTP 410: permitían
  escrituras sin la validación/auditoría actuales. La interfaz existente utiliza
  `/api/fleet/fuel` y `/api/fleet/maintenance`; no se eliminan datos históricos.

## Estado de PL01–PL06

| Punto | Evidencia local y límite de cierre |
| --- | --- |
| PL01 — Permisos/empresa | Regresión de las matrices API/UI existentes; sin ampliar privilegios. Falta aceptación con cuentas reales. |
| PL02 — Caminos antiguos | Guard compartido en core/operaciones/conductor; retiros y protección de alertas probados. No equivale a certificar todos los endpoints del producto. |
| PL03 — Aptitud operacional | Documentos, personal, mantenciones y alertas de rechazo integrados. No impone todavía un checklist obligatorio donde antes no se exigía. |
| PL04 — Reservas/concurrencia | Comparación SQL y serialización por recursos; pendiente prueba multiconexión en PostgreSQL aislado, incluyendo posibles interbloqueos con personal/checklist. |
| PL05 — Auditoría/integridad | Pruebas de rollback y aislamiento; conserva versionado de fichas existente. Falta completar aceptación de edición concurrente desde dos navegadores. |
| PL06 — Sesiones/cuentas | Revocación y reautenticación con pruebas de éxito, rechazo y rollback; pendiente comprobar sesiones reales en dos dispositivos. |

## Verificación y aceptación

`npm test` ejecuta las pruebas automáticas. Con `FLEETCHILE_TEST_PGLITE` apuntando
al paquete externo, las integraciones crean bases PostgreSQL/WASM nuevas en
memoria, sin usar `DATABASE_URL`. No sustituyen concurrencia multiconexión ni
validación en Render. No iniciar `npm start` como prueba de sólo lectura.

Antes de cerrar A: validar en un entorno autorizado con dos operadores el mismo
recurso y períodos coincidentes/no coincidentes; rechazo y resolución de checklist;
mantención en proceso; bloqueo de reanudación y registro de detención; aislamiento
entre empresas; y cambio de contraseña con dos sesiones. Publicar y ejecutar
pruebas contra producción requiere autorización separada.
