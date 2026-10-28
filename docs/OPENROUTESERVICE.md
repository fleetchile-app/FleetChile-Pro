# OpenRouteService opcional (búsqueda y ruteo)

## Activación segura en Render

1. Publicar primero el código nuevo, incluyendo migraciones 043, 044 y 045, y esperar un despliegue correcto con la configuración anterior. No cambiar a un proveedor que el commit anterior todavía no reconoce.
2. Crear una cuenta Standard gratuita en https://account.heigit.org/ y obtener la API key. Confirmar las condiciones, atribución y cuotas de la cuenta. No poner la clave en GitHub, el navegador, documentos ni chats.
3. En **Render → Environment**, guardar conjuntamente:

```text
GEOCODING_PROVIDER=openrouteservice
ROUTING_PROVIDER=openrouteservice
ORS_API_KEY=<clave privada, sólo en Render>
ORS_ROUTING_PROFILE=driving-car
ORS_DIRECTIONS_DAILY_LIMIT=2000
ORS_DIRECTIONS_MINUTE_LIMIT=40
ORS_GEOCODING_DAILY_LIMIT=1000
ORS_GEOCODING_MINUTE_LIMIT=100
```

4. Guardar/reimplantar mediante el flujo normal de Render y verificar el despliegue. Las antiguas `GEOCODING_BASE_URL` y `ROUTING_BASE_URL` se ignoran al seleccionar este proveedor; no hay que apuntarlas a ORS. Nominatim y OSRM siguen disponibles como adaptadores alternativos.
5. Probar búsqueda de un establecimiento conocido, confirmar el acceso en el mapa, definir otro punto y calcular. Guardar un viaje y comprobar su distancia y fuente `openrouteservice/driving-car`. Repetir con una parada intermedia y revisar restricciones operacionalmente.

La búsqueda usa Pelias restringido a Chile (CHL), con hasta cinco candidatos; siempre exige confirmar el acceso real. El ruteo usa la API GeoJSON de ORS, no el contrato OSRM. Las llamadas se hacen únicamente desde Express.

`driving-car` conserva la planificación genérica. `driving-hgv` es una opción explícita para el perfil de vehículos pesados, pero esta entrega NO envía peso, altura ni dimensiones por equipo: no debe presentarse como certificación de aptitud para un camión concreto. No incorpora tráfico en vivo ni precios de peajes.

## Seguridad y cuotas

- La clave no se devuelve ni se guarda en la base. Ruteo usa Authorization; geocodificación usa el parámetro `api_key` server-to-server del contrato del SDK oficial. No registrar URLs completas de esas peticiones, cabeceras ni cuerpos de error del proveedor.
- Endpoint oficial fijo HTTPS y redirecciones rechazadas: la clave no se envía a un host indicado por un usuario o por las antiguas BASE_URL.
- Migración 045: un presupuesto por huella SHA-256 de credencial y servicio, compartido por los procesos que usan esta base. Bloqueo de fila y actualización transaccional; ventana local de 24 horas y minuto deslizante. No contiene ubicaciones ni datos de empresas. Reiniciar Node no reinicia el contador.
- Límites locales conservadores. El valor geocoding de 1.000/día NO afirma ser la cuota actual del proveedor: comprobar la cuenta antes de ajustarlo. Las cuotas de una misma clave son compartidas por todas las empresas y por cualquier aplicación externa que use esa clave. El contador local no conoce consumos externos ni sustituye el panel del proveedor.
- Cada intento saliente consume presupuesto aunque falle; no se reintenta automáticamente, no se rotan claves para eludir cuotas. 401/403/429 se informan sin filtrar secretos ni inventar resultados. Si no se puede verificar el presupuesto, no se realiza la llamada.
- Caché de resultados válidos en memoria: 10 minutos / máximo 100 entradas, 8 MiB serializados totales y 1 MiB por entrada (las rutas mayores se devuelven sin almacenarlas en caché), claves hash y separación por credencial/perfil. Reintentos simultáneos idénticos se unifican por proceso. Se conserva la fecha original de obtención, no se presenta el resultado reutilizado como recién calculado. No es un caché persistente ni sustituye el historial de rutas empresariales.
- No enviar nombres de trabajadores, correos, teléfonos, instrucciones privadas ni información de cargas al proveedor. Geocodificación sólo necesita el texto de ubicación; ruteo sólo coordenadas y perfil.
- Atribución visible en búsqueda, cálculo e itinerario. Fuente/fecha/perfil se conservan con el cálculo. Revisar las condiciones de licencia para la distribución de resultados.

## Referencias y alcance de pruebas

- Cuenta y condiciones: https://account.heigit.org/
- API GeoJSON: https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/requests-and-return-types
- Geocodificación: https://giscience.github.io/openrouteservice/api-reference/endpoints/geocoder/
- SDK de geocodificación: https://github.com/GIScience/openrouteservice-js/blob/main/src/OrsGeocode.js
- Cuotas: https://giscience.github.io/openrouteservice/frequently-asked-questions#when-and-how-does-my-quota-reset

Pruebas locales con HTTP simulado, PostgreSQL embebido aislado y Chrome. No se utilizó una clave real, no se contactó a la API de ORS ni se modificó Render. La comprobación real de cobertura, credencial, cuota y precisión queda pendiente tras la configuración. El SQL de bloqueo está preparado para compartir presupuesto; PGlite no demuestra concurrencia nativa multiconexión.

Resultado: regresión completa con runtimes opcionales habilitados, **1.385 aprobadas, cero fallos, cero omitidas**. Se ejecutaron además las 11 pruebas específicas ORS después de añadir la protección de memoria para rutas grandes. Sintaxis, entrega estática y comprobación de espacios Git correctas. Sin commit, push, arranque de aplicación ni migraciones de producción por el asistente.
