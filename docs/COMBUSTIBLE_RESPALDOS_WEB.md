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
vincular desde **Viaje > Control económico > Registrar origen combustible**.
Si ya tiene un origen económico, no se permite modificar silenciosamente su importe.
La asignación posterior puede distribuir ese origen entre viajes sin exceder el saldo.
Registrar combustible no crea automáticamente otro costo manual del viaje.

## Costos y respaldos

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

La aplicación Android, sus permisos y su paquete no cambian en esta etapa. El
registro móvil de combustible se implementará después de validar la versión web.
