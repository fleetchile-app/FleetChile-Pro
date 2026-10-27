# Preparación de instalación privada (PL45)

Configuración preparada, NO instalación independiente demostrada. Docker no está disponible en el entorno de desarrollo usado para esta entrega. Las pruebas SQL aisladas no acreditan Docker, TLS, S3 real ni recuperación. No se crea ni restaura una base de producción.

## Requisitos del operador

1. Host con Docker y Compose compatibles con env_file.required, DNS, proxy HTTPS y recursos suficientes.
2. PostgreSQL exclusivo o autorizado, cuenta con capacidad para migraciones y CA TLS válida. Separar entornos; no reutilizar DATABASE_URL de producción para ensayos.
3. Bucket S3 privado, sin lectura pública, cifrado del proveedor y credenciales mínimas para put/get/head/delete del espacio de FleetChile. No colocar claves en Git. Probar permisos y objetos fuera de producción.
4. Definir política de respaldo/restauración antes de ofrecer recuperación; este bloque no implementa PL41.

## Configuración

Crear localmente `deploy/.env.private` a partir de los nombres de .env.example y custodiarlo fuera de Git. DATABASE_URL debe usar el host accesible desde el contenedor (localhost sería el propio contenedor). Para PostgreSQL remoto configurar DATABASE_SSL=true y DATABASE_SSL_VERIFY=true; DATABASE_SSL_CA_BASE64 es opcional cuando la CA ya está en el almacén de confianza. Si se requiere CA privada, entregar su PEM codificado en base64 por un canal seguro. No imprimir DSN o secretos al diagnosticar.

Compatibilidad: el servidor no cambia silenciosamente los despliegues existentes que usan verificación desactivada. La pantalla lo advierte y `node scripts/check-delivery.js --config` exige TLS verificado para cerrar aceptación en NODE_ENV=production. Activarlo requiere validar primero la CA y la conexión en staging. El script lee variables del proceso; NO carga automáticamente .env ni conecta con proveedores.

Configurar S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT si el proveedor lo necesita y S3_FORCE_PATH_STYLE según proveedor. EXPORT_* y MONITOR_TECHNICAL_DAYS se describen en .env.example. No habilitar endpoints HTTP internos como si fueran HTTPS públicos. APP_REVISION permite informar un hash Git; Render usa RENDER_GIT_COMMIT.

## Ejecución, solo con autorización

Desde la raíz: `docker compose -f deploy/compose.private.yml config --quiet` valida sintaxis sin imprimir secretos. Luego build/up son acciones mutantes autorizables, no pruebas de lectura. El primer arranque ejecuta schema/seed y migraciones registradas, incluida 041. Preparar empresa/cuenta inicial siguiendo el mecanismo de bootstrap existente; no inventar contraseñas ni aplicar SQL manual de producción.

La app se publica solo en 127.0.0.1:3000 y requiere proxy TLS local. No exponer el puerto directamente a internet. Compose define raíz de solo lectura, usuario no root de la imagen, /tmp efímero de 256 MiB, capacidades eliminadas y healthcheck a /api/ready. Mantener exportaciones en 100 MiB mientras ese tmpfs no se amplíe de forma controlada. Las dependencias usan npm ci con package-lock; esto no fija por digest la imagen base ni constituye un escaneo de vulnerabilidades.

## Aceptación pendiente obligatoria

- Construir y arrancar en entorno desechable, ejecutar migraciones completas y comprobar /api/ready; no basta /api/health.
- Probar TLS con CA válida y rechazo con CA incorrecta, sin cambiar producción.
- Verificar login y alcance multiempresa, personalización/PDF, flujo conductor y credenciales privadas S3.
- Generar/descargar exportación pequeña, cotejar hashes, provocar adjunto faltante y comprobar limpieza de temporales/copias vencidas tras reinicio.
- Ensayar SIGTERM, reinicio, permisos no root, /tmp y salida del proxy, y documentar hash/fecha/resultado.
- Verificar mecanismos de respaldo/restauración al abordar PL41; una exportación no los reemplaza.

Render actual no necesita Compose. Este archivo prepara una modalidad privada separada; no modifica por sí solo el servicio, su dominio o sus variables.
