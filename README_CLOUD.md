# FleetChile Pro — versión Cloud

Esta versión queda preparada para ejecutarse online con Node.js + PostgreSQL y para desplegarse como contenedor Docker.

## Lo que se corrigió para Cloud

- Inicialización automática de tablas al arrancar.
- Carga automática de datos demo solo cuando la base está vacía.
- Health check en `/api/health`.
- Compatibilidad del fallback SPA con Express 5.
- Configuración de producción mediante variables de entorno.
- Dockerfile para despliegue.
- `render.yaml` para un despliegue sencillo en Render.
- `docker-compose.yml` actualizado para levantar app + PostgreSQL localmente.
- PostgreSQL persistente.
- Sin integración SII.

## Despliegue en Render

1. Sube este proyecto a un repositorio privado de GitHub.
2. En Render crea un Blueprint y selecciona el repositorio.
3. Render detectará `render.yaml` y creará la aplicación y PostgreSQL.
4. Espera el primer deploy.
5. Abre la URL `https://...onrender.com` entregada por Render.

## Variables de entorno

- `DATABASE_URL`: conexión PostgreSQL.
- `PORT`: puerto HTTP, normalmente lo entrega la plataforma.
- `NODE_ENV=production`.
- `DATABASE_SSL=true` si el proveedor exige SSL para PostgreSQL.

## Desarrollo local con Docker

```bash
docker compose up --build
```

Luego abrir `http://localhost:3000`.

## Importante antes de uso comercial

La aplicación está preparada para despliegue cloud, pero antes de operar una flota real conviene agregar autenticación y roles, auditoría, rate limiting, secretos de GPS por dispositivo, copias de seguridad y proveedor de mapas/routing con SLA.
