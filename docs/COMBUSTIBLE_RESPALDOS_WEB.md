# Combustible y respaldos - etapa web

## Registrar y valorar

1. En **Combustible**, selecciona **Registrar abastecimiento**.
2. Selecciona el vehículo de la empresa e ingresa fecha, litros y odómetro.
3. Distingue proveedor externo o abastecimiento interno, y el medio de pago:
   contado, tarjeta, convenio o suministro interno. Referencia y proveedor son opcionales.
4. Si el precio no está disponible, marca **Precio pendiente de valoración**.
   Se guardan precio e importe nulos, no un gasto cero.
5. Después puedes agregar una referencia, fotografía PNG/JPEG o PDF de hasta 5 MiB.
   Los adjuntos no son requisito para registrar el abastecimiento.
6. **Completar valoración** requiere precio y motivo, conserva autoría y controla
   la versión para evitar sobrescribir otro cambio. El importe nuevo se calcula
   en CLP y se redondea al peso; no se recalculan registros históricos automáticamente.

Una carga pendiente no se ofrece como origen económico. Al completarla, se puede
vincular desde **Viaje > Control económico > Vincular abastecimiento existente**.
Si ya tiene un origen económico, no se permite modificar silenciosamente su importe.
La asignación posterior puede distribuir ese origen entre viajes sin exceder el saldo.
Desde **Viaje > Control económico > Registrar abastecimiento en este viaje**,
el sistema registra abastecimiento, origen, costo e imputación en una transacción.
El camión debe corresponder al viaje y el precio debe conocerse. Si el cierre está
cerrado o falla la auditoría, no se guarda una parte del proceso.
Desde **Registrar comprobante TAG / peaje**, el comprobante también se imputa
al viaje actual en el mismo guardado. No repitas un gasto ya registrado manualmente.

## Registro administrativo sin aprobación adicional

Los nuevos gastos reales de combustible y peajes (no presupuestos), ingresados
con `economics.manage`, quedan reconocidos al guardar. Para conservar compatibilidad
con reportes y cierre se usa el estado técnico `reconciled`, registrando responsable,
fecha y razón de registro directo: no representa cotejo con un comprobante ni bancario.
No se exige adjunto. El ingreso de otras categorías conserva su autorización anterior.
Un abastecimiento independiente de un viaje no crea por sí solo costos de viajes.

Los gastos manuales también aparecen en la sección de combustible/peajes, sin
inventar un origen operativo ni duplicar importes. Los registros históricos no se
aprueban masivamente: para regularizar un borrador se crea una nueva versión.

**Corregir gasto / registrar existente** requiere motivo y la versión vigente,
conserva el importe anterior, autor y respaldos. **Historial y respaldos anteriores**
permite consultarlos. Un formulario obsoleto se rechaza. Los orígenes económicos ya
distribuidos conservan sus restricciones de integridad: no se cambia silenciosamente
el importe original ni se libera saldo como efecto secundario de una corrección.

## Costos y respaldos

### Ingreso unificado y gastos anteriores

En **Economía > Nuevo costo**, seleccionar combustible real abre el formulario
de abastecimiento del viaje. Combustible presupuestado permanece como presupuesto.
El vehículo del viaje debe estar asignado; no se inventan litros, kilometraje ni precios.

Un gasto manual anterior ofrece **Completar abastecimiento** en Economía y en
Control económico. Conserva el mismo costo, importe y versión, exige fecha real,
litros y odómetro, permite confirmar el camión de la empresa y calcula el precio
unitario como importe existente dividido por litros declarados. No es un precio
extraído automáticamente del comprobante. El reconocimiento de un borrador se
registra con autor y auditoría, sin aprobar masivamente otros registros históricos.

Se rechazan presupuestos, importes cero, anulados, autorizaciones pendientes,
versiones obsoletas, cierres económicos y costos con origen/historial de asignación.
La operación es transaccional: no duplica costos ni deja abastecimientos parciales.
Un reintento después del éxito se rechaza como ya vinculado.

La migración **047_fuel_support_links.sql** crea una vista de relaciones de respaldo:
los archivos originales no se mueven, duplican ni cambian sus metadatos. Los adjuntos
del costo son consultables desde el abastecimiento vinculado y viceversa, sujetos a
los permisos de cada módulo y a la empresa autorizada. Las pantallas muestran los
adjuntos reales, no la antigua declaración `support_status`. Combustible muestra el
viaje vinculado. Las fotografías de versiones anteriores son accesibles desde el
abastecimiento mientras el vínculo esté activo y desde el historial del costo.

No se convierten automáticamente costos históricos: faltan datos físicos que
debe declarar el operador. No hay SQL manual ni cambios de datos en producción.

- **Presupuestado:** importe previsto, no gasto ejecutado.
- **Gasto registrado:** gasto ocurrido.
- **Imputado al viaje:** parte de un gasto atribuida al servicio.

En Economía y Control económico, **Ver / agregar respaldos** permite consultar y
agregar archivos o referencias. Los respaldos del costo quedan asociados a la versión
correspondiente. Una versión anterior o un cierre económico no admite nuevas
evidencias por ese camino; primero debe revisarse el flujo de versión/reapertura.

El origen de combustible permite consultar los archivos y referencias de la carga
original sin volver a subirlos. Una declaración histórica «documentado» no prueba
que exista un archivo. Agregar un respaldo no aprueba ni concilia un costo.

## Seguridad y publicación

La migración aditiva **046_fuel_financial_support.sql** está registrada en el runner
normal. No requiere ejecutar SQL manual en producción. Debe revisarse y publicarse
mediante el procedimiento habitual; las pruebas locales usan una base aislada.

No se modifican roles, ROOT/OWNER ni la resolución del actor. Se reutilizan
`fuel.manage`, `economics.read` y `economics.manage`, con contexto empresarial.
Archivos privados usan el almacenamiento S3 configurado; cada acceso se audita y
las descargas verifican tamaño y SHA-256. No se publican URLs ni claves de objetos.
Los archivos se descargan como adjuntos, no se ejecutan o muestran como HTML.
Se incluyen metadatos y adjuntos en la exportación empresarial.

La aplicación Android, sus permisos y su paquete no cambian en esta etapa, de acuerdo
con el despliegue separado solicitado. La siguiente etapa debe exigir foto del
comprobante al conductor, cualquiera sea el medio de pago, vincularlo al viaje y
mostrarlo en administración sin aprobación adicional. Se implementará después de
validar la versión web; ese flujo móvil todavía no está disponible.
