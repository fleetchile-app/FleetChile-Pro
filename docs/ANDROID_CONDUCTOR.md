# FleetChile Conductor — Android inicial

## Alcance

Proyecto independiente en `mobile/driver`, identificador `cl.fleetchile.driver`.
Capacitor 8 empaqueta exclusivamente la interfaz existente del conductor: sesión,
viajes, checklist, firma, selección/captura de foto, pendientes cifrados y ubicación
con la aplicación visible. No se incluye la SPA administrativa ni código del servidor.
La interfaz conserva sus reglas y colores. Render continúa siendo el backend.

Los archivos se incluyen dentro del APK, no se carga una página remota con acceso al
puente nativo. El adaptador transforma únicamente solicitudes locales `/api/` hacia
`https://fleetchile-pro.onrender.com`; conserva Bearer, contexto, método, cuerpo y
señal de cancelación. CapacitorHttp proporciona transporte nativo sin ampliar CORS.
No se modifican RBAC, `resolveActorContext`, tablas ni políticas del servidor.

El permiso de ubicación se solicita al usarla, no al abrir la aplicación. No se
solicita permiso de ubicación en segundo plano. El seguimiento se pausa según el
ciclo ya existente: **este APK no incorpora GPS permanente**. No cambiar esta promesa
por el mero hecho de tener un paquete Android.

El almacenamiento de la app y el de la PWA son independientes: habrá que iniciar
sesión otra vez. Los borradores de la PWA no se trasladan solos; sincronizarlos
antes de cambiar. Desinstalar/borrar los datos de Android elimina pendientes locales.
Se desactivan copias automáticas y transferencias de datos para evitar trasladar
sesiones y evidencias a otras instalaciones. No se guardan claves del servidor.

## Preparación de Windows en D

Estado detectado inicialmente: SDK 37 instalado, Build-Tools 36.0.0 y Android Studio
con JBR/Java 25. El proyecto generado usa SDK 36 y Gradle 8.14.3. No se debe usar
Java 25 para este Gradle ni cambiar versiones arbitrariamente para evitar instalar
la plataforma correcta.

1. Android Studio → SDK Manager → SDK Platforms → instalar **Android 16 / API 36**.
   No necesita imagen de emulador. Mantener SDK Location en `D:\Android\Sdk`.
2. Abrir la carpeta `mobile/driver/android` como proyecto Android.
3. Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK:
   Download JDK → versión **21**, proveedor disponible, ubicación en D, por ejemplo
   `D:\Android\Jdk21`. Si se crea una subcarpeta, usar la ruta final que contiene `bin/java.exe`.
   Esto no reemplaza el JDK con que se ejecuta Android Studio.
4. Seleccionar ese JDK 21 para Gradle.

En PowerShell, usando la ruta real de JDK 21:

```powershell
Set-Location D:\flota-adm\FleetChile-Pro\mobile\driver
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:GRADLE_USER_HOME = 'D:\Android\Gradle'
$env:JAVA_HOME = 'D:\Android\Jdk21'
$env:CAPACITOR_ANDROID_STUDIO_PATH = 'D:\Android\Android Studio\bin\studio64.exe'
npm ci
npm run doctor
npm run sync
npm run open
```

Estas asignaciones son para esta terminal, no alteran globalmente otros proyectos.
No se necesita iniciar el servidor local ni ejecutar `npm start`.

## Compilar y probar

### Preparación de fuentes 0.1.3 (versionCode 4)

El proyecto existente se modifica en `mobile/driver/android` y se abre en Android
Studio con Gradle JDK `D:\Android\Jdk21` y SDK `D:\Android\Sdk`.
La allowlist móvil incorpora `public/driver-outing.js`; al preparar el HTML se carga
antes de `driver.js`, sin duplicarlo si el HTML fuente ya lo incluye. No se agrega
`operational-outings.js` administrativo ni se define un módulo `driver-return.js`:
la integración acordada del conductor utiliza `driver-outing.js`.

Esta preparación modifica solo fuentes. Esperar la señal del responsable principal
de que `public/driver-outing.js` y sus assets están listos antes de ejecutar build
web o `npm run sync`. No editar `www` ni assets Android generados a mano.
La compilación, instalación y validación en teléfono siguen pendientes de autorización.
GPS permanente y foreground service continúan aplazados.

Para verificar fuentes sin generar assets ni ejecutar el `pretest` de `npm test`:

```powershell
npm run doctor
node --test --test-skip-pattern="package uses local assets|packaged driver:" tests/*.test.js
```

