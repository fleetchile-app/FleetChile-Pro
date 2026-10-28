# Ubicaciones operacionales y cálculo vial

## Flujo de uso

En rutas, viajes, cargas y cargas agregadas a un viaje, los botones **Definir origen en mapa** y **Definir destino en mapa** abren el mismo selector. En el itinerario, **Registrar ubicación en mapa** permite crear una ubicación reutilizable para una parada.

1. Buscar una ubicación ya guardada en la empresa, o crear una nueva.
2. Seleccionar Chile, región, comuna y, opcionalmente, localidad.
3. Indicar nombre del establecimiento y dirección o referencia. La búsqueda externa de direcciones es opcional y requiere un proveedor configurado.
4. Marcar la entrada para camiones en el mapa o ingresar coordenadas verificadas. Seleccionar una localidad sólo acerca el mapa: NO confirma automáticamente la entrada.
5. Agregar instrucciones y cliente asociado opcional. Guardar y seleccionar.
6. Repetir para el otro extremo. Para rutas y viajes, **Calcular recorrido vial** muestra distancia, conducción, trazado y proveedor. Si el proveedor conecta un punto a más de 100 m del acceso marcado, revisar y confirmar expresamente la separación. Los puntos originales y la conexión a la vía se muestran por separado.
7. También es posible guardar una planificación con distancia pendiente mediante una opción expresa. No se genera una distancia cero ni una estimación en línea recta. Cambiar cualquier extremo invalida el cálculo anterior.

Las paradas conservan el cálculo y versionado del planificador existente. No se cambia su secuencia, reglas de carga, disponibilidad o POD. La duración vial no incluye automáticamente carga, descarga, descanso, peajes monetarios ni tráfico. El perfil genérico no certifica restricciones de peso, altura, dimensiones o acceso de vehículos pesados.

## Catálogo y procedencia

- DPA existente: SUBDERE 2023, 16 regiones / 56 provincias / 345 comunas, claves CUT. Se contrastaron los 345 códigos y relaciones provincia/comuna con la capa comunal INE CPV24-v2; no aparecieron códigos ni relaciones diferentes. Hay variantes de escritura en Paiguano/Paihuano, Coihaique/Coyhaique, Treguaco/Trehuaco y Aisén/Aysén. No se cambiaron arbitrariamente los nombres del catálogo existente.
- Localidades: **9.378 topónimos en 319 comunas**, capa `Toponimos_Localidad_CPV24`, consultada el 2026-10-27. No implica cobertura completa de localidades o sectores rurales. No contiene entradas a establecimientos.
- Descubrimiento oficial: https://www.ine.gob.cl/herramientas/portal-de-mapas/geodatos-abiertos
- Visor oficial: https://experience.arcgis.com/experience/53c18d70045b456a88b54b323bdc919f
- Servicio: https://services5.arcgis.com/hUyD8u3TeZLKPe4T/arcgis/rest/services/Censo2024_v2/FeatureServer/0
- Contraste comunal: mismo servicio, capa 11; se consultaron sólo campos geográficos, no atributos estadísticos personales.
- `INE-CPV24-TOPO-*` es una clave interna con espacio de nombres derivada del OBJECTID de esa publicación, NO un código oficial territorial de localidad. El CUT identifica la comuna.
- Se conservan fuente y versión en cada fila. La migración 044 es una instantánea versionada, no una promesa de actualización en tiempo real. Una nueva publicación debe revisarse e incorporarse mediante otra migración; nunca se borran referencias utilizadas.

Las coordenadas de topónimos sólo sirven para orientar el mapa. El acceso lo confirma una persona, y se guarda por empresa con autoría y auditoría. Se admite un punto rural sin localidad catalogada; región, comuna y punto son obligatorios. La selección territorial es declarada, no una comprobación automática contra polígonos de límites comunales.

## Proveedores y Render: pendiente de configuración

**Opción adicional incorporada:** OpenRouteService Standard. Incluye adaptadores propios de búsqueda y ruteo, presupuesto persistente y caché breve. Ver [activación y límites](OPENROUTESERVICE.md). No requiere un endpoint Nominatim/OSRM-compatible; los puntos siguientes describen las alternativas anteriores.

