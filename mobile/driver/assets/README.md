# Icono seleccionado por Marcela

Fuente entregada por el usuario: `FC.jpeg`, 1600 × 1600 píxeles.
`icon-source.png` es la conversión a PNG de 1024 × 1024, sin rediseño, recorte ni
deformación del dibujo. No se eliminó el fondo original.

`icon-preview.png` muestra máscaras circular, redondeada y cuadrada. El marco
exterior puede quedar bajo la máscara, pero se conserva el camión y las letras.
Se generan PNG normales y redondos de 48, 72, 96, 144 y 192 píxeles. La capa
adaptable mide 864 × 864; la imagen ocupa 480 × 480 en el centro (60 de 108 dp).
Fondo exterior: azul FleetChile. No se añade una interpretación monocromática
automática: se conserva el diseño multicolor elegido.

Regenerar desde el maestro incluido, con las dependencias del repositorio instaladas:

```powershell
Set-Location D:\flota-adm\FleetChile-Pro\mobile\driver
npm run icons
```

Para importar otra imagen sólo cuando se autorice reemplazarla:
`node scripts/icons.js RUTA_IMAGEN`.

El paquete conserva `cl.fleetchile.driver`; esta revisión es versión Android
0.1.1, versionCode 2. No desinstalar la aplicación para actualizar: usar el APK
debug firmado con la misma clave y `adb install -r`, conservando datos y pendientes.
Generar iconos no toca sesiones, evidencias, viajes ni Render.

Validación local: 15 pruebas aprobadas, sin omisiones; `assembleDebug` completó
con `BUILD SUCCESSFUL`. APK generado, no instalado automáticamente.
Para esta compilación se usó un directorio temporal corto en D mediante opciones
de esa ejecución de Java, después de un error local de sockets; no se modificó
el firewall ni la configuración global de Java/Windows.

[Guía oficial de iconos adaptables](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).
