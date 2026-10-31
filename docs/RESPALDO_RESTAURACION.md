# PL41 — Respaldo y restauración integral

Herramienta operativa separada de la aplicación. No ofrece descarga administrativa ni exportación por tenant. No importa `server.js`/`startup.js`, no arranca la app, no ejecuta seeds de aplicación y no modifica producción. La restauración implementada es exclusivamente un **drill local aislado**, no un procedimiento de recuperación sobre producción.

## Alcance y formato v1

Un directorio privado `BACKUP_ROOT/pl41-<uuid>/` contiene:

- `database.fcbak.enc`: `pg_dump --format=custom`, cifrado directamente desde stdout.
- `object-N.fcbak.enc`: cada objeto S3 vivo referenciado por el snapshot, con su clave original en el manifiesto cifrado.
- `manifest.fcbak.enc`: formato/version, fecha/snapshot, versión de PostgreSQL/herramientas/aplicación, esquema y SHA-256, contenidos y cuentas por tabla/tenant, catálogo de referencias, versiones S3/ETag disponibles, tamaños y hashes de texto claro y cifrado de cada archivo, exclusiones explícitas.
- `READY.json`: identificador/versión y hash del manifiesto cifrado. Se escribe **último**; un directorio sin este marcador nunca es un respaldo utilizable.

Cada sobre usa AES-256-GCM, nonce aleatorio de 96 bits independiente, tag de 128 bits y cabecera autenticada `FCPL41G1`. Los archivos completos, incluyendo el manifiesto y las claves S3, permanecen cifrados. Los nombres `*.fcbak.enc` y los directorios `backups/`, `recovery-drills/` deben estar excluidos de Git y del contexto Docker. No almacenar llaves, secretos ni resultados de drills en el repositorio.

El dump incluye todas las empresas, cuentas, memberships/ROOT/OWNER, auditoría, permisos, catálogos y datos privados almacenados en PostgreSQL (incluidos PDF/logos bytea). Usa `--no-owner --no-acl`: no reproduce roles globales del clúster, propietarios, ACL, tablespaces, configuración del servidor ni secretos externos. Se requieren las extensiones de PostgreSQL presentes en el respaldo. No copia objetos S3 huérfanos sin referencia DB ni URLs externas. Rechaza tablas extranjeras: no simula respaldo de sus datos.

## Snapshot y catálogo de archivos

La conexión fuente abre `REPEATABLE READ READ ONLY`, desactiva filtrado RLS (`row_security=off`, falla si faltan permisos), exporta `pg_export_snapshot()` y mantiene la transacción abierta durante inventario, dump y copia S3. `pg_dump --snapshot=<id>` utiliza ese mismo snapshot. No usa `DATABASE_URL` como fallback.

El catálogo recorre `pg_catalog` para todas las tablas de usuario y columnas llamadas `storage_key` o terminadas en `_storage_key`, en todos los esquemas y tenants. Registra columnas aunque tengan cero referencias, cuenta referencias y deduplica claves. Incluye claves derivadas de exportaciones `ready`: `companies/<company_id>/exports/<id>.tar.gz`, incluso si `storage_key` es NULL. Rechaza una clave derivada discordante y un export worker `running`.

**Única exclusión de objetos eliminados:** en `public.platform_company_purge_files`, las filas con `deleted_at IS NOT NULL` son tombstones confirmadas. Se conserva íntegra su tabla de auditoría en el dump y el manifiesto registra `catalog.skippedDeletedReferences` con count/reason. Una fila con `deleted_at IS NULL` sigue exigiendo el objeto. No se omiten evidencias operativas faltantes ni se borran tablas de purga/auditoría.

Si falta cualquier objeto requerido, falla un stream, no coincide su tamaño/hash DB, o S3 informa una modificación posterior al snapshot, el proceso falla **sin READY**. Una exportación `ready` cuyo archivo desaparece por expiración/cleanup concurrente exige pausar ese cleanup y repetir **todo** el respaldo; no se acepta un paquete incompleto.

PostgreSQL no proporciona una transacción distribuida con S3. Antes de `create`, el operador debe detener escrituras/borrados de objetos, expiraciones, lifecycle y workers de exportación/purga durante la copia, y establecer `BACKUP_OBJECTS_QUIESCED=yes`. Esto es una declaración operativa, **no un bloqueo automático**. Los objetos referenciados deben ser inmutables. SHA-256 DB, VersionId/LastModified ayudan a comprobarlo; un proveedor sin esa metadata no permite demostrar retrospectivamente la versión exacta al instante DB. El respaldo registra lo observado, no inventa esa evidencia. Los valores de secuencias tienen la semántica no MVCC de PostgreSQL/pg_dump.

