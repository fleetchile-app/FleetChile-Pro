# Guías de despacho: evaluación, sin implementación

Fecha de consulta: 29-10-2026. No se modificaron formularios, esquema ni emisión tributaria.
Esta evaluación técnica no acredita cumplimiento ni reemplaza la revisión tributaria del emisor.

## Norma a considerar antes de diseñar

La Resolución Exenta SII **144, de 23-10-2026**, sustituye la 154/2025 desde su
entrada en vigor, el **01-11-2026**. Para GDT e interoperabilidad contempla plazo
hasta **01-05-2027**, con condiciones transitorias: no es una prórroga universal.
Identifica direcciones/comunas, conductor, transportista, vehículos y mercaderías.
Contempla datos diferidos, referencias al documento original, transporte tercerizado
y complemento ATT según manual técnico. Los cambios y las parcialidades tienen
reglas documentales; no basta sobrescribir una ficha de viaje.
El modelo logístico debe informarse al SII; el resolutivo 16 fija un mínimo de seis
meses y comunicación a más tardar el 31 de enero siguiente. Verificar aplicación
con el asesor tributario y la disponibilidad del aplicativo antes de implementar.

Fuente: [Resolución 144/2026, resolutivos 1–10 y 16–19](https://www.sii.cl/normativa_legislacion/resoluciones/2026/reso144.pdf).
El [comunicado del SII](https://www.sii.cl/noticias/2026/231026noti03sss.htm)
confirma el cambio y sus plazos. La [Resolución 52/2026](https://www.sii.cl/normativa_legislacion/resoluciones/2026/reso52.pdf)
había aplazado anteriormente la 154; por sí sola ya no basta para diseñar el módulo futuro.

## Qué hay en FleetChile, verificado en código

- `public/app.js` identifica el campo de carga como **Guía interna**; es referencia
  operacional, no emisión de un DTE. El nombre de un menú no constituye certificación.
- `operations-api.js` registra cargas/POD y eventos. La firma manuscrita del receptor
  acredita una operación logística: no es la firma digital tributaria del emisor.
- `driver-pdf.js` y `document-pdf.js` emiten la ficha operacional del conductor.
  Esa ficha con logo no es una representación tributaria de guía de despacho.
- Hay recursos aprovechables: clientes/RUT, empresa, conductor, patentes, remolques,
  ubicaciones, itinerarios y revisiones históricas; faltan componentes fiscales.
- No se identificó un emisor DTE propio, manejo de CAF/folios, firma XML, despacho al
  SII ni procesamiento de su respuesta en estos caminos. No se consultaron secretos
  para suplir esas funciones ni se hicieron envíos al SII.

## Viabilidad y opciones (propuesta técnica)

| Opción | Alcance futuro | Condición |
|---|---|---|
| Asociar DTE emitido externamente | Guardar XML/PDF, emisor, tipo, folio, estado y relación con carga/tramo | No presentarlo como emitido por FleetChile ni confundir carga manual con validación del SII. |
| Integrar un emisor existente | FleetChile prepara datos logísticos; el emisor autorizado procesa el DTE y devuelve documentos/estados | Definir responsabilidad por empresa, autorización, proveedor e idempotencia antes de contratar o programar. |
| Desarrollar emisor propio | Control fiscal completo | Certificación/autorización, firmantes, certificado digital, CAF/folios, TED, XML, envíos/respuestas y custodia segura por contribuyente. |

El [instructivo oficial de emisión](https://www.sii.cl/factura_electronica/factura_mercado/instructivo_emision.pdf)
describe enrolamiento, firmantes, CAF, folio único, timbre, XML y firma digital.
La [página oficial del sistema de mercado](https://www.sii.cl/factura_electronica/factura_mercado/menu_certificacion.html)
incluye certificación, timbraje, consultas y estado de envíos. Revisar formatos/XSD
vigentes y el manual ATT concreto: esta evaluación no supone que una interfaz ATT
esté disponible, ni utiliza un formato histórico como contrato definitivo.

Mi recomendación arquitectónica es separar logística de emisión fiscal, inicialmente
asociando documentos externos o integrando un emisor. No recomiendo llamar “guía de
despacho electrónica” a un PDF generado internamente sin ese circuito autorizado.
No se eligió proveedor ni se realizó contratación.

## Decisiones necesarias para una implementación posterior

1. Determinar quién emite por cada operación: dueño de la mercadería, cliente,
   transportista/intermediario; quién sólo porta o consulta el documento.
2. Seleccionar documento externo, integración o emisor propio; confirmar situación
   tributaria de cada empresa y modalidad informada al SII.
3. Modelar documentos inmutables y referencias, relación con carga, vehículo y tramo,
   cambios de conductor/equipo, parcialidades, contingencia y estados externos.
4. Definir almacenamiento privado de XML/representación, acceso del conductor sin
   conexión y retención. No guardar certificados o claves privadas en el frontend.
5. Diseñar autorización e idempotencia multiempresa y verificar aceptación/rechazo,
   reintentos, referencias y representación impresa con casos de certificación.
6. Revisar el diseño con asesor tributario y probar en ambiente autorizado antes de
   afirmar cumplimiento o habilitar emisión real.

**Resultado:** técnicamente viable, pero no está implementado ni certificado.
No hay código, migración ni emisión SII nuevos en esta entrega.