No se contrataron servicios, no se cambiaron variables de Render ni se probaron endpoints privados reales.

El nuevo selector rechaza los servidores públicos por defecto para la búsqueda y el cálculo comercial. El mapa, el catálogo y el registro de puntos funcionan sin geocodificación ni ruteo. No se deben sustituir hosts por alias o proxies para eludir las políticas de los servicios públicos.

- `GEOCODING_PROVIDER=nominatim`: usar un endpoint **Nominatim-compatible** propio o autorizado en `GEOCODING_BASE_URL`, con `GEOCODING_USER_AGENT` identificable. La búsqueda es por botón, nunca por cada pulsación. Devuelve hasta cinco candidatos para revisión. Si el proveedor contratado usa otra API o necesita autenticación específica, deberá añadirse su adaptador antes de utilizarlo; no basta cambiar la URL.
- `ROUTING_PROVIDER=osrm`: usar un endpoint **OSRM-compatible** propio o autorizado en `ROUTING_BASE_URL`. Si se elige otro formato/API, implementar su adaptador. El servidor existente de demostración no se habilita desde el selector nuevo.
- Se reutilizan los mosaicos y atribución de OpenStreetMap ya empleados por la aplicación. Su disponibilidad depende de conexión y de las políticas del servicio; no se implementan descargas masivas ni mapas offline.
- Los flujos heredados de geografía/ruteo conservan su contrato. Configurar estos endpoints también es necesario para sustituir los valores predeterminados que aún usan esos caminos y el itinerario.
- Políticas: https://operations.osmfoundation.org/policies/nominatim/ y https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server

## Integridad y compatibilidad

Migraciones aditivas **043** y **044**, registradas en el arranque. No ejecutarlas manualmente en producción. No reconstruyen ni geocodifican registros históricos.

El catálogo es común; las ubicaciones y cálculos son privados por empresa. Los endpoints nuevos exigen contexto empresarial autorizado y los permisos operacionales existentes, y quedan sujetos al módulo comercial `operations`. No se modificó `resolveActorContext()` ni se otorgaron permisos adicionales.

Las referencias de puntos se validan contra la empresa dentro de la transacción del registro. Un cálculo debe corresponder al mismo par y empresa; los kilómetros se toman del servidor, no del formulario. Para viajes se crea un snapshot de ruta. Auditoría fallida revierte las escrituras. Los caminos históricos de texto siguen siendo compatibles: no se impone un backfill geográfico sobre servicios anteriores.

## Aceptación pendiente en producción

1. Confirmar proveedor contratado/autorizado y formato, sin compartir claves en chats.
2. Publicar mediante el flujo autorizado GitHub → Render y comprobar migraciones.
3. Crear una ruta real con entrada a planta y bodega, comprobar mapa, instrucciones, distancia y separación de acceso.
4. Crear viaje y carga; confirmar referencias y kilometraje calculado, y probar paradas intermedias.
5. Cambiar empresa y verificar que no aparecen ubicaciones de la anterior.
6. Probar fallo de proveedor y guardar expresamente con distancia pendiente.

Las pruebas locales usan coordenadas y proveedores sintéticos salvo los datos geográficos oficiales incorporados como catálogo; no representan una distancia comercial verificada entre establecimientos reales.

## Validación local de esta entrega

- Suite completa con PGlite y Chrome habilitados: **1.385 pruebas aprobadas, cero fallos y cero omitidas** (incluida la integración ORS). La protección adicional de memoria de rutas grandes también fue verificada por separado.
- El selector se probó con Leaflet real en Chrome a 1280 y 390 px, usando mosaicos y respuestas de servicio sintéticos para que la prueba no dependa de proveedores públicos.
- La prueba SQL incluye las dos migraciones, repetición idempotente de los 9.378 topónimos, jerarquía, separación de empresas, snapshot de viaje, kilometraje tomado del servidor y rollback ante fallo de auditoría.
- `npm run check:syntax`, `npm run check:delivery` y `git diff --check`: correctos. No se inició la aplicación ni se utilizaron datos de producción.
- Esto no demuestra concurrencia multiconexión nativa ni valida un proveedor real de geocodificación/ruteo en Render.
