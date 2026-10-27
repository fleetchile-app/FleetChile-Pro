# Entrega operacional — PL42, PL44, PL45 y PL46

Estado: candidato a validación; no declaración de cierre de producción. Mantiene Node/Express/PostgreSQL, SPA y PWA. No introduce nuevos permisos ni cambia resolveActorContext.

## Portabilidad (PL42)

En Mi empresa → Exportar datos, el administrador completo indica motivo, confirma custodia y vuelve a ingresar su contraseña. Plataforma dispone de Exportar empresa dentro de un contexto empresarial autorizado; soporte limitado no puede exportar. Una empresa solo tiene una solicitud activa. Actualizar estado permite seguir su preparación; la descarga exige nuevamente contraseña, sin enlaces públicos ni credenciales en la URL.

El archivo `.tar.gz` contiene `LEEME.txt`, `manifest.json`, JSON UTF-8, CSV delimitado por punto y coma con protección frente a fórmulas, y adjuntos privados administrados (POD, consentimientos, logos y documentos emitidos). El manifiesto identifica fecha UTC, empresa, datasets y SHA-256. Los nombres .bin de evidencia se interpretan con el MIME del manifiesto. No incluye contraseñas, sesiones, propietarios, permisos globales, cuerpos genéricos de auditoría ni borradores de importación. Los enlaces externos se conservan como referencia; no se descargan URLs arbitrarias. Los datos estructurados de otras empresas se excluyen; textos y archivos aportados por usuarios siguen requiriendo una política de custodia.

Es una exportación legible, NO un respaldo restaurable ni una restauración integral. El catálogo explícito está en portability-catalog.js: agregar una tabla requiere revisar su aislamiento e incorporarla a pruebas. Auditoría exportada: metadatos de autor/acción/entidad/fecha; no sus cuerpos potencialmente compartidos. La autenticación y los catálogos globales no son un dump SQL.

Un adjunto administrado ausente, tamaño incorrecto o hash diferente hace fallar el paquete completo. Códigos EXPORT_ATTACHMENT_UNAVAILABLE / INTEGRITY requieren revisar el objeto original; volver a exportar no lo repara. Nunca borrar evidencia para forzar éxito. Si se interrumpe el proceso, la copia incompleta falla con EXPORT_INTERRUPTED y puede solicitarse otra. SHA-256 verifica integridad, no prueba autenticidad criptográfica ni sustituye cifrado del disco del destinatario.

Las copias privadas vencen tras 24 horas. Se eliminan en el próximo ciclo del worker activo (15 s), por lo que una instancia dormida puede retrasar la eliminación física; el servidor niega la descarga desde la fecha de vencimiento. Los temporales se limpian al terminar o al recuperar trabajos registrados tras un reinicio. No se borran documentos originales. Una sola instancia trabajadora a la vez usa un advisory lock PostgreSQL; el snapshot consistente es REPEATABLE READ, de solo lectura. PostgreSQL y archivos S3 no comparten una transacción: las comprobaciones de tamaño/hash detectan cambios o faltantes.

Límites por defecto: 100 MiB (incluye archivo tar sin comprimir), un millón de filas, 10.000 adjuntos y 10 minutos. Falla explícita si se exceden; no se entrega una copia truncada. Hay CSV solo para las entidades principales; JSON cubre el catálogo permitido. Descarga SPA usa un blob del navegador: para empresas mayores se necesita ampliar diseño/límites, no elevarlos indiscriminadamente. Temp y gzip pueden coexistir: reservar al menos el doble del máximo más margen. Compose ofrece 256 MiB temporales para el límite inicial.

## Monitoreo y conservación (PL44)

Plataforma → Estado del servicio muestra base de datos, memoria, revisión cuando está informada, tareas automáticas e incidentes técnicos agregados. Credenciales S3 configuradas no significa que el bucket responda. La revisión de un incidente se audita y NO equivale a resolverlo. Tareas automáticas y base de datos marcan recuperación al comprobar éxito; un HTTP 5xx agregado requiere investigación, no se da por reparado con solo abrir la pantalla.

X-Request-Id permite identificar la respuesta; los registros técnicos guardan códigos fijos y fechas, no cuerpos, contraseñas, DSN ni errores sin filtrar. No hay traza distribuida por solicitud ni alerta externa implementada aquí. Revisar códigos, estado y readiness sin publicar variables de entorno. Un fallo de PostgreSQL puede impedir registrar el incidente en la base: queda código genérico en stdout y readiness falla.

Solo incidentes técnicos resueltos se purgan después de 15, 30 o 90 días (MONITOR_TECHNICAL_DAYS; predeterminado 30). Los abiertos permanecen. No se purgan negocio, auditoría, personal, documentos ni GPS. Su política legal/comercial debe aprobarse expresamente. En Render free, un proceso dormido no ejecuta tareas ni constituye monitoreo externo de uptime.

## Publicación y recuperación

Ejecutar check:syntax, check:delivery y pruebas con runtimes aislados habilitados; revisar diff y archivos staged. Después de autorización humana: commit/push con rutas explícitas. Render ejecuta las migraciones versionadas al arrancar: publicar es una acción con efectos en base, no solo subir archivos. No ejecutar npm start como verificación inocua.

Validación de producción: revisión esperada en Render, readiness, roles, exportación pequeña real, custodia/descarga, incidentes y aislamiento. Ante fallo detener nuevas publicaciones, conservar evidencia técnica sin secretos y evaluar un cambio correctivo. No se suministra un comando de rollback destructivo ni se prometen downgrades de esquema: revertir código no revierte una migración. Restauración requiere PL41, expresamente aplazado.

Pendiente: PL41 respaldo/restauración; GPS permanente; PL43 concurrencia en conexiones independientes; instalación privada real con Docker/TLS/S3; aceptación humana por rol. PL47–52 fuera de este bloque.
