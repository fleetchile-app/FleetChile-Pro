# Comprobante operacional de entrega

En la ficha del viaje, sección **Entrega / POD**, cada entrega cerrada ofrece
**Generar comprobante PDF**. Las descargas de firma y fotografía originales se conservan.

El comprobante incluye la identidad y el logo configurados por la empresa, viaje,
carga, cliente, receptor, observaciones y fechas disponibles. La firma se presenta
en una página de evidencias, encima de la fotografía. Las imágenes mantienen su
proporción y se normalizan únicamente para incorporarlas al PDF; los archivos
originales no se modifican.

## Interpretación de los datos

- La asignación y el plan históricos se consultan hasta la fecha de recepción.
  Si no hay historial verificable, la asignación o planificación actual se identifica
  expresamente como tal.
- La distancia planificada corresponde al viaje completo, no a una medición GPS
  real ni necesariamente al tramo de una carga.
- Se distinguen salida/llegada planificadas, salida real, recepción y finalización
  del viaje. El tiempo transcurrido no equivale a conducción exclusiva.
- Datos faltantes se indican como no registrados o no verificables.
- Una firma no se transforma automáticamente en recepción conforme sin reservas.
  Este documento no es un DTE, guía tributaria ni firma electrónica avanzada.

## Acceso e integridad

La ruta privada `GET /api/operations/trips/:id/pod/:proofId/pdf` utiliza los mismos
permisos y contexto empresarial del POD. Un conductor solo puede consultar un
viaje actualmente asociado a él. Solo se emiten entregas cerradas.

Los bytes, tamaño y SHA-256 de las evidencias se verifican antes de incluirlas.
Una evidencia registrada pero ausente, alterada o inválida impide emitir un PDF
presentado como completo. Si no hay evidencias registradas, se indica su ausencia.

Cada emisión se genera bajo demanda y deja auditoría de usuario, empresa, entrega,
identificador, versión de plantilla, identidad corporativa y SHA-256 del PDF.
El PDF no se archiva automáticamente como un nuevo objeto S3: debe conservarse
la descarga si se necesita una copia exacta de esa emisión. Se conserva el
almacenamiento privado de los originales y no se incluyen sus claves en el documento.