## Datos efímeros y revocación

`excludedEphemeral` declara tabla/esquema/razón. Se excluye **DATA**, conservando esquema/FK, de:

| Tabla | Motivo |
| --- | --- |
| `user_sessions` | No reactivar sesiones de autenticación. |
| `driver_tracking_sessions` | Capacidades GPS con FK a sesiones de autenticación. |
| `driver_tracking_positions` | Recibos de deduplicación con FK a sesiones GPS. |

`telemetry` conserva las posiciones GPS. `audit_logs`, auditorías de autenticación y `driver_mobile_actions` se conservan. El inventario calcula para las tablas efímeras cero filas y SHA-256 del contenido vacío, por lo que la comparación tras el drill es determinista. Si aparece una FK desde una tabla persistente a estas tablas, el catálogo falla y exige revisar la política; no borra nuevos datos silenciosamente.

En el drill se revocan defensivamente primero recibos GPS, luego sesiones GPS y finalmente sesiones auth; se comprueba que estén vacías. No iniciar la app restaurada ni workers contra servicios reales. Se requiere autenticación nueva para cualquier ensayo posterior autorizado. No reutilizar configuración/credenciales de producción.

## Configuración explícita

Node >=20 y `pg_dump`/`pg_restore` de la **misma versión mayor** que fuente y destino. Sin autodetección remota ni instalación en producción. `BACKUP_PG_BIN` es el directorio de binarios (en Windows, por ejemplo `C:/Program Files/PostgreSQL/<major>/bin`).

