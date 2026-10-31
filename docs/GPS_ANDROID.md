# GPS nativo Android — Driver 0.1.4 (code 5)

Implementación: Capacitor 8 / SDK 36, plugin propio `FleetTracking`,
`LocationForegroundService` y `LocationManager`. Sin bibliotecas nuevas de GPS.

## Inicio y ciclo de vida

```js
await window.FleetTracking.start({ tripId, token: window.Auth.token });
await window.FleetTracking.status();
await window.FleetTracking.stop();
```

`FleetNative.backgroundGps` es `true` sólo si Android registra el plugin.
El navegador conserva el fallback existente. La UI debe invocar start después de
aceptación, checklist y consentimiento; Android muestra además su propio diálogo.
Se requiere Activity RESUMED al consentir y al lanzar el servicio. Se solicitan
COARSE/FINE y POST_NOTIFICATIONS en runtime. La ubicación aproximada usa el
proveedor de red disponible; no se pide ACCESS_BACKGROUND_LOCATION.

El FGS se declara de tipo `location`, muestra una notificación ongoing con acción
Detener y ejecuta captura y HTTPS en Java, independientemente de WebView/JS. Un
wake lock parcial con timeout renovado durante la vida del servicio mantiene el
procesamiento con pantalla apagada. `waiting` y `returning` mantienen el GPS: un
servicio completado no equivale a una salida cerrada.

La navegación o recarga de WebView no detiene el FGS. La UI debe consultar status
para recuperar su estado sin duplicar start. STOP explícito, logout, cambio de
actor/sesión/recurso deben llamar stop; no se debe detener por simple remount.
Antes de iniciar otra identidad, esperar la resolución de stop. Un inicio que
espera consentimiento/permisos queda invalidado si ocurre stop/logout.

No hay receptor de boot, alarmas, reinicio automático ni START_STICKY. Tras muerte
del proceso se necesita actividad visible y nuevo consentimiento; los puntos
anteriores quedan para revisión. No se promete continuidad tras force-stop,
restricciones OEM ni eliminación del servicio por Android. Denegar notificaciones
puede ocultar la notificación del panel según las reglas de Android; se solicita
el permiso y la acción Detener también sigue disponible desde la app.

## Contrato HTTP

Origen fijo: `https://fleetchile-pro.onrender.com`. Sólo se construyen estas rutas:

- POST `/api/driver/trips/:id/tracking`, body `{}`.
- GET `/api/driver/trips/:id/tracking/context?tracking_session_id=<UUID>`.
- POST `/api/driver/trips/:id/tracking/positions`.

Bearer estándar, sin cambios de políticas. Redirecciones deshabilitadas
(`setInstanceFollowRedirects(false)`); timeout conexión 15 s, lectura 20 s,
respuesta limitada a 256 KiB. Reintentos exponenciales con jitter, máximo 5 min.

Contexto directo (o envuelto en `context`): `tracking_session_id`, `user_id`, `trip_id`,
`company_id`, `driver_id`, `truck_id`, `resource_version`, `itinerary_version`,
`outing_id`, `state`, `session_started_at`, `phase_since`, `expires_at`,
`interval_seconds`, `review_required`.
Los estados autorizados son active/waiting/returning. Se valida la identidad
completa y se consulta contexto antes de cada batch, aunque haya cola offline.
Única excepción de identidad: el primer vínculo outing_id null → entero positivo
proveniente del contexto HTTPS autorizado, manteniendo UUID, usuario, viaje,
empresa, conductor, camión, versiones e inicio/expiración idénticos. Se persiste
el vínculo; cada punto conserva internamente el outing original para revisión.
No se admite outing1 → outing2 ni la eliminación de un outing ya fijado.
El intervalo configura captura y envío, limitado a 15–300 s (default 30 s).
Además del intervalo de LocationManager se aplica un throttle monotónico entre
proveedores; se rechazan fixes duplicados, viejos, futuros o anteriores a la
sesión. La señal se actualiza por separado aunque un fix no genere otro punto.

```json
{
  "tracking_session_id": "UUID",
  "resource_version": 1,
  "positions": [{
    "client_position_id": "UUID",
    "captured_at": "2026-10-31T12:00:00Z",
    "state": "active",
    "lat": -33.45,
    "lng": -70.66,
    "accuracy_m": 10,
    "speed_kmh": 0
  }]
}
```

