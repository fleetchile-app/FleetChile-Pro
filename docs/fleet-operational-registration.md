# Registro operacional de flota

## Vehículos

- Registrar patente, marca, modelo y tipo. La capacidad, VIN y número de motor son opcionales.
- No se asigna conductor ni ubicación durante el registro: la relación conductor–vehículo se establece en el viaje.
- Permiso de circulación, SOAP y revisión técnica pueden completarse después del alta. Sin las tres fechas vigentes no se permite asignar el vehículo ni iniciar/reanudar el servicio.
- Los vencimientos se evalúan con la fecha local de la empresa; el día de vencimiento está incluido.
- Las alertas operacionales se revisan al iniciar el monitor y cada minuto: documentación pendiente, vencida o bandas de 30, 15 y 7 días. Se resuelven al regularizar el documento, no manualmente.

## Conductores

- Crear/regularizar primero la persona y su acceso empresarial con rol conductor, contrato vigente y licencia vigente.
- En Conductores, incorporar seleccionando ese usuario. Los ya incorporados no vuelven a aparecer como candidatos.
- El alta operacional utiliza la identidad existente, sin crear otro usuario ni otro conductor técnico.
- El historial permite consultar viajes, registrar multas, notas y suspensiones, y descargar una ficha PDF privada. Una suspensión se registra también como condición laboral para que tenga efecto real sobre el acceso.
- Renovaciones y correcciones de identidad se realizan en Personas y accesos, no en una segunda copia de la licencia.

## Soporte de plataforma

La edición empresarial exige una empresa seleccionada y autorización de soporte. El contexto y los cambios quedan auditados. Los roles globales, ROOT/OWNER y las identidades compartidas con otras empresas no se modifican desde este flujo.

## Compatibilidad y puesta en servicio

La migración versionada `032_fleet_operational_registration.sql` conserva los vehículos y conductores existentes. No inventa marca, modelo, contratos ni vencimientos. Las identidades técnicas nuevas requieren incorporación operacional explícita; las anteriores conservan su historial, pero deben cumplir los requisitos antes de una nueva asignación.

Los viajes pueden planificarse sin recursos. La validación documental se aplica al asignar recursos y al activar/reanudar el viaje. No impide registrar GPS, detener o cerrar un viaje que ya estaba en curso: esas acciones siguen siendo necesarias para la seguridad y trazabilidad. El sistema no puede impedir físicamente que un vehículo circule.

Antes de desplegar, revisar el diff y las pruebas. Tras un despliegue autorizado, comprobar con dos empresas: alta sin documentos, rechazo de asignación, renovación, incorporación de conductor, rechazo por licencia vencida, historial/PDF y edición empresarial desde plataforma. Las pruebas locales no sustituyen esa validación real.
