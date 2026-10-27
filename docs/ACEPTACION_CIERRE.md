# Matriz de cierre y aceptación

Registrar por caso: versión/hash desplegado, entorno, fecha, responsable, evidencia no sensible y aprobado/fallido. Una prueba aislada no se convierte en aceptación de producción. Sin resultados reales, los siguientes casos permanecen pendientes.

| Caso | Verificación | Evidencia requerida |
| --- | --- | --- |
| Empresa A / B | Usuario A no consulta ni descarga paquete B por API directa; soporte limitado denegado | Respuestas 403/404, sin datos ajenos |
| Portabilidad | Solicitud autenticada e idempotente; archivo completo, SHA-256 y adjuntos | Paquete pequeño de staging contrastado con origen |
| Fallos | Adjunto faltante/hash incorrecto y auditoría fallida no publican parcial | Estado fallido, sin copia descargable |
| Recuperación de worker | Interrupción y vencimiento limpian únicamente copias generadas | Reinicio real y evidencia original intacta |
| Monitoreo | Readiness, tareas, repetición, revisión y recuperación | Plataforma accede, empresa no; ausencia de secretos |
| Conservación | Purga técnica cerrada; incidente abierto y negocio conservados | Consulta de staging y política aprobada |
| Instalación privada | Docker no root, TLS, PostgreSQL, S3, proxy y SIGTERM | Registro de instalación independiente; pendiente |
| Flujos por rol | Empresa, operaciones, mantenimiento, conductor y finanzas | Guía recorrida por usuarios autorizados |
| Concurrencia PL43 | Dos conexiones independientes asignando/actualizando recursos | Ensayo PostgreSQL multi-conexión pendiente |
| Móvil | Teléfono Android, conexión intermitente, reintentos y cierre sesión | Resultado real; GPS permanente excluido |

## Lista de publicación

1. Revisar git diff, excluir herramientas locales, archivos .env y material privado.
2. check:syntax, check:delivery y suite completa con PGlite/Playwright habilitados; registrar pruebas omitidas si existen.
3. Revisión humana y autorización de commit/push. No presentar una migración como aplicada antes del arranque autorizado.
4. Validar hash en Render y casos prioritarios en staging/producción autorizada; comprobar almacenamiento privado y capacidad de /tmp.
5. Capacitar según MANUALES_POR_ROL.md y dejar pendientes visibles.

## Estado y exclusiones de esta entrega

PL42 y PL44 tienen implementación y pruebas locales; aceptación real según casos de arriba. PL45 tiene preparación técnica/documentación, pero falta demostrar instalación independiente. PL46 entrega guías y procedimiento; la capacitación y aceptación humanas no se autocompletan. PL43 continúa pendiente donde exige conexiones simultáneas reales. PL41 y GPS permanente se mantienen expresamente aplazados. PL47–52 necesitan decisión separada. No se declara completado el desarrollo total.

## Verificación local de esta entrega

27-10-2026: suite completa con PGlite y Chrome habilitados: 1.329 pruebas aprobadas, 0 fallos, 0 omitidas. check:syntax y check:delivery correctos. SQL y migraciones se probaron en una base aislada en memoria; no se inició FleetChile ni se conectó a la base de producción. Chrome probó escritorio y ancho móvil de 390 px, escape de texto, confirmación y descarga sin contraseña en URL ni localStorage. No hubo commit, push, despliegue o migración de producción. Docker no está instalado; la modalidad privada permanece preparada pero no demostrada.
