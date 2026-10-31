# Eliminación de una empresa

## Acceso y confirmación

Plataforma → Eliminar empresa. Solo ROOT/OWNER activos o un `platform_superadmin` con el permiso existente `platform.companies.manage`, en contexto global. No se conceden permisos nuevos. Soporte y administradores empresariales no pueden acceder, tampoco por API directa.

Seleccionar empresa por ID, nombre y RUT; generar confirmación; teclear contraseña actual y cinco palabras aleatorias, indicar motivo y reconocer la irreversibilidad. La frase dura cinco minutos, está ligada a la empresa, al usuario y a la sesión, y se consume en cada intento. Generar otra invalida la anterior. Hay un máximo de diez confirmaciones por usuario y hora. La base guarda solo hashes de frase y sesión; nunca guarda la contraseña ni la frase legible.

La interfaz rechaza pegado, arrastre y autocompletado de los campos de confirmación, y comprueba entrada manual. Esto es una protección de interfaz, no una prueba criptográfica de que una persona tecleó: el servidor siempre verifica contraseña, frase, sesión y autoridad. Una aplicación web no puede controlar universalmente todas las extensiones o gestores de contraseñas del dispositivo.

## Alcance

- Datos operacionales, documentos registrados, personal, configuración, licencias, registros económicos y auditoría propia de la empresa.
- La empresa se elimina en la misma transacción, sin tocar catálogos globales, roles generales ni otras empresas.
- Las cuentas exclusivas quedan inactivas, sin contraseña ni sesiones y con nombre, correo y teléfono anonimizados. Se conserva su ID técnico para no romper auditorías globales. Las cuentas compartidas, de plataforma y ROOT/OWNER se preservan.
- Queda una auditoría global de actor, motivo, empresa, conteos y trabajo de limpieza. No incluye contraseña, frase ni credenciales de almacenamiento.

El motor obtiene dependencias de las claves foráneas. Una referencia a otra empresa o a una dependencia global no autorizada bloquea la operación. Las tablas sin empresa solo se recorren si están expresamente autorizadas; ampliaciones del esquema deben revisar esa lista.

Después del primer vaciado confirmado, el arranque deja de ejecutar las semillas de demostración y de recrear la empresa demo. El esquema y las migraciones siguen inicializándose normalmente. La instalación inicial sin trabajos de eliminación conserva el comportamiento de bootstrap existente.

## Mantenimiento y atomicidad

Esta función es administrativa y de mantenimiento, no una operación cotidiana. Toma bloqueos de escritura sobre las tablas públicas y, dentro de esa transacción, deshabilita temporalmente disparadores de usuario en las tablas afectadas para poder borrar históricos inmutables. Las claves foráneas y restricciones de PostgreSQL siguen activas. Los disparadores recuperan su estado exacto antes del commit. Un fallo, auditoría fallida o desconexión revierte datos y cambios de disparadores. No usa `TRUNCATE`, `DROP`, `CASCADE` de esquema ni `session_replication_role`.

Debe ejecutarse fuera de actividad. Hay cinco segundos de espera por bloqueo y treinta segundos por sentencia; si la base está ocupada puede cancelarse sin eliminar. Esta implementación no demuestra concurrencia con conexiones PostgreSQL independientes ni garantiza duración para volúmenes grandes. Exige que la conexión tenga propiedad suficiente sobre las tablas; no solicita privilegios adicionales si falla.

## Archivos privados

Antes de vaciar se registra una cola durable de las claves `storage_key` registradas, restringidas al prefijo exacto `companies/<id>/`. Después del commit se eliminan los objetos por lotes de hasta 25. La interfaz muestra «limpieza pendiente» hasta terminar; los fallos permiten reintentar sin repetir el vaciado. Nunca se borra el bucket ni el prefijo de otra empresa.

No se eliminan URLs externas, objetos huérfanos sin metadatos registrados ni respaldos externos. Tampoco se garantiza el borrado físico de versiones o copias retenidas por Gozunga/S3. Esas políticas deben revisarse con el proveedor antes de usar esta función como garantía de supresión de datos personales.

No existe recuperación incorporada. PL41 sigue fuera de este cambio. No ejecutar sobre una empresa real sin revisar previamente su alcance y las políticas de conservación.

## Verificación

Pruebas aisladas con PostgreSQL embebido, cuentas sintéticas y almacenamiento simulado; ninguna eliminación de una empresa real ni de archivos de Gozunga. Antes de producción: revisión humana, publicación autorizada de la migración 051 y validación en una empresa sintética de staging.

El catálogo devuelve explícitamente `text[]`: `node-postgres` deja `name[]` como texto, a diferencia del motor embebido. La regresión reproduce los parsers reales del controlador sobre los OID del resultado. Los tipos inesperados bloquean el vaciado antes de escribir. Esta prueba no sustituye una conexión PostgreSQL nativa ni valida Render.

El selector de contexto ofrece únicamente empresas habilitadas y conserva la selección previa si el servidor rechaza un cambio. Una empresa inactiva sigue siendo administrable y eliminable: inactivar no equivale a eliminar. El historial de esta sección contiene eliminaciones confirmadas, no intentos fallidos; un fallo transaccional no debe inventar un registro de éxito.