Se omiten aquí las dos pruebas que dependen de `www` actualizado. Después de la
señal para regenerar assets, `npm test` vuelve a comprobar el empaquetado completo.

Verificación local del 31-10-2026: doctor aprobado con Java 21 y SDK en D;
13 pruebas de puente e iconos aprobadas (el runner informa 14 al contar también
el archivo de navegador filtrado). Las pruebas de empaquetado y navegador quedaron
excluidas deliberadamente. Allowlist, transformación del HTML, orden de carga,
ausencia de duplicados y versión Android verificados en memoria, sin generar assets.
`public/driver-outing.js` todavía no existía al realizar esta comprobación.
No se ejecutaron sync, Gradle, instalación, conexión a teléfono ni despliegue.

Tras la confirmación posterior de assets listos del responsable principal, se
ejecutaron `npm run sync` y `npm run doctor` correctamente con JDK 21 y SDK en D.
Las 15 pruebas móviles pasaron sin omisiones, incluida Chrome con API y puente
nativo simulados (login, recarga y logout); sin solicitudes reales a Render.
Además pasaron 27 pruebas de secuencia/UI y salidas operacionales, con backend
simulado y PGlite aislado en memoria; sin conexión a PostgreSQL externo.
Los 13 assets de `www` coinciden byte a byte con sus copias en Android. El HTML
fuente y ambos HTML empaquetados incluyen `driver-outing.js` una sola vez, antes
de `driver.js`. Package, lockfile y Gradle corresponden a 0.1.3 / versionCode 4.
No se ejecutaron Gradle, compilación de APK, ADB, instalación ni despliegue.

Con `doctor` correcto y teléfono autorizado, desde Android Studio usar **Run** y
seleccionar el teléfono. Alternativamente, desde `mobile/driver`:

```powershell
npm run sync
Push-Location android
try { .\gradlew.bat assembleDebug } finally { Pop-Location }
```

El APK de desarrollo estará en
`mobile/driver/android/app/build/outputs/apk/debug/app-debug.apk`.
Instalarlo y ejecutarlo requiere una acción explícita: esta implementación no lo
instala automáticamente en el teléfono ni inicia sesión en producción.
El APK debug no es una entrega comercial: la publicación requiere firma de release,
custodia externa de claves, versionCode creciente y validación de distribución.

Actualizar la web en Render no actualiza automáticamente la interfaz empaquetada.
Después de cambiar archivos del conductor se requiere `npm run sync`, recompilar
y distribuir una nueva versión. No se añaden mecanismos de actualización remota.
El proyecto móvil está excluido del contexto Docker del servidor.

## Verificación y límites

- `npm test` dentro de `mobile/driver`: pruebas de transporte, sesión existente,
  permisos, cancelación tardía de watch, configuración y empaquetado.
- La prueba Chrome se habilita con `FLEETCHILE_TEST_PLAYWRIGHT` apuntando a Playwright.
  Usa datos sintéticos e intercepta todas las solicitudes: no consulta Render.
- `npm run sync`: generación de activos y sincronización con el proyecto Android.
- `npm run doctor`: solo inspección local de SDK/JDK/caché, sin descargas ni servidor.
- Pendiente hasta disponer del entorno compatible: compilación nativa y validación
  del teléfono real (login/logout, teclado, botón atrás, firma táctil, cámara/galería,
  rechazo/revocación de ubicación, pausa/reanudación, recuperación offline y POD).
- Pruebas web o unitarias no equivalen a validación Android ni de producción.

Referencias: [CapacitorHttp](https://capacitorjs.com/docs/apis/http),
[Android de Capacitor](https://capacitorjs.com/docs/android),
[compatibilidad de Gradle y Java](https://docs.gradle.org/current/userguide/compatibility.html).

### Evidencia de esta implementación (29-10-2026)

- 11 pruebas móviles aprobadas, incluida Chrome con API/puente sintéticos; sin omisiones.
- 79 regresiones dirigidas existentes del conductor aprobadas; sin omisiones.
- Sintaxis del repositorio y comprobación estática de entrega aprobadas.
- Dependencias del proyecto móvil: `npm audit` sin vulnerabilidades reportadas en ese momento.
- Generación y `cap sync android` completados. No compilación de APK ni ejecución en teléfono.
- Doctor detectó API 36 ausente y Java 25 incompatible con el Gradle elegido.
- La suite completa se interrumpió durante esta sesión por carga del equipo; no se
  presenta como aprobada. Se completaron las regresiones dirigidas indicadas arriba.
- Sin commit, push, despliegue, migración ni cambios de datos de producción.
