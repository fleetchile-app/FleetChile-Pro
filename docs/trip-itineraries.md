# PL16–PL24 — Itinerarios, cargas y tiempos

## Uso

En **Viajes → detalle → Resumen**, el panel **Itinerario, cargas y tiempos** permite planificar o modificar el recorrido. Se conserva la presentación existente y no se reemplazan los módulos de recursos, cargas, GPS o POD.

1. Registrar las cargas con su cliente y peso. Los clientes siguen perteneciendo a la empresa del viaje.
2. Asignar el vehículo o conjunto y conductor. La capacidad del acoplado no se suma a la cabina.
3. Abrir el planificador y seleccionar ubicaciones operacionales de la empresa. Si falta una dirección, el botón de registro usa la geocodificación existente; un fallo no genera coordenadas ficticias.
4. Ordenar entre 2 y 12 paradas, indicando propósito y minutos de atención, espera y descanso.
5. Vincular cada carga a una recogida y una entrega posterior. Una parada mixta descarga antes de recoger.
6. Indicar salida, contingencia, motivo y revisión operacional de restricciones.
7. **Calcular ruta y guardar versión** obtiene del proveedor cada tramo por carretera. Conserva geometría, distancia, duración, fuente y fecha, y actualiza la planificación del viaje dentro de una transacción.
8. Durante la ejecución, registrar llegadas y salidas en orden. Las entregas y evidencias conservan el circuito POD existente. Las incidencias son registros independientes; no entregan cargas ni completan el viaje.

## Cobertura por punto

| Punto | Implementación |
| --- | --- |
| PL16 | Paradas con claves estables, secuencia, ubicación, propósito, horas previstas y registro real del servidor. |
| PL17 | Recogida y entrega por carga; cliente, estado y POD existentes no se fusionan por compartir viaje. |
| PL18 | Peso a bordo después de cada descarga/recogida; capacidad por tramo y conjunto. Los tramos ya recorridos conservan su capacidad histórica al reemplazar equipos. |
| PL19 | Fallida, parcial, solicitud de reprogramación y transferencia con actor/motivo/historial. Una parcial registra kilos efectivamente entregados; el saldo sigue a bordo. |
| PL20 | Ruteo real integrado al guardado del plan, sin kilómetros o duraciones fabricados cuando falla el proveedor. |
| PL21 | Revisión operacional explícita y trazable de peso, altura, dimensiones y accesos. Cambiar equipo exige repetirla. No hay certificación automática de restricciones viales. |
| PL22 | Conducción, atención, espera, descanso y contingencia separados; total calculado sin duplicar las categorías. |
| PL23 | ETA consultada desde el trazado guardado, avance GPS reciente, llegadas/salidas y demoras declaradas. La vista abierta la actualiza cada 60 segundos y tiene actualización manual. |
| PL24 | Revisiones inmutables y control de versiones del viaje/recursos; historial con autor, motivo, itinerario y llegada prevista de cada versión. |

## Excepciones y capacidad

- Un intento fallido no descarga su peso. Una parcial descuenta sólo los kilos declarados y conserva el saldo.
- Una solicitud de reprogramación **no cambia sola el destino**: debe concretarse editando el plan y guardando una nueva versión. No se permite salir de una parada con entregas pendientes que continúen destinadas a ella.
- No se eliminan ni mueven paradas iniciadas, ni se reescriben recogidas ya iniciadas o destinos de cargas entregadas.
- Transferir una carga pendiente conserva el plan anterior del origen y crea una revisión sin esa carga. Si el destino ya tenía itinerario, debe incorporar explícitamente la nueva carga antes de operar.
- Peso cero o ausente se considera desconocido, no una carga vacía verificada. Una capacidad faltante no se inventa: se puede guardar una planificación incompleta sin sobrecarga conocida, pero no activarla con carga sin verificar.
- Los endpoints de inicio/reanudación administrativos y del conductor verifican coherencia de cargas, capacidad y equipo para viajes con itinerario. Detener continúa siendo posible.
- Completar un viaje con itinerario exige terminar sus paradas y resolver sus cargas. No se introduce una exigencia documental universal de POD para viajes históricos sin itinerario.

## ETA y restricciones: límites explícitos

El perfil vial existente es genérico. No verifica automáticamente altura de puentes, peso autorizado, dimensiones, mercancías especiales, cierres, acceso de camiones, peajes monetarios o tráfico en vivo. La revisión humana queda registrada y no debe interpretarse como una certificación del proveedor.

El avance GPS se aproxima proyectando la posición sobre la geometría vial ya calculada, con tolerancia de separación de 2 km y antigüedad máxima de 5 minutos. No se calculan nuevos kilómetros por distancia recta entre ciudades ni se promete exactitud de tráfico real. Posición ausente/antigua y desvío se indican como tales; requieren revisión y no representan una estimación GPS actual válida. Las demoras explícitas no vuelven a sumarse después de quedar absorbidas por una llegada/salida real posterior.

La ETA es una estimación consultada, no un job que modifique silenciosamente horarios contractuales o reservas. Cambiar la planificación reservada exige guardar una versión y pasar nuevamente por disponibilidad. No se optimiza ni altera automáticamente el orden de las entregas.

Los registros de ejecución del itinerario se realizan en el panel operacional. La interfaz móvil específica de próxima parada y navegación multientrega corresponde a PL34; no se cambia aquí su flujo de firma/evidencias. Tampoco se inicia trabajo del bloque económico PL25–PL29.

## Seguridad, esquema y pruebas

Se usan los permisos existentes `trips.manage`, `loads.manage` para transferencia y los controles de contexto empresarial. No se modifica `resolveActorContext()` ni se añaden privilegios globales. Cada ubicación/carga/recurso se valida del lado servidor; coordenadas, métricas, autor y tiempo real no provienen del formulario.

La migración aditiva e idempotente `035_trip_itineraries.sql` se registra en el mecanismo existente de inicio. No reconstruye planes históricos. Incluye restricciones empresariales, revisiones/eventos inmutables y protección contra edición alternativa de la cabecera temporal de un viaje versionado. No ejecutar SQL manual en producción.

Hay pruebas de dominio, interfaz aislada y PostgreSQL aislado con PGlite. Los fixtures de proveedor y coordenadas son exclusivamente sintéticos de prueba. Estas pruebas no sustituyen aceptación visual en navegador, prueba del proveedor real en Render, prueba de Android ni concurrencia multiconexión. No se inició el servidor, ejecutaron migraciones en producción ni se publicó este bloque durante su desarrollo.
