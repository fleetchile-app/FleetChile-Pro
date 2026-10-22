# Personas y accesos

## Alcance

Declaraciones operativas para habilitar acceso empresarial, no un sistema de recursos humanos. No se solicitan contratos escaneados, diagnósticos ni documentos médicos.

Se separan persona, cargo, rol de acceso, contrato declarado, condiciones temporales, licencia de conducir y estado efectivo del acceso. Los permisos se resuelven con las memberships existentes. El módulo no modifica `resolveActorContext()` ni convierte un administrador empresarial en administrador de plataforma.

## Reglas

- Contratos indefinidos, a plazo, por día y por evento. Los eventos tienen nombre y fechas. Inicio y término son inclusivos.
- RUT y fecha de nacimiento válidos para una cuenta nueva activa; el servidor vuelve a validar el dígito verificador.
- Solo plataforma registra una exención explícita para `company_admin`, con actor y motivo. El cambio de rol no otorga una exención. El administrador de arranque exento puede completar sus datos posteriormente.
- Permiso, licencia médica, vacaciones o suspensión restringen acceso durante sus fechas, incluso con contrato vigente y aunque el administrador esté exento de contrato.
- El fin de una condición no borra otros bloqueos. No se reactiva una cuenta desactivada ni se eliminan restricciones manuales.
- Los conductores requieren asociación y licencia de conducir vigente. Se conservan vencimiento impreso y vigencia efectiva. La renovación se declara por administración u operaciones y mantiene historial.
- El cálculo distingue las prórrogas de la [Ley 21.806, artículo 120](https://www.bcn.cl/leychile/Navegar?idNorma=1221118&idParte=10582354): vencimientos impresos de 2025 hasta el 31 de diciembre de 2026 y los de 2026 por seis meses adicionales. No se permite escribir una vigencia efectiva arbitraria.
- Las fechas civiles se calculan en el servidor, con la zona de la empresa (`America/Santiago` inicialmente), no con el reloj del teléfono.
- La evaluación de cada solicitud determina el acceso. El monitor de notificaciones no concede permisos y no es necesario para hacer efectivo un retorno por fecha.
- Las restricciones empresariales no desactivan globalmente una cuenta compartida. No se permite recuperar acceso por el fallback legacy tras desactivar una membership.

## Puesta en servicio

La migración versionada `030_personnel_access.sql` es aditiva. No inventa contratos ni exenciones para cuentas existentes.

Las empresas anteriores quedan en regularización explícita: solo los accesos anteriores al corte de la migración y sin ficha pueden conservar acceso temporal. Una ficha registrada se evalúa inmediatamente, incluso antes de activar el control general. Las nuevas altas no heredan esa excepción temporal. Las empresas creadas después comienzan con control activo.

En Personas y accesos, usar **Revisar regularización** para identificar pendientes. La activación exige completar los accesos activos y confirmar la contraseña. No activar a ciegas ni introducir contratos ficticios. El primer administrador exento se provisiona desde plataforma de forma trazable.

No ejecutar SQL manual en producción. El arranque normal aplica las migraciones versionadas; por tanto, publicar estos archivos requiere la autorización habitual de commit/push y despliegue.

## Seguridad y auditoría

Los identificadores de empresa y el actor proceden de la sesión. Las claves foráneas compuestas verifican relaciones empresariales. Cada mutación relevante mantiene evento con actor, fecha, antes/después y motivo; el historial rechaza modificaciones y borrados. La auditoría general contiene referencias, no una copia de condiciones médicas o RUT.

Una ficha borrador puede completarse y habilitarse posteriormente desde Acceso, conservando su identificador y RUT. Crear la cuenta requiere permisos de administración de cuentas y de personas, además de todos los requisitos de vigencia. Un correo global existente no se asocia automáticamente.

Operaciones dispone de una vista limitada a licencias de conductores, sin ficha laboral, RUT, nacimiento ni condiciones. Gestionar datos laborales y administrar cuentas requieren permisos separados. La exención nunca puede concederse desde un formulario empresarial.

## Validación

`npm test` y `npm run check:syntax` no necesitan una base productiva ni arrancar la aplicación.

Existe una integración opcional con PostgreSQL embebido/PGlite en `tests/personnel-postgres.integration.test.js`. Instalar ese motor fuera del repositorio y definir `FLEETCHILE_TEST_PGLITE` con la ruta absoluta del paquete para ejecutarla. Usa exclusivamente una base nueva en memoria y no lee `DATABASE_URL`. Comprueba migraciones, consultas reales, restricciones y rollback, pero no sustituye pruebas de concurrencia con varias conexiones PostgreSQL ni aceptación visual/móvil en staging.

La lista ofrece búsqueda, filtros y páginas de hasta 100 registros. Actualmente los filtros de acceso efectivo se calculan en el servidor sobre la colección empresarial; para volúmenes mucho mayores deben medirse y trasladarse a una consulta paginada sin duplicar las reglas de acceso.
