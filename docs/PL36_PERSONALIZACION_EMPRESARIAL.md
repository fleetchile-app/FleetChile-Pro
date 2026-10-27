# PL36: identidad empresarial y documentos

## Uso

- Administrador empresarial: **Mi empresa → Personalización**.
- Plataforma: seleccionar la empresa en el encabezado y abrir
  **Plataforma → Personalización de empresa**. Sin empresa seleccionada no se edita.
- Configurar nombre visible, logo, combinación de colores y contacto operativo.
  La previsualización no cambia la interfaz antes de guardar.
- Indicar el motivo y guardar. El restablecimiento crea otra revisión, no elimina historia.
- En **Conductores → Ficha**: emitir el PDF o consultar **Documentos emitidos**
  para descargar exactamente una emisión anterior.

La identidad legal, RUT, licencia, módulos comerciales y permisos no se editan aquí.
El contacto operativo es independiente del correo/teléfono contractual de plataforma.
Se conserva la estructura visual actual. Las paletas permitidas usan texto blanco
sobre colores oscuros; no se admite CSS ni colores arbitrarios del usuario.

## Seguridad e integridad

La empresa se resuelve desde la sesión/contexto autorizado, nunca desde el formulario.
Consultar identidad requiere sesión empresarial; editar utiliza los permisos existentes
de administración empresarial o de empresas de plataforma, sin modificar RBAC.
Los logos no tienen URL pública: se entregan dentro de una respuesta autenticada no
cacheable. Se validan por decodificación real con sharp (ya dependiente del proyecto),
se rechazan SVG, animaciones, más de 1 MiB o 16 millones de píxeles; se eliminan
metadatos, se limita a 600×240 y se guarda JPEG normalizado sobre blanco.

Las revisiones por empresa son inmutables; el guardado bloquea la empresa, comprueba
la versión esperada y registra autor, fecha, motivo y cambios en la misma transacción.
Una ficha antigua no sobrescribe cambios recientes; un fallo de auditoría revierte todo.
Los blobs no se duplican en los logs de auditoría: se registra su hash.

## PDF

El generador común utiliza A4, encabezado con identidad y logo del propietario,
secciones destacadas, márgenes, fechas UTC, identificador único, versión de plantilla,
versión de identidad, contacto y numeración de páginas. Mantiene tildes y ñ.
Actualmente el PDF generado es la ficha operacional de conductor. Los consentimientos
subidos por clientes no se transforman, ni los CSV se presentan como PDF.

Cada emisión guarda los bytes completos del PDF, identidad de origen, plantilla,
autor, fecha y SHA-256. La consulta histórica exige los permisos actuales y la misma
empresa/conductor. Cambiar logo, datos o plantilla no altera documentos emitidos.
Los PDF descargados antes de esta funcionalidad no se importan retroactivamente.

Los logos pequeños y PDF se guardan en PostgreSQL con la migración 039; no requieren
configuración S3 nueva ni archivos persistentes de Render. Su volumen forma parte de
la base y debe contemplarse al abordar retención, portabilidad y PL41, aún aplazado.

La cabecera de la PWA usa la identidad autenticada. El nombre e icono de instalación
siguen siendo FleetChile; no se promete un seguimiento GPS distinto ni personalización
de la pantalla pública anterior al login. El service worker renueva el shell sin cachear
logos, API, documentos ni credenciales.

## Verificación

Pruebas de validación de imágenes, permisos, aislamiento, conflicto de versiones,
rollback por auditoría e inmutabilidad sobre PostgreSQL aislado (PGlite).
La prueba opcional de navegador usa `FLEETCHILE_TEST_PLAYWRIGHT` para el runtime
Playwright local y Chrome instalado; no inicia la app ni conecta a producción.
`node scripts/review-company-branding.js` genera un PDF ficticio en un directorio
temporal para inspección visual con Poppler.

Pendiente de aceptación en Render: guardar una identidad real autorizada, verificarla
desde dos empresas y desde el teléfono, emitir/recuperar PDF y comprobar aislamiento.
Esto no completa PL37, PL39–PL46, ni autoriza commit, push o migraciones en producción.