Las coordenadas del ejemplo sólo ilustran el formato. Cada punto recibe UUID y
fase inmutable al capturarse. Cada batch contiene hasta 50 puntos de una misma
fase; recuperar contexto no reinterpreta posiciones offline. `speed_kmh` es
opcional. Respuesta: `{accepted_ids:[UUID],context:{...}}`; sólo se retiran IDs
enviados y reconocidos. Si se pierde el acuse se reenvían los mismos UUID.
Al reconectar se prioriza el punto más reciente de la fase actual, seguido por
hasta 49 antiguos de esa misma fase sin duplicar IDs. Si no hay puntos de la fase
actual, se procesa una fase pendiente por separado. Con más de 50 pendientes se
puede enviar cada 5 s; la frecuencia de captura no aumenta. Nunca se alteran
timestamps ni identidad para acelerar el mapa o el backfill.

401/403/404 y 409 de identidad/conflicto, contexto cerrado, revisión requerida, expiración o cambio de scope
detienen captura y envío y conservan pendientes cifrados para revisión. No se
extiende `expires_at` ni la política de autenticación; se muestra en status y en
la notificación. Un 409 `POSITION_PHASE_REVIEW` mueve sólo el batch rechazado a
revisión y consulta contexto vigente antes de continuar el FGS; nunca reinterpreta
sus puntos. Lo mismo ocurre con 400 explícitos `INVALID_POSITION`,
`INVALID_CAPTURE_TIME`, `INVALID_PHASE` e `INVALID_BATCH`, cuyo contrato garantiza
rechazo atómico total. Otros errores no borran ni ponen lotes en cuarentena por
suposición. El resto de la cola conserva su identidad y fase.

## Persistencia y estado

Token, contexto y puntos se guardan juntos mediante AtomicFile en
`getNoBackupFilesDir()/fleet-tracking.enc`, cifrados AES-GCM con clave no exportable
de AndroidKeyStore y nonce nuevo por escritura. No hay token en SharedPreferences,
extras de Intent ni logs de cuerpo/credenciales. Backup Android deshabilitado y
logging de Capacitor ya configurado como none.

Cola activa y revisión comparten límite de 10.000 puntos y retención de 24 h.
Al escribir se eliminan vencidos y exceso; status filtra esos límites en memoria
sin modificar el archivo. Si el proceso está detenido, la depuración física ocurre
en la siguiente escritura. Se conservan los más recientes,
priorizando cola activa. stop elimina el token persistido y mueve pendientes a
revisión con su scope original; un nuevo start nunca los adopta. No hay borrado
por navegación ni migración automática durante renovación de autenticación.

status devuelve `running`, `state`, `signal`, `pending`, `reviewPending`, `reason`,
`lastFixAt`, `tripId`, `context`, `expiresAt`; nunca devuelve el token ni posiciones.
Con el servicio detenido, tripId/context/expiración son null; los contadores de
revisión no exponen objetos personales. Para adoptar un servicio tras reload, la
UI compara user_id y verifica GET del UUID exacto con el Bearer de Auth actual.
`signal` indica un fix reciente, no conectividad confirmada con el servidor.

## Verificación local autorizada

```powershell
cd D:\flota-adm\FleetChile-Pro\mobile\driver
npm test
# Sólo después de que el worker UI termine public/driver-tracking.js:
npx cap sync android
$env:JAVA_HOME='D:/Android/Jdk21'
$env:ANDROID_HOME='D:/Android/Sdk'
$env:ANDROID_SDK_ROOT='D:/Android/Sdk'
$env:GRADLE_USER_HOME='D:/Android/Gradle'
# Workaround local para socket temporal del JDK en este equipo:
$env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true -Djdk.net.unixdomain.tmpdir=D:/Android/Temp'
cd android
./gradlew.bat :app:assembleDebug :app:testDebugUnitTest --no-daemon --max-workers=2 --console=plain
```

Las pruebas JVM cubren políticas de continuidad, identidad, retención, backoff y
cifrado autenticado. Las pruebas JS cubren disponibilidad y delegación del puente.
Compilar y pasar pruebas locales no valida AndroidKeyStore real, permisos,
pantalla apagada, restricciones OEM ni integración de red en un dispositivo.
No se autorizaron ADB, instalación, teléfono, producción, deploy ni commits.

Referencias Android:
[FGS location](https://developer.android.com/develop/background-work/services/fgs/service-types#location)
y [restricciones de inicio](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
