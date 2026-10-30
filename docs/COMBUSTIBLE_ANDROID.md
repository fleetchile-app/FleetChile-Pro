# Combustible del conductor y recuperación de pendientes

## Alcance

La app usa el viaje abierto y su asignación confirmada. No permite escribir manualmente otro camión ni conductor. El ingreso requiere fecha real, litros, odómetro, total en CLP, medio de pago y fotografía del comprobante. La cámara se abre desde el selector de archivo; también puede elegirse una fotografía existente.

El respaldo es obligatorio desde el conductor, incluso con efectivo, tarjeta, convenio o suministro interno. En administración sigue siendo opcional. No cambia la matriz de permisos ni habilita al conductor para consultar la economía de otros viajes.

## Confirmación

- El teléfono guarda un borrador cifrado que incluye la fotografía.
- Al enviar conserva una clave y las versiones originales de asignación e itinerario.
- El servidor confirma conjuntamente abastecimiento, origen, costo reconocido, respaldo privado y auditoría. No requiere otra aprobación.
- Un reintento con la misma clave y contenido devuelve el mismo resultado. Nunca se sustituyen versiones automáticamente para forzar un envío rechazado.
- Si falta conexión, el pendiente permanece en el teléfono. No se muestra como recibido.
- Un cambio de asignación, un viaje cerrado o un conflicto conserva el pendiente para revisión con operaciones. No se crean abastecimientos nuevos retroactivamente desde un viaje terminado.

## Entregas pendientes

«Comprobar recepción» consulta el servidor sin volver a entregar ni reabrir el viaje. Solo retira el pendiente local si existe el mismo identificador de POD cerrado con sus evidencias, o la recepción confirmada del combustible. Si no existe, conserva los datos locales e informa que operaciones debe revisar el caso. «Sincronizar» no fuerza solicitudes en conflicto.

No desinstalar la app, borrar sus datos ni cerrar sesión descartando pendientes para actualizar: estas acciones pueden eliminar los borradores. Una actualización del APK con el mismo identificador y firma conserva el almacenamiento de la app.

## Rectificaciones administrativas

En Combustible, «Rectificar abastecimiento» requiere los permisos existentes `fuel.manage` y `economics.manage`, motivo y versión vigente. Funciona para un abastecimiento imputado íntegramente a un único viaje con control económico abierto; un reparto compartido requiere revisión específica. El vehículo debe seguir coincidiendo con el viaje.

Se conserva el registro original, se revierte su asignación económica y se reemplaza su costo por el corregido. Los totales y rendimientos usan solo el abastecimiento vigente. La fotografía original conserva su objeto privado y se consulta también desde la rectificación. Actor, fecha, motivo y valores anteriores quedan trazables; no se reemplazan ni borran los originales.

## Publicación y límites

1. Publicar primero el backend con las migraciones versionadas 049 y 050 mediante el procedimiento habitual autorizado. No ejecutar SQL manual en producción.
2. Generar y actualizar el APK 0.1.2 (código 3), sin desinstalar la app anterior.
3. Validar con un teléfono real: foto, envío, consulta administrativa, corte de conexión, sincronización y rectificación.

Las pruebas locales usan PostgreSQL embebido aislado y Chrome con respuestas sintéticas y almacenamiento privado simulado. No prueban Render, Gozunga real, la cámara del teléfono ni concurrencia con conexiones PostgreSQL independientes. El APK debug no sustituye una distribución de producción firmada.

GPS permanente/en segundo plano y PL41 (respaldo/restauración) permanecen fuera de este cambio.
