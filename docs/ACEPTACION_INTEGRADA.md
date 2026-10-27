# Aceptación integrada y concurrencia — cierre transversal

Esta etapa comprueba los bloques ya implementados. No agrega módulos PL47–52, no cambia permisos ni resuelve GPS permanente o respaldos PL41. No autoriza pruebas destructivas en producción.

## Qué prueba automáticamente el recorrido integrado

`npm run test:acceptance` ejecuta el circuito sobre una base PGlite desechable en memoria, con schema y todas las migraciones vigentes. Requiere FLEETCHILE_TEST_PGLITE apuntando al paquete instalado por separado; el comando falla si falta el runtime, en vez de considerar pruebas omitidas como aceptación. No lee DATABASE_URL, inicia FleetChile, conecta a Render ni modifica datos reales.

Los administradores iniciales y sus contratos se preparan como fixtures SQL; desde allí se ejercitan las rutas reales con sesiones almacenadas y authMiddleware, permisos reales y commercialGate, no con identidades y permisos arbitrarios inyectados. El harness reproduce también el encadenamiento de rutas Express que usan next(). No es una prueba HTTP de despliegue ni reemplaza navegador/teléfono.

| Paso | Resultado esperado |
| --- | --- |
| Dos empresas, administradores y consulta | Sesión obligatoria; sin lectura ni creación no autorizadas |
| Tres clientes propios | RUT válido, consentimiento no bloqueante, sin acceso desde empresa B |
| Persona/cuenta conductora | Contrato y licencia; selección para alta operacional una sola vez |
| Vehículo de 10 t | Alta sin documentos permitida; asignación bloqueada hasta completar fechas |
| Plan de cinco, contrato pagado de uno | Solo opera la unidad identificada pagada; otra alta no recibe cupo automático |
| Licencia y condición laboral | Sesión bloqueada por vencimiento/vacaciones; renovación o fin de condición recuperan elegibilidad; autor registrado |
| Retorno por fechas | Condición ya finalizada no bloquea y genera notificación sin duplicados; no se espera un cambio de día real |
| Itinerario con tres clientes | Capacidad a bordo 10/6/3 t; una versión antigua no sobrescribe |
| Conductor | Aceptación, checklist, recogida y salida; incidente independiente |
| Tres entregas/POD | Firma y registro privado por carga; reintento conserva un solo POD |
| Taller tras el viaje | Ingreso bloquea nueva asignación; liberación técnica permite operar aunque el costo esté pendiente |
| Cierre económico | Cambio tardío de ingreso requiere segundo aprobador; gasto aprobado/conciliado; reparto por cliente antes de cerrar |
| Autoría y resultados | Historial con usuarios reales de las sesiones; ingresos/costos y reportes coherentes |

Todos los nombres, RUT de ejemplo, importes, posiciones, rutas, pagos, firmas y eventos son fixtures sintéticos. El proveedor de ruteo devuelve tramos de prueba: sus distancias y tiempos NO corresponden a Concepción–Santiago ni deben copiarse a operación. Los adjuntos se guardan en un doble S3 privado en memoria, no en el bucket real.

## PL43 — PostgreSQL nativo con conexiones independientes

`npm run test:concurrency` es una suite separada. No usa PGlite y NO se omite silenciosamente si falta PostgreSQL. Verifica PIDs de backend distintos, dos operadores compitiendo por la misma reserva, edición con versión obsoleta, aislamiento de clientes y rollback si falla auditoría.

Requisitos: servidor PostgreSQL LOCAL dedicado exclusivamente a pruebas, separado del servicio de la aplicación; cuenta con permiso CREATE DATABASE y eliminación de la base creada. No instalar, arrancar servicios o conectar a un entorno compartido sin autorización. Docker y PostgreSQL nativo no estaban disponibles en el equipo al preparar este bloque.

Configurar en el proceso local, sin pegar secretos en chats, sin incluirlos en Git:

- FLEETCHILE_TEST_PG_URL: conexión a la base administrativa postgres o template1 en localhost, 127.0.0.1 o ::1. Sin parámetros de URL que puedan sobrescribir host o base.
- FLEETCHILE_TEST_PG_CREATE: valor explícito `disposable-local-database`.
- DATABASE_URL NO se usa como conexión alternativa. Si apunta a un host local en el mismo puerto, la prueba se rechaza, incluso entre alias localhost/127.0.0.1.

