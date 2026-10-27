# PL14–PL15: conjuntos y asignaciones versionadas

## Flujo operativo

1. Registrar cada vehículo en Camiones, incluyendo su tipo y documentación.
2. Abrir **Conjuntos y equipos** desde ese módulo. Crear una composición con un vehículo principal y, opcionalmente, un remolque o semirremolque registrado en la misma empresa.
3. Indicar nombre, período de vigencia y estado del conjunto. Su creación no reserva activos ni establece un conductor permanente.
4. En el detalle de un viaje, usar la asignación para elegir un conjunto o vehículos individuales, conductor, cliente y ruta.
5. Al reemplazar una asignación versionada, indicar el motivo. Una pantalla obsoleta se rechaza: debe recargarse antes de guardar.
6. Consultar el historial desde el detalle del viaje o desde el catálogo de conjuntos.

## Integridad e historial

- El viaje conserva una copia de la composición seleccionada; editar o desactivar el catálogo no cambia viajes previamente asignados. Para adoptar una nueva versión se requiere una asignación explícita.
- Cada revisión conserva actor, motivo, fecha y recursos anteriores. Las revisiones no pueden actualizarse o eliminarse mediante operaciones ordinarias de base de datos.
- En viajes anteriores al módulo, la primera revisión es un estado observado, con fecha inicial desconocida. No representa una fecha de asignación histórica reconstruida.
- Las reservas se separan por intervalos de asignación, recortados a la planificación del viaje. El relevo libera los recursos anteriores para períodos posteriores. Una ejecución actual sigue bloqueando el uso concurrente aunque haya pasado su llegada estimada.
- El cambio es efectivo al guardarse; no es un programador de relevos futuros.
- Los reemplazos no trasladan ni reescriben cargas, pruebas de entrega, autores de evidencias o posiciones GPS anteriores. La posición de un vehículo retirado no presenta el viaje como actualmente asociado a ese vehículo.
- El conductor anterior deja de acceder operativamente al viaje desde la PWA; la ficha administrativa y su PDF conservan sus asignaciones históricas.

## Controles y seguridad

- Aislamiento por empresa y permisos existentes: catálogo editable con `fleet.manage`; selección/asignación con `trips.manage`. No se agregan roles ni se modifican políticas de autorización.
- El servidor valida pertenencia, tipos, vigencia, versión y disponibilidad. No confía en campos deshabilitados del formulario.
- Documentación y bloqueos operacionales se verifican tanto para el vehículo principal como para el acoplado. El taller también reconoce acoplados participantes de viajes en ejecución.
- Los controles laborales y de vigencia de licencia del conductor se mantienen.
- Cabecera, historial, evento y auditoría se guardan en una transacción; fallar la auditoría revierte la asignación.
- Los cambios por endpoints antiguos de asignación se rechazan cuando el viaje ya tiene recursos versionados.

## Alcance y límites

- Una composición admite un vehículo principal y hasta un acoplado. No certifica compatibilidad mecánica de enganches ni autorización legal específica para cada combinación de licencia y equipo.
- La capacidad es informativa: se toma del acoplado cuando existe, sin sumarla a la cabina; un tractocamión solo no recibe capacidad de carga inventada.
- Cargas por tramo, itinerarios con múltiples entregas, optimización y tiempos calculados corresponden al bloque siguiente, no a esta implementación.
- El catálogo se filtra y pagina en la interfaz; los historiales se paginan en el servidor. No se incorpora un motor de búsqueda externo.

## Esquema y validación

La migración aditiva `034_fleet_compositions_assignments.sql` se incorpora al mecanismo existente de inicio. No ejecutar SQL manual en producción. Se prueba su aplicación e idempotencia en PostgreSQL aislado mediante PGlite.

Las pruebas incluyen dominio, interfaz aislada, SQL real, aislamiento, vencimientos, mantenciones, conflictos temporales, relevos, control de versiones, historial, PDF y rollback de auditoría. No equivalen a validación visual en navegador, concurrencia multiconexión o aceptación en Render. No se ha iniciado la aplicación ni desplegado el módulo para realizar estas pruebas.
