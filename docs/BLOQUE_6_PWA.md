# Bloque 6: circuito móvil PWA

## Alcance

Implementación sobre la SPA/PWA existente, sin aplicación nativa ni permisos nuevos.
PL30, PL31 y PL34 tienen soporte de código y pruebas automatizadas; la aceptación en
teléfono real y almacenamiento privado de producción queda pendiente de ejecución.
GPS permanente, comportamiento en segundo plano, retención GPS y PL41 se dejan para
el cierre final acordado. No se modifica el seguimiento GPS actual.

## Circuito

1. Administración prepara personal, documentación, conjunto, cargas e itinerario.
2. El conductor inicia sesión con conexión y abre su viaje. Aceptar registra autor,
   asignación y confirmación; no inicia la marcha ni cambia el estado del servicio.
3. Completa el checklist con controles Conforme / Con falla y observaciones.
   Cualquier falla cierra Rechazado y genera una alerta operacional deduplicada.
   Un borrador o envío local no habilita el vehículo. Los checklist cerrados no se editan.
4. Las transiciones de estado siguen pasando por los controles existentes en línea.
   No se encolan iniciar, reanudar, completar ni cambios de contraseña.
5. En Mi recorrido registra llegada, recogidas y salida, en orden. La salida móvil
   valida documentos, personal, disponibilidad, conjunto e itinerario actuales.
6. En la parada de entrega, registra el POD de la carga correspondiente. No se
   habilita Entregar para cargas de paradas futuras. Cada POD conserva su firma y
   fotografía opcional privadas; no se introduce una obligación universal nueva
   sobre el circuito administrativo heredado.
7. Una entrega parcial declara el peso de esta ocasión, no el acumulado. Fallida,
   parcial y solicitud de reprogramación no completan la carga ni otras entregas.
   Operaciones debe revisar y versionar cualquier cambio de itinerario.
8. Incidente/demora del itinerario guarda motivo y minutos previstos; no representa
   una reparación ni sustituye una alerta crítica o la atención de una emergencia.
9. Completar continúa siendo fin del servicio, no regreso a base ni cierre económico.

## Recuperación local y límites

- IndexedDB almacena borradores y envíos cifrados AES-GCM por usuario/empresa/conductor.
  La clave es no exportable. Esto no protege de scripts maliciosos del mismo origen,
  acceso al dispositivo desbloqueado ni pérdida/evicción del almacenamiento del navegador.
- Los nuevos registros no guardan JWT, contraseñas ni respuestas completas de APIs.
  El mecanismo de token existente de la aplicación no se modifica.
- Máximo local: 100 registros y 20 MiB de contenido antes de cifrar por identidad.
  No hay eliminación automática de pendientes ni una nueva política de retención.
  Un error de cuota se muestra; no se usa un respaldo personal en texto plano.
- Borradores de checklist y POD se guardan al editar, incluyendo firma y foto ya
  preparada. Esperar el mensaje de guardado. Enviar crea una solicitud persistente.
- Foto inicial de hasta 5 MiB: se reduce a JPEG, lado máximo 1600 px y hasta
  1.200.000 caracteres de data URL. El servidor conserva sus verificaciones de
  imagen, firma (512 KiB), dimensiones y carga JSON; no se amplía el límite global.
- Los reintentos reutilizan su identificador. La API verifica identidad, empresa,
  conductor asignado, acceso laboral y versiones antes de nuevas escrituras.
  Una confirmación ya recibida puede responder idempotentemente a su misma clave.
- Sin conexión se pueden conservar formularios ya abiertos y envíos pendientes.
  No hay login offline ni descarga/caché de APIs autenticadas. Tras cerrar la PWA
  debe recuperarse conexión para validar la sesión y abrir el viaje/borrador.
- No se simulan avances encadenados offline: una llegada pendiente no habilita
  automáticamente la siguiente acción. Sincronizar y Actualizar recorrido para
  continuar con el estado confirmado. Los estados de inicio/reanudación/final son online.
- Los errores de datos o conflicto pasan a Requiere revisión y detienen los envíos
  posteriores de ese viaje. No se reescriben las versiones antiguas. Comparar con
  operaciones antes de descartar y volver a registrar una acción válida.
- Caducidad/bloqueo de sesión o red no borran los pendientes. Otra identidad no los ve.
  Cerrar sesión explícitamente advierte y permite cancelar; confirmar elimina los
  datos locales de esa identidad, no los recibidos por el servidor.
- Usar una sola ventana operativa. Web Locks serializa escrituras locales cuando está
  disponible; el backend y sus claves idempotentes son la autoridad ante concurrencia.
- El service worker guarda una versión coherente del shell estático, no APIs,
  credenciales ni evidencia. Cerrar todas las ventanas de la PWA y reabrir conectado
  para activar una actualización pendiente. No borrar datos del sitio con envíos pendientes.
- reported_at es fecha declarada por el teléfono. occurred_at/confirmed_at reflejan
  confirmación del servidor; no se presentan hechos locales como confirmados en el pasado.

## Validación Android obligatoria antes del cierre real

Usar una empresa de pruebas y registros autorizados, con tres cargas y cuatro paradas.
No usar el teléfono mientras se conduce. No aplicar SQL manual en producción.

| Caso | Resultado esperado |
| --- | --- |
| Aceptar / recargar | Aceptación visible, mismo viaje, sin iniciar automáticamente |
| Checklist conforme / falla | Todos los controles requeridos; falla crea alerta y restringe operación |
| Llegada / recogidas / salida | Orden obligatorio, no salir dejando recogidas o entregas pendientes |
| Documento vencido antes de salida | Salida rechazada, sin evento parcial confirmado |
| Tres entregas | Solo próxima parada; POD independiente, clientes/cargas correctos |
| Parcial, fallida, reprogramación | Saldo visible, otras cargas intactas, operación revisa el cambio |
| Modo avión con POD abierto | Editar receptor, firma y foto; ver guardado local; confirmar queda pendiente |
| Cerrar/reabrir sin red | Shell disponible, no autenticación offline; pendientes no se borran |
| Reconectar y validar sesión | Borrador recuperable; envío confirmado una sola vez y retirado del teléfono |
| Pérdida de respuesta después del envío | Reintento con la misma clave, un solo POD/evento/checklist |
| Reasignar o versionar con pendiente | Conflicto/revisión, no adaptar datos silenciosamente |
| Bloquear usuario con pendiente | No enviar ni borrar; revisar con administración |
| Cambiar de cuenta | Ningún dato de la identidad anterior visible ni enviado por la nueva |
| Cerrar sesión con pendientes | Advertencia; Cancelar conserva; Confirmar elimina solo los locales propios |
| Almacenamiento lleno/bloqueado | Error visible; no prometer guardado ni borrar otros pendientes |
| Evidencias administrativas | Consulta solo autorizada, archivos privados, sin claves de almacenamiento |
| Pantalla bloqueada / cambio de app | Mantener advertencia actual: no se promete GPS continuo |

## Publicación y evidencia

Migración versionada 037 integrada al runner, aditiva para acciones móviles.
Pruebas PostgreSQL en memoria con PGlite, sin conexión a la base de producción.
Las pruebas del vault usan WebCrypto real y adaptador de almacenamiento en memoria;
no sustituyen la verificación de IndexedDB, cámara, permisos y cuota en Android.
Las pruebas del POD usan almacenamiento privado simulado: confirmar S3 real por separado.
No se ha iniciado la aplicación, migrado producción, hecho commit, push o despliegue.
