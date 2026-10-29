# Correcciones de hallazgos — auditoría autenticada de Render

## Alcance y límites

Se atienden únicamente los ocho hallazgos confirmados de la auditoría del
28–29 de octubre de 2026, sobre la revisión de referencia `76ea654`.
No se implementan las revisiones pendientes ni se cambian roles, permisos,
`resolveActorContext()`, licencias, fórmulas económicas o proveedores geográficos.
No hay migraciones nuevas ni correcciones SQL manuales de datos de producción.
El informe original de auditoría se conserva sin modificaciones.

## Funciones afectadas

| Hallazgo | Corrección | Efecto para el usuario |
|---|---|---|
| Inicio sin checklist/aceptación | Validación transaccional común de predespacho en las tres rutas de cambio de estado y en la salida del itinerario móvil | Antes de iniciar o reanudar, el conductor debe aceptar la asignación vigente y existir una inspección completa, aprobada y atribuida para ese camión/conductor. Un registro histórico vacío no habilita la salida. |
| Entregas del conductor, HTTP 500 | Corregido el cierre de paréntesis de la agregación SQL de entregas | Las cargas y sus POD se pueden consultar también cuando todavía no hay entregas. Se conservan metadatos públicos, sin devolver claves de almacenamiento privado. |
| Alta de carga, error genérico | Se preserva y explica la restricción comercial existente | La reproducción SQL comprobó que el camión sin cupo debe rechazarse. Ahora responde 409 con la causa comercial; no se conceden cupos ni se desactiva la licencia para hacer pasar el alta. |
| Alta de combustible, HTTP 400 | Parámetros de multiplicación tipados como `numeric` en PostgreSQL | Se puede guardar la carga y calcular su total en el servidor. El importe enviado por el navegador no sustituye el cálculo. |
| Panel superpuesto a formularios | Orden de capas: mapa/panel → formulario → selector de ubicación → autenticación | Destino, Guardar y Cerrar quedan accesibles por clic normal, también a 390 px. No requiere cerrar el panel del viaje como solución alternativa. |
| Camión escrito manualmente en carga | Selector de vehículos de la empresa activa, con asignación diferida | Se elige una patente propia o se deja para el viaje. El servidor sigue comprobando pertenencia y habilitación. El catálogo usa `loads.manage`, sin conceder permisos adicionales de flota. |
| Motivo laboral ausente | Motivo obligatorio conservado en el evento `condition_create` | El historial de nuevas condiciones muestra autor, fecha y motivo. Los registros antiguos no se completan con datos inventados. |
| Inicio de plataforma en pantalla no autorizada | Pantalla inicial compatible y descarte del error de una vista anterior | La cuenta de plataforma sin permiso económico abre su administración. Los enlaces directos al viaje y el inicio empresarial se mantienen. No se añade `economics.read`. |

## Predespacho

- La aceptación corresponde al conductor y a la versión actual de recursos.
- Se evalúa el último checklist de ese viaje, camión y conductor; debe contener
  los seis controles, estar aprobado, cerrado y tener autor de cierre.
- La inspección debe ser posterior a la asignación/reemplazo registrado.
- La validación sucede dentro de la transacción que bloquea el viaje. Un rechazo
  no deja cambios parciales de estado, eventos ni fecha de salida.
- Asignar recursos y comenzar la carga no exige adelantar la inspección.
  Detener, cancelar y registrar una emergencia conservan sus caminos existentes.
- Estos controles no sustituyen documentos, disponibilidad, licencia del
  conductor ni habilitación comercial: sus comprobaciones se mantienen.

## Pruebas

Nuevas pruebas específicas:

- `tests/audit-findings-postgres.integration.test.js`: consultas SQL reales en
  PGlite aislado, combustible, entregas sin/con evidencia, causa comercial,
  carga con ubicaciones y sin camión, motivo laboral y bloqueo de las tres rutas
  de inicio hasta aceptación/checklist. Comprueba rollback y detención permitida.
- `tests/trip-predeparture.test.js`: rechazo de inspección ausente, incompleta,
  pendiente, rechazada, sin autor o anterior al cambio de recursos.
- `tests/audit-findings-ui.test.js`: inicio según identidad, enlace al viaje,
  error económico tardío que no reemplaza la pantalla global, selector de flota
  y funcionamiento de formularios con panel abierto en Chrome de escritorio y
  viewport móvil.
- `tests/client-selection.test.js`: alcance empresarial y permiso del catálogo
  de vehículos; no se acepta una patente inventada desde el formulario.

Las pruebas existentes de recursos y disponibilidad reciben ahora aceptación e
inspección como precondiciones sintéticas. Se conservan sus verificaciones de
reemplazos, reservas, aislamiento, GPS, POD, mantenciones y rollback. La aceptación
integrada continúa recorriendo tres entregas y cierre económico con APIs reales
sobre una base aislada.

Las pruebas locales no certifican el nuevo comportamiento en Render. Después de
la revisión humana y de una publicación autorizada, repetir F-01 a F-08 y luego
la auditoría pendiente. No se inició FleetChile localmente ni se usaron conexiones
a producción para probar estas correcciones.

## Pendientes deliberadamente intactos

No se resuelve el punto de visibilidad del detalle del viaje propio para el
conductor, ni se declara certificada toda la matriz de permisos. Tampoco se
adelantan GPS permanente, PL41, concurrencia nativa o validación Android real.

## Resultado local final

- Suite completa: **1409 pruebas aprobadas, 0 fallidas, 0 omitidas**
  (298,7 segundos), con PGlite, Chrome/Playwright y Leaflet habilitados.
- `npm run check:syntax`: aprobado.
- `npm run check:delivery`: aprobado.
- `git diff --check`: sin errores de espacios; los avisos LF/CRLF no son fallos.
- Validación SQL en PGlite aislado, no en PostgreSQL nativo con conexiones
  independientes ni en Render. La ejecución no certifica concurrencia de producción.
- Correcciones locales listas para revisión humana. Sin commit, push ni despliegue;
  la validación de los ocho hallazgos en producción queda pendiente de publicación.
