# Clientes: ficha comercial y respaldo de privacidad

## Alcance

Ficha empresarial editable, identificada por ID estable y código comercial único por empresa. Nombre/razón social y RUT con dígito verificador son obligatorios en nuevas altas. Los códigos manuales admiten letras, números, punto, guion y guion bajo; si se omiten, PostgreSQL genera el código.

La migración `031_client_profiles.sql` es aditiva. Conserva IDs, relaciones con viajes/cargas y dirección anterior. Asigna códigos `CLI-LEGACY-<id>` a fichas anteriores, pero no inventa RUT, responsables, calles ni consentimientos. Al editar una ficha anterior deben completarse los datos obligatorios; una edición parcial por API no borra campos omitidos.

No se modifican el resolvedor de identidad ni las políticas RBAC. El módulo exige el permiso existente `clients.manage` y un contexto empresarial autorizado. Los datos nuevos se sirven desde `/api/company/clients`. El POST antiguo `/api/clients` utiliza la misma validación para que no sea un atajo. Los catálogos antiguos utilizados por viajes, cargas e indicadores se conservan.

## Uso

1. Clientes → Nuevo cliente: identificación, contacto/dirección y gestión comercial.
2. Seleccionar comuna del catálogo oficial; la región se obtiene de ese catálogo. Ciudad y código postal se declaran, no se geocodifican ni se inventan.
3. El responsable es opcional y se selecciona de las fichas de Personas y accesos de la misma empresa, excluyendo conductores. Si no aparece un trabajador, registrar/regularizar su ficha. Una asignación histórica se conserva hasta que se cambie explícitamente.
4. Ver ficha → Editar: indicar motivo. La versión evita que una edición antigua sobrescriba cambios concurrentes.
5. Estado Inactivo impide su elección en los catálogos operativos existentes, sin borrar servicios pasados.
6. Servicios y viajes muestra registros reales, incluyendo cargas del cliente en viajes compartidos. Último servicio usa la fecha real de término de un viaje Completado; no inventa una fecha si falta.

Segmento (minorista/mayorista) y relación (prospecto/cliente/recurrente) son conceptos independientes. Sucursal es una denominación opcional, no un nuevo catálogo de sucursales. El historial contiene actor, fecha, motivo y antes/después; los registros se protegen contra UPDATE/DELETE.

## Privacidad y archivos

El consentimiento es **informativo, nunca bloqueante**. Pendiente de respaldo, Respaldo registrado o Revocado no cambian automáticamente la condición comercial ni impiden registrar cargas o viajes.

La ficha admite un documento vigente para enviar a firma y un respaldo firmado vigente. Los reemplazos conservan versiones anteriores, actor, fecha, motivo, hash SHA-256, firmante y fecha declarada de firma. Registrar revocación conserva el archivo y requiere motivo. Registrar otro respaldo firmado establece nuevamente el estado registrado.

Se admiten archivos PDF de hasta **1 MiB**. Se valida codificación, firma de formato y cierre del archivo, tamaño y metadatos. Esto no sustituye un antivirus ni valida criptográficamente la firma. El sistema no certifica validez jurídica. El texto, finalidad, representación, conservación y procedimiento de revocación deben definirlos las partes con asesoría correspondiente.

La primera versión no envía mensajes: el operador descarga el documento, lo envía por su canal habitual y luego registra el respaldo firmado. No hay un enlace público ni un portal externo de firma.

Los bytes se guardan mediante el adaptador S3 privado existente, no en el disco efímero de Render ni en logs/auditorías. Las descargas están autenticadas y aisladas por empresa/cliente, verifican SHA-256 y se sirven como adjunto sin caché. Un rol de clientes no necesita acceso a fichas laborales para escoger un responsable.

## Configuración y verificación

La subida requiere configurar y verificar las variables S3 del adaptador existente mediante el gestor de secretos. No guardar claves en Git. Sin almacenamiento configurado, la ficha comercial sigue funcionando y la subida informa el problema, sin fingir que guardó un archivo.

No se ejecutan migraciones manuales en producción. El arranque normal incorpora la migración versionada; publicar requiere autorización independiente de commit/push y despliegue. La configuración real de S3 en Render no queda demostrada por pruebas con almacenamiento simulado.

Pruebas: `npm test` y `npm run check:syntax`. `tests/client-postgres.integration.test.js` es opcional: con `FLEETCHILE_TEST_PGLITE` apuntando a un paquete PGlite instalado fuera del repositorio, crea una base PostgreSQL/WASM nueva en memoria y no utiliza `DATABASE_URL`. No sustituye concurrencia multiconexión, un navegador real, aceptación móvil ni almacenamiento S3 real.

Ante un COMMIT de resultado incierto se conserva el objeto privado para no destruir un posible respaldo confirmado. Una política operativa de conciliación de objetos huérfanos y conservación documental debe acordarse antes de eliminaciones automáticas.
