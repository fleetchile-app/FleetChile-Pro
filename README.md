# FleetChile Pro — versión funcional

FleetChile Pro es una aplicación web de gestión de flota con backend Node.js/Express, PostgreSQL persistente y mapa operacional con Leaflet/OpenStreetMap. No incluye integración con SII.

## Funciones actuales

- Dashboard operacional
- Empresas y usuarios con roles/permisos
- Camiones y posición GPS
- Conductores
- Clientes
- Rutas
- Viajes operacionales
- Cargas asociadas a viajes
- Despacho y asignación de recursos
- Estados e historial de estados de viajes
- Eventos operacionales
- Checklist preoperacional
- Entregas/POD
- Documentos y vencimientos
- Mantenciones
- Combustible
- Alertas
- Auditoría
- Panel de administración
- API REST
- PostgreSQL persistente

## Arquitectura operacional canónica

`trips` es el agregado operacional principal de un viaje.

- `trips.status`: estado actual del viaje.
- `trip_status_history`: historial canónico de transiciones de estado.
- `trip_events`: línea de tiempo de eventos operacionales; no reemplaza el historial de estados.
- `trip_loads`: modelo canónico de cargas pertenecientes a un viaje.
- `trip_delivery_proofs`: evidencias/POD asociadas al viaje y opcionalmente a una carga.
- `vehicle_checklists`: checklist asociado al vehículo, conductor y opcionalmente al viaje.
- `routes`: recurso de ruta planificada que puede ser asociado a un viaje mediante `trips.route_id`.
- `telemetry`: historial de posiciones de vehículos; `trip_id` es opcional hasta que una posición se asocie explícitamente a un viaje.

### Estructuras legacy

La tabla `loads` original se mantiene por compatibilidad con la interfaz histórica. Para la operación de viajes nuevos, el modelo de referencia es `trip_loads`.

Los campos de texto históricos de `routes`/`loads` no se eliminan todavía porque existe código de compatibilidad. Una futura migración deberá verificar todas las dependencias antes de retirar el modelo legacy.

## Aislamiento por empresa

Las entidades operacionales pertenecen a una empresa mediante `company_id` cuando corresponde. Las APIs autenticadas aplican el contexto de empresa para usuarios no administradores. Los administradores pueden operar transversalmente sobre empresas desde las funciones administrativas autorizadas.

La migración `007_preflight_integrity.sql` prepara restricciones e índices sin realizar una migración destructiva. Las restricciones `NOT VALID` preservan datos históricos mientras obligan a que nuevos registros respeten las reglas.

## Autenticación

Las contraseñas utilizan scrypt y las sesiones se almacenan mediante un hash SHA-256 del token. Las rutas de administración de usuarios y roles requieren autenticación y el permiso correspondiente.

La seguridad de producción completa —rotación avanzada de sesiones, rate limiting, autenticación de dispositivos GPS, almacenamiento seguro de evidencias, políticas de backup y controles adicionales— pertenece a la Fase 6.

## Base de datos y migraciones

La aplicación inicializa `schema.sql` y posteriormente ejecuta, en orden:

- `003_auth_rbac.sql`
- `004_operations.sql`
- `005_trip_links.sql`
- `006_admin_settings.sql`
- `007_preflight_integrity.sql`

`002_core_platform.sql` se aplica como fundamento de la plataforma antes de las migraciones anteriores.

## Requisitos

Node.js 20+ y PostgreSQL. Para desarrollo local también se puede utilizar Docker Desktop.

## Arranque local

1. Instala Node.js.
2. Instala Docker Desktop si utilizarás el entorno Docker.
3. Ejecuta `docker compose up -d`.
4. Ejecuta `npm install`.
5. Copia `.env.example` a `.env` y configura `DATABASE_URL`.
6. Ejecuta `npm start`.
7. Abre `http://localhost:3000`.

## GPS real

La aplicación ya almacena latitud, longitud, velocidad y kilometraje en `telemetry`. Para integrar un proveedor telemático real se necesita un endpoint autenticado para dispositivos, validación de payload, rate limiting, auditoría y política de retención. Esas tareas pertenecen a la Fase 3/6 y no forman parte del saneamiento pre-Fase 3.

La demo utiliza Leaflet y OpenStreetMap. El cálculo de rutas reales todavía requiere un motor de routing/proveedor externo.

## Entregas / PWA

La estructura de POD ya contempla receptor, RUT, fecha/hora, firma, fotografía y coordenadas. La futura PWA del conductor agregará captura móvil, modo offline, GPS y evidencia real sin reemplazar el modelo operacional actual.

## Sin SII

No hay integración SII, DTE, firma electrónica ni envío tributario en este proyecto.