El runner crea una base nueva de nombre aleatorio `fleetchile_accept_<24 hex>`, aplica las migraciones SOLO allí y usa un pool independiente. Al finalizar cierra sus conexiones y elimina únicamente esa base creada por la ejecución. Si el proceso se interrumpe abruptamente puede quedar una base de prueba: identificarla y revisarla antes de cualquier limpieza; nunca usar un comodín DROP sobre bases del servidor. Las operaciones locales de creación/eliminación forman parte de esta prueba desechable, no de la aplicación ni de producción.

La suite inicial NO acredita ausencia universal de interbloqueos. Antes de cerrar PL43, ampliar y ejecutar el cruce de cambios de estado, reasignación, cambios de itinerario, renovación/suspensión de personal, checklist y recepción en taller. En código hay caminos con órdenes de bloqueo diferentes (por ejemplo, el cambio administrativo de estado toma el viaje antes de validar personal, mientras que la asignación versionada toma personal antes del viaje). Esto es un riesgo identificado por inspección, NO un deadlock reproducido en PostgreSQL real. No declarar cerrado ni modificar a ciegas las reglas de negocio: reproducirlo con conexiones independientes y corregir el camino demostrado.

## Aceptación humana en entorno autorizado

Usar empresa y cuentas de prueba, sin datos personales reales innecesarios. Registrar hash desplegado, fecha, operador y resultado. No convertir capturas locales en evidencia de producción. Verificar primero que Render ejecutó el commit esperado y que /api/ready responde; nunca aplicar SQL manual como atajo.

1. Administrador crea tres clientes y un vehículo; crea/regulariza la persona conductora, la selecciona en Conductores y verifica contrato/licencia.
2. Plataforma confirma plan, pago y cupos identificados. Empresa no puede habilitar unidades adicionales ni activar módulos no contratados.
3. Crear viaje de madera Concepción → Chillán → Talca → Santiago con carga/cliente y direcciones reales de prueba aprobadas. Usar el proveedor real; no ingresar las distancias sintéticas de los tests. Verificar cantidades y capacidad después de cada descarga.
4. En Android, aceptar viaje, completar checklist, registrar llegada/recogidas y salida. Mantener las precauciones del manual: no usar el teléfono conduciendo.
5. Primera entrega: firma y foto cuando corresponda. Antes de confirmar, cortar red; editar/guardar, reconectar y reenviar. Comprobar un solo POD, una sola entrega y evidencia privada visible para administración.
6. Segunda entrega: registrar incidente o entrega fallida/parcial. Confirmar que no entrega automáticamente las otras cargas; reprogramar con motivo si corresponde.
7. Completar las entregas pendientes y el viaje. La finalización no implica regreso a base ni cierre económico.
8. Ingresar a taller, registrar diagnóstico/hallazgos/trabajos y liberar técnicamente. Comprobar que una factura tardía no reescribe el trabajo y que no se asigna el vehículo mientras esté inmovilizado.
9. Registrar ingreso/costos, autorizar con otra cuenta, conciliar y repartir por carga/cliente. Comparar viaje, reporte y dashboard. No cerrar mientras falten requisitos.
10. Probar bloqueo/renovación de licencia y condición temporal con usuarios de prueba; confirmar quién modificó el registro. No alterar la hora del servidor para simular retorno.
11. Revisar exportación, adjuntos, hashes, estado del servicio y acceso A/B; guardar las pruebas sin divulgar firmas, tokens o contraseñas.

Pendientes reales: Android y red intermitente, proveedor vial/S3 reales, Render, PostgreSQL multiconexión, instalación privada y capacitación. GPS permanente y respaldo/restauración permanecen aplazados por decisión del usuario.

## Resultado local registrado — 27-10-2026

- Recorrido integrado y guardas de seguridad: 11 pruebas aprobadas, 0 fallos, 0 omitidas. Incluye comparación del viaje específico en reporte y dashboard, y reintentos POD.
- Regresión habitual con PGlite y Chrome habilitados: 1.340 pruebas aprobadas, 0 fallos, 0 omitidas. La suite nativa `acceptance-native.pg.js` está separada y NO forma parte de este total.
- check:syntax, check:delivery, sintaxis de los helpers/tests y git diff --check correctos.
- PostgreSQL nativo y Docker no disponibles; el usuario confirmó que aún hay que preparar PostgreSQL local. No se ejecutó test:concurrency ni se instaló o arrancó un servicio nuevo. PL43 no está cerrado.
- No se comprobó un defecto funcional reproducible en el circuito integrado. Se mantienen las reglas existentes, sin modificar RBAC, resolveActorContext, esquema o comportamiento de producción. El riesgo de orden de bloqueos descrito arriba sigue pendiente de reproducción nativa.
- Sin commit, push, despliegue, arranque de FleetChile ni conexión a la base/bucket de producción.
