# Documentos y recorridos integrados en Viajes

Base: `c584741`. Cambio autorizado de navegación y planificación.

## Qué cambia para el usuario

- **Documentos SII** pasa a llamarse **Documentos y vencimientos**, tanto en el menú
  como en el título. Conserva sus registros, filtros, edición y validaciones.
  El nombre largo se muestra en dos líneas legibles en la barra lateral.
- **Rutas** deja de aparecer en el menú principal. No es necesario crear una ruta
  separada para planificar un viaje.
- En **Viajes → Abrir → Resumen**, la tarjeta **Recorrido** abre el planificador,
  en lugar de llevar al formulario de asignación de recursos.
- En **Itinerario, cargas y tiempos → Planificar/Modificar**, un bloque desplegable
  opcional ofrece **Recorridos guardados**: búsqueda paginada, reutilización de
  origen/destino y guardado de un par frecuente de ubicaciones.
- Guardar el par en el catálogo no asigna vehículos/conductor, no copia avance o
  estado, no modifica el viaje y no calcula distancias supuestas.
- Elegir un recorrido incorpora sólo sus extremos al borrador. Las paradas
  intermedias, cargas y horarios se conservan; la revisión de restricciones debe
  repetirse. Si sustituye puntos ya elegidos, se pide confirmación.
- El viaje cambia solamente al pulsar **Calcular ruta y guardar versión**. Se usa
  el proveedor existente y el proceso transaccional/versionado del itinerario.
  Su cabecera se alinea entonces con el origen y destino confirmados del plan.
- Un itinerario ya iniciado no admite reemplazar ambos extremos desde un recorrido
  guardado; debe seguir el procedimiento existente de edición de paradas pendientes.

## Datos existentes y alcance

No se borra `routes`, no se eliminan rutas anteriores ni se retiran APIs heredadas.
Las referencias `trips.route_id` y las revisiones históricas se conservan. El
formulario de recursos ya no obliga a volver a elegir recorrido ni envía una
referencia vacía que borre la anterior.

Las rutas antiguas con accesos confirmados pueden reutilizarse desde el catálogo.
Las que sólo tienen texto se muestran como históricas y no reutilizables hasta
confirmar sus ubicaciones manualmente en el planificador. No se geocodifican ni
atribuyen coordenadas automáticamente.

El catálogo guarda pares de puntos, **no plantillas completas de itinerarios
multientrega**. No copia cargas, paradas intermedias ni horarios de otro servicio.
Seleccionar un par no establece automáticamente una nueva relación `route_id`:
los puntos quedan registrados en la revisión del itinerario al guardar el plan.

## Seguridad y funcionamiento técnico

- Se reutilizan `trips.manage` y el guard de empresa/viaje del itinerario. No se
  cambia `resolveActorContext()`, RBAC, ROOT/OWNER ni la política comercial.
- Lectura paginada y creación en
  `/api/operations/trips/:id/itinerary/saved-routes`.
- Sólo se aceptan IDs de ubicaciones propias con coordenadas; el servidor toma
  sus nombres desde la base. No acepta empresa, recursos ni ejecución en el body.
- Un reintento sobre el mismo par reutiliza el registro existente. La creación
  serializa solicitudes de este camino por empresa y registra auditoría; si falla,
  revierte el alta. No se certifica concurrencia nativa con esta prueba aislada.
- Las consultas asíncronas del catálogo descartan respuestas de un contexto o
  formulario anterior. Se escapan los textos mostrados.
- No hay cambios de esquema ni migraciones nuevas. No se modifica la emisión SII,
  el cálculo vial, la regla de capacidad, los documentos de circulación o el POD.

## Verificación

- SQL aislado: alta sin recursos/activación, reintento, históricos, búsqueda y
  paginación, empresa ajena, permiso insuficiente y rollback de auditoría.
- Navegador Chrome real: menú sin Rutas, nombre documental legible, selección
  opcional, histórico no seleccionable, texto escapado, copia de extremos sin
  escritura inmediata y guardado separado de catálogo e itinerario; escritorio y
  viewport móvil de 390 px. No equivale a Android físico.
- Regresión de recursos: no existe selector de recorrido y la referencia histórica
  se preserva incluso si el formulario envía otro ID manipulado.
- SQL del itinerario: nombres e IDs de origen/destino de cabecera corresponden a
  los puntos confirmados de la versión guardada.

Resultado local: **1429 pruebas aprobadas, 0 fallidas y 0 omitidas**, con PGlite,
Chrome/Playwright y Leaflet habilitados (356,4 segundos). La suite incluye los
circuitos previos de itinerarios, recursos, POD, economía, personal y licencias.
La revisión dirigida del nuevo flujo pasó también en escritorio y ancho móvil.
`check:syntax`, `check:delivery` y `git diff --check` correctos.
Registro local: `%TEMP%/fleetchile-navegacion-recorridos-final-20261029.log`.

Sin commit, push, despliegue, migración ni conexión a producción. La validación de
Render queda pendiente de una publicación autorizada.
