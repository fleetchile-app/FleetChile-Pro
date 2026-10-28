# Checklist preoperacional — corrección de aprobación vacía

## Defecto comprobado

El formulario administrativo permitía enviar Aprobado con items vacíos. El cierre antiguo del conductor también admitía listas incompletas. La app móvil ocultaba el formulario al encontrar cualquier checklist cerrado, incluso un Aprobado sin respuestas. La reproducción local mostró cero controles visibles para ese registro, frente a seis cuando no existía o estaba pendiente.

El viaje comunicado es V-2026-4B4724. Se utilizó ese número en una reproducción sintética aislada; NO se ha leído ni modificado su registro de producción, ni identificado todavía a su autor real.

## Comportamiento corregido

- Un validador compartido exige seis controles únicos y conocidos: frenos/dirección, neumáticos, luces, visibilidad, seguridad y documentación. Los resultados permitidos son Conforme/Con falla. Un cierre Aprobado no puede incluir fallas; Rechazado exige observaciones.
- Administración presenta las mismas preguntas, sin selector para aprobar vacío. Guarda el usuario que efectivamente registra la inspección; no la atribuye al conductor por estar asignado al viaje.
- El camino antiguo permite iniciar un pendiente, pero no cerrarlo sin respuestas válidas. El fallback móvil de JSON y botones de aprobación directa se retiró.
- Tanto administración como teléfono muestran respuestas, fecha disponible y autores registrados. Los históricos sin autor se identifican como no registrados, sin inferencias ni backfill.
- Un Aprobado histórico incompleto no se presenta como inspección completa. En un viaje abierto el conductor puede registrar una inspección NUEVA, con motivo explícito y vínculo al anterior. El original conserva todos sus datos.
- No se regulariza por este camino un Rechazado, aunque esté incompleto. Sus alertas y el proceso de reparación no se eluden. Un viaje cerrado no admite una inspección retroactiva desde el móvil.
- Reintentos con la misma clave conservan un único resultado. Si falla auditoría, se revierten inspección y recibo. No se introdujo un requisito universal nuevo de checklist para todos los tipos de operación ni se modificaron permisos o resolveActorContext.

## Esquema y PWA

Migración aditiva 042_checklist_completion.sql: autor de creación/cierre y nombres registrados, más vínculo supersedes_id para la inspección nueva. No cambia estados, respuestas ni fechas históricas. Solo se aplica por el mecanismo versionado habitual durante un despliegue autorizado; no ejecutar SQL manual de producción.

La PWA usa shell v4 e incluye el validador y estilos. Después del despliegue, sincronizar pendientes y aceptar la actualización ofrecida por la app; cerrar/abrir puede ser necesario. No borrar los datos del sitio, desinstalar o forzar una actualización si hay entregas/checklist pendientes de sincronizar.

## Verificación del viaje real

Después de publicar el código y aplicar la migración mediante el arranque normal, consultar en administración: Viajes → V-2026-4B4724 → Checklist → Ver respuestas y responsable. El autor de registros antiguos puede no existir en la ficha; buscar la auditoría sin reescribir el registro.

Para un operador autorizado con acceso a Render Shell, este diagnóstico es de SOLO LECTURA:

```sh
node scripts/inspect-trip-checklists.js V-2026-4B4724
```

No inicia la aplicación, no migra ni escribe. Consulta únicamente ese viaje, sus checklists y auditorías asociadas. La consulta muestra nombres de actores cuando la auditoría los conserva; revisar el resultado de forma privada y no publicar datos personales o claves. No ejecutar npm start como diagnóstico. El script no está disponible en Render hasta publicar esta entrega.

En el teléfono: abrir el mismo viaje, revisar el histórico y completar una inspección nueva si aparece la opción. Verificar la fecha real de la nueva inspección, el vínculo al anterior, los seis resultados y el autor. Si hay una falla, debe quedar Rechazado y mantenerse su alerta operacional.

## Límites de la comprobación

Pruebas locales de dominio, rutas antiguas, SQL aislado y Chrome no sustituyen la comprobación real del viaje y de Android. No se hizo commit, push, despliegue ni consulta a la base de producción durante esta corrección.

Verificación local de la entrega: 1.352 pruebas aprobadas, 0 fallos, 0 omitidas, con PGlite y Chrome habilitados. Incluye formulario móvil/administrativo, cierres vacíos e inconsistentes, autoría, regularización sin modificar el histórico, rechazo no eludible, reintento idempotente y rollback de auditoría. check:syntax, check:delivery y git diff --check correctos.
