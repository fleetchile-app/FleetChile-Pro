# Cierre ampliado: mejoras y validación local

Base revisada: `6622aad`. Entorno local aislado; sin arranque de `server.js`,
sin datos/bucket de producción, sin commit, push ni despliegue.
No se modifican `resolveActorContext()`, tablas de permisos, ROOT/OWNER ni esquema.

## Mejora funcional implementada

La administración del viaje ahora puede consultar los POD y descargar firma/foto
desde almacenamiento privado. Antes la ficha no tenía una vía de lectura de los
archivos de `delivery_proof_files`; mostrar receptor no demostraba consultar evidencia.

- Ruta `GET /api/operations/trips/:id/pod`: metadatos seguros, sin claves S3.
- Ruta `GET /api/operations/trips/:id/pod/:proofId/files/:fileId`: comprueba empresa,
  viaje, POD, archivo y permiso `trips.manage`. Si quien consulta es conductor,
  además exige que ese viaje siga asignado a su conductor autenticado.
- La lectura valida formato permitido, tamaño máximo, tamaño real y SHA-256 antes
  de enviar bytes; registra autor de descarga. Un fallo de almacenamiento,
  integridad o auditoría no se presenta como descarga correcta.
- Archivos con `private, no-store`, `nosniff`, nombre generado y sin enlaces públicos,
  firmas en URL ni clave del objeto. Espera S3 limitada a 20 segundos.
- En **Viaje → Entrega / POD**, botones de descarga, estados reales de documento y
  aviso cuando un registro no tiene evidencia. Texto escapado y respuesta tardía
  descartada si cambió viaje, sesión o empresa.
- Se conserva la creación administrativa previa: no se impone retroactivamente
  firma universal ni se inventa respaldo de registros históricos.

## Cobertura de los puntos solicitados

| Punto | Verificado o ampliado aquí | Límite pendiente |
|---|---|---|
| 1. POD | Tres entregas con firma/foto, metadatos administrativos, descarga íntegra, empresa ajena rechazada, subida fallida compensada y reintentos | Publicar y repetir con Gozunga/Render reales. |
| 2. Itinerario | Regresión SQL de orden, parciales/fallidas, reprogramación, sobrecarga, tramos pendientes, sustituciones y versiones; integrado de tres clientes | No sustituye un recorrido de carretera ni auditoría real del despliegue. |
| 3. Economía | Integrado ampliado: presupuesto, origen combustible, asignación, aprobación independiente, conciliación, reparto, cierre, reapertura y segundo cierre | Validación de datos/documentos reales de operación. |
| 4. Combustible | Dos altas por API, 500 km/100 litros = 5 km/l y 4 CLP/km en fixtures; primera medición sin rendimiento inventado; origen único | Los números son sintéticos, no datos de producción. |
| 5. Roles | Sesiones persistidas para seis roles empresariales, perfil propio asignado/desactivado, conductor acotado en el nuevo POD, soporte con caso/alcance/empresa/vencimiento | No se certifica toda la matriz de endpoints/usuarios de Render. ROOT/OWNER se preservan y mantienen sus regresiones existentes. |
| 6. Personal | Licencia vencida bloquea sesión; renovación recupera acceso; condición terminada notifica una vez y no levanta otros bloqueos | Fechas simuladas en fixtures; no transcurrió un día real de producción. |
| 7. Licencias comerciales | Regresión de cupos pagados, ampliación, techo, renovación futura/vencida y controles API/SQL por módulo | No se afirma ensayo exhaustivo de todos los caminos del despliegue. |
| 8. Recuperación/escala | 105 altas trazables, cinco páginas sin duplicados y sin cruce; Chrome real + IndexedDB/WebCrypto, recarga con firma/foto y misma clave ante respuesta perdida | PGlite no prueba carreras reales. PostgreSQL nativo multiconexión no disponible. |
| 9. Android | No se dispuso de dispositivo Android conectado | Cámara real, táctil, instalación, permisos, bloqueo y segundo plano siguen pendientes; no se prometen GPS continuo ni despertar remoto. |
| 10. PDF | Muestras con logo de 2 y 5 páginas, 120 viajes y nota extensa, renderizadas e inspeccionadas página por página; A4, encabezados, pie y continuidad legibles | Impresión física no probada. El PDF existente propio es ficha de conductor, no guía fiscal. |
| 11. PL41/GPS permanente | Sin modificaciones | Continúan aplazados. |

## Comando repetible

`npm run test:closure` agrupa aceptación integrada, roles/escala, itinerarios,
equipos, economía, licencias, soporte, POD, recuperación en navegador, branding y
regresiones de propietarios. Requiere `FLEETCHILE_TEST_PGLITE` y
`FLEETCHILE_TEST_PLAYWRIGHT` externos; falla si faltan, sin contar omisiones como éxito.
No usa `DATABASE_URL`. No reemplaza `npm run test:concurrency`, que requiere un
PostgreSQL local aislado y confirmación explícita de base desechable.

`node scripts/review-company-branding.js --stress` genera en un directorio temporal
una muestra sintética para revisión de impresión. No contiene datos de usuarios
ni se sube al repositorio. La aplicación mantiene la plantilla actual porque no se
identificó un defecto visual en las muestras revisadas.

## Resultado final

- Suite completa con PGlite, Chrome/Playwright y Leaflet habilitados: **1420 pruebas
  aprobadas, 0 fallidas, 0 omitidas**, duración 318,2 segundos.
- `check:syntax`, `check:delivery` y `git diff --check`: correctos.
- El nuevo comando de cierre comprueba sus prerrequisitos; sus 15 archivos existen
  y forman parte de la suite completa ejecutada. No se ejecutó PostgreSQL nativo.
- Registro de ejecución local: `%TEMP%/fleetchile-cierre-ampliado-final-20261029.log`.
- Revisión visual efectuada sobre las 7 páginas de dos muestras sintéticas (2 y 5
  páginas). No se alteraron la plantilla productiva ni documentos emitidos previamente.
- Estos resultados no equivalen a validación de Render, Gozunga real, Android físico,
  carga concurrente ni impresión física. Ninguno se contabiliza como aprobado aquí.

## Guías tributarias, sólo evaluación

Ver [evaluación SII](EVALUACION_GUIAS_SII_20261029.md). Se comprobó un cambio normativo
relevante y se propone separar documentos logísticos de emisión tributaria. No se
implementó ni se certificó un emisor, y no se tocó ese apartado.

## Publicación y aceptación posterior

1. Revisar cambios y autorizar por separado commit/push; no incluir herramientas
   locales, credenciales ni PDFs sintéticos temporales.
2. Comprobar hash desplegado y repetir POD real de firma/foto en Gozunga, descarga
   administrativa y denegación entre empresas. Usar cuentas/datos autorizados.
3. Repetir economía y multientrega, matriz por roles y licencias del despliegue.
4. Ejecutar pruebas físicas Android y PostgreSQL multiconexión aislado cuando estén
   disponibles. Una batería local aprobada no cierra esos dos pendientes.
