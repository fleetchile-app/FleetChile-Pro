# FleetChile Pro — versión funcional

Esta versión elimina por completo la conexión SII y convierte la demo en una aplicación web con backend + PostgreSQL + mapa real.

## Funciones

- Dashboard
- Mapa interactivo con Leaflet + OpenStreetMap
- Camiones y posición GPS
- Conductores
- Rutas
- Cargas
- Mantenciones
- Combustible
- Alertas
- Reportes
- API REST
- PostgreSQL persistente
- Creación y eliminación de registros desde la interfaz

Leaflet está usado para el mapa interactivo; OpenStreetMap se utiliza como fuente de tiles. Ver documentación oficial de Leaflet.

## Requisitos

Node.js 20+ y Docker Desktop.

## Arranque recomendado

1. Instala Node.js.
2. Instala Docker Desktop.
3. En esta carpeta ejecuta:

docker compose up -d

4. Instala dependencias:

npm install

5. Copia `.env.example` a `.env`.

6. Crea las tablas y datos demo:

docker exec -i $(docker ps -qf "name=fleetchile-db") psql -U postgres -d fleetchile < schema.sql

En Windows PowerShell, si el comando anterior no funciona, usa:

Get-Content schema.sql | docker exec -i <ID_DEL_CONTENEDOR> psql -U postgres -d fleetchile

7. Arranca:

npm start

8. Abre:

http://localhost:3000

## GPS real

La app ya tiene lat/lng en `trucks`. Para GPS real hay que conectar un proveedor telemático o dispositivo instalado en cada camión. El endpoint puede recibir actualizaciones posteriormente mediante una API autenticada.

## Rutas reales

La vista usa mapa real, pero el cálculo de rutas aún es una simulación de la demo. Para producción conviene conectar un motor de routing (OSRM, GraphHopper, Mapbox u otro proveedor) y guardar la ruta planificada frente a la ruta GPS real.

## Entregas

La siguiente ampliación debe incluir una app móvil del conductor con:
- inicio/fin de viaje
- checklist
- foto de carga
- foto de entrega
- firma del receptor
- ubicación
- timestamp
- incidencias
- modo offline

## Sin SII

No hay integración SII, DTE, firma electrónica ni envío tributario en este proyecto.


## Paso 2 implementado

Se agregó:
- Historial de posiciones GPS en PostgreSQL (`telemetry`).
- Endpoint `PATCH /api/trucks/:id/location`.
- Panel lateral de detalle del camión.
- Últimas posiciones y velocidad.
- Simulación de GPS para pruebas.
- Refresco automático del dashboard cada 15 segundos.
- Marcadores interactivos.
- Preparación para geocercas y proveedor telemático real.

### GPS real

El dispositivo/operador telemático deberá enviar `lat`, `lng`, `speed_kmh`, `km` y opcionalmente `status` al endpoint autenticado. En producción debe añadirse autenticación por dispositivo, rate limiting, validación de payload, TLS, auditoría y retención de históricos.

### Mapas

Leaflet es la capa de mapas. La demo usa tiles de OpenStreetMap con atribución. Para producción con una flota grande conviene contratar/usar un proveedor de tiles y routing con SLA, o infraestructura propia, respetando las políticas del proveedor.

## Versión Cloud

Para despliegue online utiliza `Dockerfile`, `render.yaml` y `README_CLOUD.md`. La base de datos se inicializa automáticamente al primer arranque.
