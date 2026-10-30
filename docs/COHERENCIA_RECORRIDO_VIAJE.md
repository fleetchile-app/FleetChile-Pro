# Coherencia entre viaje, cargas, mapa e itinerario — opción B

Base de trabajo: `7b99c4d`. Implementación local autorizada; no supone despliegue.

## Secuencia de uso

1. Crear el viaje y confirmar sus accesos en mapa. Puede guardarse para planificar,
   pero sin cálculo válido se muestra **Distancia pendiente de cálculo**, no cero.
2. Registrar las cargas con sus propios puntos de recogida y entrega.
3. Abrir Resumen → Itinerario → Planificar. Se precargan los puntos del viaje y,
   cuando tienen referencias persistidas, se incorporan los puntos adicionales de
   las cargas. Es una propuesta de orden, no una optimización automática de paradas.
4. Revisar secuencia, nombres, comuna/región declaradas y puntos del mapa. Las
   cargas se vinculan por identificador de ubicación, no por parecido de nombres.
5. Si se cambia un extremo del viaje, confirmar expresamente el cambio. Si una
   carga carece de puntos o no coincide con las paradas escogidas, se muestran las
   diferencias y se exige otra confirmación para actualizar su ficha de este viaje.
   El motivo, autor, valores anteriores y nuevos quedan en auditoría.
6. Calcular y guardar: una misma transacción confirma versión, cabecera, fichas de
   cargas, distancia/duración del proveedor y nuevo snapshot del trazado completo.
7. Iniciar/reanudar sólo con los controles previos vigentes. En viajes
   georreferenciados se exige itinerario confirmado; no se elude desde estados
   alternativos o registrando directamente una entrega.

## Una referencia operativa, sin borrar el historial

- El itinerario versionado gobierna el recorrido operativo. Cada versión conserva
  su plan; el snapshot vial vigente corresponde a sus tramos, incluidos los puntos
  intermedios, no a una ruta de dos extremos calculada anteriormente.
- `route_id` histórico se conserva, pero no se usa como sustituto visual del
  recorrido actual en la app del conductor.
- Recorridos guardados es un **catálogo opcional de la empresa**, no una sugerencia
  aplicada automáticamente al viaje abierto. Reutilizarlo no guarda ni activa nada.
- La ficha comercial del cliente no determina el destino. Se admite recoger y
  entregar en instalaciones de terceros sin exigir coincidencia con su domicilio.
- Confirmar ubicaciones actualiza `trip_loads`, la ficha de la carga transportada
  en ese viaje; no modifica silenciosamente el catálogo independiente de cargas,
  el cliente ni el maestro de ubicaciones.
- Una revisión antigua no pisa cambios de otro operador: el formulario envía una
  huella de las ubicaciones consultadas y el servidor la contrasta bajo el bloqueo
  del viaje, antes de actualizar las cargas.
- Coordenadas de paradas futuras modificadas en el maestro, destinos cambiados o
  referencias contradictorias producen advertencia visible y bloqueo operacional
  hasta revisar. No se corrigen automáticamente los datos existentes.
- Las paradas iniciadas conservan punto, tiempos y salida de su versión anterior.
  Los tramos ya recorridos conservan su cálculo; una edición del maestro no cambia
  retroactivamente ese historial. Una demora real se registra como evento.
- Una carga entregada no cambia sus ubicaciones. Un histórico entregado que nunca
  tuvo identificadores de ubicación no se rellena retroactivamente.
- No se modifican ROOT/OWNER, `resolveActorContext`, permisos ni esquema SQL.

## Límites expresos

- Región/comuna se validan jerárquicamente, pero **no hay certificación espacial
  mediante polígonos territoriales**. La interfaz lo indica y muestra el punto para
  revisión; no se inventa una verificación automática de pertenencia comunal.
- El mapa antes de guardar muestra puntos; el trazado vial se calcula al guardar
  y se presenta en el resumen de la versión confirmada. No se dibuja una línea
  recta como si fuera una carretera calculada.
- Se mantienen los límites de 12 paradas y la revisión de restricciones del camión.
- Los registros antiguos puramente textuales sin itinerario no reciben un plan
  ficticio ni una migración automática. La nueva barrera de itinerario obligatorio
  previo al inicio se aplica a los viajes con puntos georreferenciados.
- Este cambio no reabre viajes cerrados ni procesa pendientes del teléfono. El POD
  rechazado por viaje cerrado requiere revisión separada, sin borrar sus evidencias.

## Verificación

Hay pruebas unitarias, Chrome con API sintética y SQL PostgreSQL embebido aislado
(PGlite): precarga, entrega intermedia, confirmaciones, fichas obsoletas, coordenadas
modificadas, rechazo multiempresa, snapshot por versión, rollback de auditoría,
conservación de recorrido ejecutado y continuidad del circuito de tres POD.
No equivalen a PostgreSQL nativo concurrente ni validación de Render o Android real.

Resultado local: **1.447 pruebas aprobadas, 0 fallos, 0 omisiones**, en 579,9 segundos.
Se ejecutó `node --test --test-concurrency=1 tests/*.test.js`, con los runtimes de
PGlite, Playwright y Leaflet disponibles. Registro de esta sesión:
`%TEMP%\fleetchile-coherence-full-20261029.log`.
También aprobaron `npm run check:syntax`, `npm run check:delivery` y `git diff --check`.

La web necesita commit/push y despliegue autorizados. Para incorporar el ajuste de
presentación del conductor en la app Android ya instalada, además habrá que ejecutar
`npm run sync` en `mobile/driver`, recompilar y actualizar el APK **sin desinstalarlo**.
No se han borrado borradores ni pendientes locales.