| Variable | Contrato |
| --- | --- |
| `BACKUP_DATABASE_URL` o `BACKUP_DATABASE_URL_FILE` | Fuente explícita, con usuario/password. Nunca fallback a `DATABASE_URL`. No pasar URL como argumento CLI. |
| `BACKUP_PG_SSLROOTCERT` | Ruta de CA PEM confiable, accesible por Node y libpq, fuera del repo. Node verifica certificado/hostname; pg_dump usa `PGSSLROOTCERT`. No se imprime su contenido. |
| `BACKUP_KEY_FILE` | Ruta absoluta a archivo privado de exactamente 32 bytes aleatorios, o 64 caracteres hex. No es la llave literal. |
| `BACKUP_ROOT` | Directorio absoluto privado local para bundles. El proceso crea subdirectorios 0700; en Windows retira herencia y concede acceso al SID del usuario ejecutor. |
| `BACKUP_SOURCE_S3_BUCKET`, `REGION`, `ENDPOINT`, `FORCE_PATH_STYLE` | Prefijo completo `BACKUP_SOURCE_S3_` para cada variable. Endpoint opcional; HTTPS obligatorio para fuente. No fallback a `S3_*` de la app. |
| `BACKUP_SOURCE_S3_ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `SESSION_TOKEN` | Credenciales fuente independientes, preferentemente sólo lectura de todos los objetos requeridos. Cada nombre también admite sufijo `_FILE` para secretos montados. No usar las dos variantes a la vez. |
| `BACKUP_OBJECTS_QUIESCED=yes` | Atestación del requisito operativo de objetos/GC descrito arriba. Obligatorio para crear. |

Para PostgreSQL externo, el valor predeterminado es `sslmode=verify-full`; se rechaza `sslmode=disable` fuera de loopback y `sslmode=require` por no garantizar verificación de hostname en libpq. Configure una CA de confianza mediante `BACKUP_PG_SSLROOTCERT`; libpq puede requerirla aunque Node disponga de raíces del sistema. Sólo PostgreSQL local permite `sslmode=disable`. No se admiten otros parámetros de conexión que puedan redirigir host/base. `DATABASE_SSL` de la app no controla este runner.

`PGPASSFILE` se crea con ACL/mode privados en un directorio temporal único, escapa `:` y `\`, y se retira al terminar, ante error y señales manejables. El password nunca aparece en argv de pg_tools. Los hijos reciben un entorno mínimo sin `PGPASSWORD`, `DATABASE_URL`, configuración de servicios, credenciales S3 ni llave de cifrado. Se descarta stderr de libpq para no filtrar conexiones; los errores públicos usan códigos fijos. Tras terminación forzada/crash del SO, revisar y retirar sólo temporales `pl41-pgpass-*` de ese usuario, en un host restringido. Respaldar/custodiar la llave por un canal independiente: sin ella no hay recuperación.

El destino del respaldo v1 es **local privado**. No hay uploader a un bucket de respaldo ni retención S3 implementados. Si se añade una copia externa, debe ser a bucket independiente con secretos propios; no reutilizar el bucket/credenciales fuente.

## Comandos e integración npm

Los contratos que integra el principal en `package.json` son:

| npm script | Comando |
| --- | --- |
| `backup:doctor` | `node scripts/backup.js doctor` |
| `backup:create` | `node scripts/backup.js create` |
| `backup:verify` | `node scripts/backup.js verify` |
| `backup:retain` | `node scripts/backup.js retain --apply` |
| `backup:schedule` | `node scripts/backup-runner.js schedule` |
| `restore:drill` | `node scripts/restore.js` |

Después de provisionar explícitamente configuración/secretos, la operación autorizada usa:

```text
npm run backup:doctor
npm run backup:create
npm run backup:verify -- <directorio-absoluto/pl41-uuid>
npm run restore:drill -- <directorio-absoluto/pl41-uuid>
```

`doctor` sólo comprueba Node y herramientas locales: no conecta fuente/DB/S3 ni demuestra salud del respaldo. Sin pg_tools devuelve **exit 1** con instrucción de instalación/configuración, sin JSON de éxito. `verify` autentica manifiesto, versión, árbol exacto, hashes cifrados, cada tag GCM, hashes/tamaños de texto claro y cabecera `PGDMP`; no equivale a un restore.

## Destino de restauración

`RESTORE_CONFIRM=isolated-local-drill` es obligatorio. `RESTORE_DATABASE_URL`/`RESTORE_DATABASE_URL_FILE` debe apuntar a loopback y base `fleetchile_drill_<sufijo>` ya creada, vacía y desechable, en un servidor distinto de la fuente y del servidor local de la app. No se admite destino `DATABASE_URL`, opciones URL de redirección ni servidor externo. Comprueba dirección real de servidor, versión y ausencia de otras conexiones a la DB. No crea/droppea bases desde el CLI, no usa `--clean`, `DROP` ni `TRUNCATE`.

Configure `RESTORE_S3_BUCKET` como `fleetchile-drill-<sufijo>` y resto de variables `RESTORE_S3_REGION`, `ENDPOINT`, `FORCE_PATH_STYLE`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, opcional `SESSION_TOKEN` (credenciales también `_FILE`). El bucket debe estar vacío y ser distinto del de la fuente y `S3_BUCKET` de la app; la access key debe ser distinta de las conocidas de origen/app. Autorice IAM sólo para este bucket de drill. HTTPS obligatorio salvo HTTP loopback para S3 local de drill.

Se conservan **las mismas claves** en un bucket independiente. No hay mapping de prefijos ni reescritura de claves de negocio. Se autentican y descifran **todos** los archivos en temporal privado antes de conectar a cualquier destino. Se comprueba base/bucket vacíos, se sube con `If-None-Match: *` y se relee/hash-check cada objeto. Se vuelve a comprobar base vacía, se ejecuta `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` y se validan esquema (incluye funciones/triggers/secuencias/políticas), contenido completo por tabla, cuentas/tenants, referencias, FK y revocación de efímeros. Los CHECK históricos `NOT VALID` mantienen exactamente su flag de esquema; se evalúan explícitamente contra todas las filas restauradas, sin alterar restricciones. Una violación o un tipo de constraint no validado sin procedimiento soportado bloquea el resultado verificado.

La validación fallida deja un destino de drill incompleto para inspección, sin declararlo válido y sin intentar limpiar/rehacer automáticamente. Aunque pg_restore usa transacción, la copia de S3 y la validación posterior no forman una transacción global. El operador debe desechar únicamente esos destinos aislados y provisionar otros vacíos para repetir. Los temporales de descifrado se eliminan en finally. Asegurar espacio para el dump y objetos descifrados.

## Scheduling y retención

Runner separado `scripts/backup-runner.js`; por defecto ejecuta **doctor** y sale. Para activarlo se requieren comando `schedule` **y** `BACKUP_SCHEDULE_ENABLED=yes`. `BACKUP_INTERVAL_SECONDS` predetermina 86400 (rango 3600–604800). Ejecuta un respaldo inmediato y luego espera ese intervalo desde la terminación; no solapa ejecuciones y registra fallos sin imprimir secretos. El operador debe garantizar quiescencia real para **cada** ejecución. Alternativamente, usar scheduler externo con `backup:create` dentro de una ventana controlada. No activa retención por programar respaldos.

Retención local exclusivamente opt-in:

```text
# Configurar BACKUP_RETENTION_DAYS (entero >=1), BACKUP_RETENTION_KEEP (>=1; default 1), BACKUP_ROOT y BACKUP_KEY_FILE.
npm run backup:retain
```

Autentica todos los bundles candidatos y verifica árbol/archivos antes de borrar, conserva al menos el más reciente y elimina sólo directorios propios `pl41-<uuid>` más antiguos que el plazo. Ante bundle parcial/corrupto aborta. Ignora archivos ajenos. No borra objetos fuente, no modifica DB y no purga auditoría. La llave debe permitir abrir todos los candidatos; rotación necesita plan explícito. Directorios sin READY requieren inspección manual; no se purgan como si fueran respaldos listos.

## Runner Docker opt-in (no ejecutado por esta entrega)

`deploy/Dockerfile.backup` usa `ARG PG_MAJOR=18` y `postgres:${PG_MAJOR}-alpine`, instala Node/npm, comprueba Node>=20 y dependencias sin scripts de instalación. Elija explícitamente la versión mayor fuente conocida (por ejemplo 17 si corresponde); mismatch falla cerrado. No autodetecta ni cambia la fuente.

`deploy/backup-compose.yml` es configuración de runner con perfil `backup`, comando **doctor**, filesystem de sólo lectura, tmpfs privado, volumen de backups y secretos por archivos montados en `/run/secrets`. Configure `PL41_SECRET_DIR` absoluto fuera del repo con `backup.key`, `database.url`, `source-access-key`, `source-secret-key`; sus permisos/propietario deben permitir lectura sólo al usuario de runner. Configure CA de sólo lectura si se necesita, bucket/región/endpoint y la versión `PG_MAJOR` mediante override privado. La imagen usa usuario `postgres`; validar UID de los mounts antes de activar.

```text
# Preparación por operador, nunca activación automática de producción:
docker compose -f deploy/backup-compose.yml --profile backup run --rm runner
# build.args.PG_MAJOR proviene de PG_MAJOR (default 18).
# schedule requiere override de command y BACKUP_SCHEDULE_ENABLED=yes; doctor es el default.
```

Docker/Compose no fueron necesarios para el ensayo nativo. No se ejecutó build/deploy. Para un drill Compose separado se pueden provisionar dos servicios PostgreSQL en puertos loopback distintos y un S3 local con buckets/secretos de prueba; esta entrega usa clústeres temporales y servidor S3 sintético, sin arrancar la app.

## Validación reproducible, sin fuente real

```powershell
# PGlite instalado fuera del repo; no instala ni arranca la aplicación.
$env:FLEETCHILE_TEST_PGLITE = '<ruta-absoluta-runtime-aislado>/node_modules/@electric-sql/pglite'
node --test --test-concurrency=1 tests/backup-security.test.js tests/backup-restore-isolated.test.js

