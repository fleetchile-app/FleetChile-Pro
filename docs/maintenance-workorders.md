# Mantención operacional — PL07 a PL13

## Uso

En **Mantenciones** existen dos entradas: **Programar mantención** e **Ingresar
al taller**. Ambas seleccionan un vehículo de la empresa; no se escribe su patente
ni se solicitan costos finales al ingresar.

1. **Programar:** motivo, tipo Preventiva/Correctiva y al menos una fecha o lectura
   objetivo de km/horas. Taller y responsable son opcionales. No inmoviliza.
2. **Ingresar:** fecha/hora real, odómetro y opcionalmente horómetro y conductor que
   entrega. Un viaje en ejecución o una mantención en proceso impiden otra recepción.
   Se cambia el vehículo a Mantención. Una programación puede recibirse después.
3. **Ficha:** registrar diagnóstico y resumen de trabajos, responsables, servicios,
   mano de obra y repuestos. Los ítems admiten cantidad, precio unitario estimado y
   real, y estado Pendiente/Realizado/Cancelado. Cancelar un ítem exige motivo.
4. **Hallazgos:** registrar severidad, responsable y, si corresponde, seleccionar una
   alerta de checklist rechazado de ese vehículo. Deben pasar Abierto → Reparado →
   Verificado, con acción correctiva y usuarios responsables trazados. Se puede
   reabrir antes de la liberación dejando el motivo.
5. **Liberación técnica:** exige diagnóstico, resumen, trabajos terminados o
   cancelados con motivo, hallazgos verificados y lecturas de salida. Los checklist
   rechazados pendientes deben estar vinculados y reparados. Se resuelven sólo las
   alertas verificadas de esa orden, con autor y nota técnica. Un precio pendiente
   no impide liberar; los documentos viales siguen controlándose al asignar/circular.
6. **Cerrar costos:** después de liberar se pueden completar los precios reales,
   sin reescribir trabajos ni reparaciones. El total se calcula desde los ítems.
   Cero requiere confirmación con motivo; un precio desconocido no es cero.
   El cierre financiero no altera la disponibilidad del vehículo.

El vehículo vuelve a su estado previo al recibirlo, salvo un estado previo
Mantención/En ruta sin viaje en ejecución, que se normaliza a Disponible.
No se libera sobre otro trabajo En proceso ni se reemplaza un estado distinto
establecido posteriormente fuera de este circuito. No se cancelan ingresos reales
para eludir su liberación técnica: sólo se cancelan programaciones.

## Cobertura integrada

| Punto | Implementación |
| --- | --- |
| PL07 | Programación separada de recepción, odómetro, conductor opcional e inmovilización. |
| PL08 | Ficha versionada, diagnóstico, trabajos y responsable interno. |
| PL09 | Repuestos/mano de obra/servicios con cantidades y precios estimados/reales; desconocido distinto de cero. |
| PL10 | Checklist rechazado → hallazgo → reparación → verificación → resolución trazable al liberar. |
| PL11 | Liberación técnica independiente del cierre financiero. |
| PL12 | Rutina preventiva opcional por días, km u horas. Al liberar, programa la siguiente orden sin inmovilizarla. Alertas existentes extendidas a horómetro. |
| PL13 | Lecturas inmutables, control de no retroceso y cronología, historial de autores y duración de inmovilización desde ingreso hasta liberación, no hasta pago/cierre. |

Los avisos se consultan en la lista y en el generador existente del centro de
Incidentes. Este bloque no incorpora un nuevo servicio periódico de notificaciones
ni envío de mensajes externos. Las horas se registran explícitamente; no se
convierten kilómetros en horas ni se infieren de GPS.

## Seguridad y compatibilidad

- Usa los permisos existentes: `maintenance.manage` para órdenes; las acciones que
  modifican estado/lecturas de flota requieren también `fleet.manage`. No modifica
  `resolveActorContext()`, roles, ROOT/OWNER ni sus políticas.
- Empresa obtenida del contexto autenticado, no del cuerpo enviado. IDs de recursos,
  responsables y alertas se contrastan con esa empresa.
- Toda mutación bloquea vehículo → orden, exige versión y registra auditoría/evento
  en la misma transacción. Las lecturas y eventos no admiten UPDATE/DELETE.
- La migración **033_maintenance_workorders.sql** es aditiva y versionada. No inventa
  ingresos, costos ni liberaciones para históricos. No fue aplicada a producción.
- Los históricos siguen consultables. El GET económico de mantenciones y la edición
  histórica se conservan; el PATCH antiguo no puede modificar órdenes nuevas.
- POST `/api/fleet/maintenance` devuelve 410 y remite a `/api/fleet/work-orders`,
  para evitar altas que mezclen ingreso y resultado final. No se borran registros.
- La nueva pantalla usa la SPA y estilos existentes, sin frameworks ni cambio de menú.

## Verificación pendiente de aceptación

Las pruebas locales incluyen validadores, navegación/formularios y SQL PostgreSQL
embebido en memoria. No sustituyen pruebas multiconexión ni aceptación visual en
Render. Probar: programar por fecha/km/horas; recibir desde la base sin conductor;
registrar hallazgo y reparar/verificar; liberar sin conocer aún el costo; completar
precios y cerrar; confirmar que el viaje se bloquea durante la estadía y se reevalúa
tras la liberación. Revisar con dos operadores una versión obsoleta.

No iniciar el servidor ni ejecutar SQL en producción para verificar este bloque.
El despliegue y la ejecución de la migración requieren autorización separada.