# Opcional: binarios PostgreSQL reales, instalados/extraídos FUERA del repo.
$env:PL41_NATIVE_PG_BIN = '<directorio-bin-con-initdb-pg_ctl-postgres-pg_dump-pg_restore>'
$env:PL41_NATIVE_TEMP_ROOT = '<directorio-temporal-privado-de-pruebas>'
node --test tests/backup-restore-native.test.js
```

Las pruebas PGlite verifican SQL real/catálogo completo hasta migración 053, ambos tenants, hash por tabla, GPS efímero, tombstone/auditoría, adjuntos, claves derivadas, carreras/missing, fallos de stream y rechazo de manipulación **antes** de destinos. Su transporte pg_dump/restore es explícitamente simulado, no evidencia de herramientas nativas.

La prueba nativa opcional crea **dos clústeres propios** bind 127.0.0.1/trust, puertos aleatorios diferentes, nombres de DB sintéticos y key aleatoria; no lee ni utiliza la fuente de aplicación. Usa pg_dump/restore reales y S3 HTTP sintético con bytes verificables. Detiene clústeres en finally antes de borrar exclusivamente su directorio aleatorio; si no puede detenerlos conserva el temporal para revisión. Sin `PL41_NATIVE_PG_BIN` se omite expresamente; un skip no equivale a éxito nativo. No se ha validado ningún respaldo/restauración de producción.
