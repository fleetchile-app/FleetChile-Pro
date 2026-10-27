# Cierre empresarial: PL37, PL39 y PL40

## Roles propios de empresa (PL37)

**Mi empresa → Roles de empresa** permite crear perfiles, seleccionar permisos y
asignarlos a accesos existentes. El cargo laboral sigue en Personas y accesos y no
concede permisos. Se conserva el catálogo global y el rol técnico original.

Un perfil pertenece exclusivamente a una empresa y solo puede reducir los permisos
de Operaciones, Gerente, Mantención, Conductor, Consulta o Administrativo. No crea
administradores empresariales, de plataforma ni propietarios. Cada solicitud vuelve
a calcular los permisos efectivos, intersectando el perfil activo con su rol base.
Desactivar un perfil deja sus accesos sin permisos; no los devuelve silenciosamente al
rol completo. Quitar el perfil sí restaura el rol base y exige confirmación y motivo.

El perfil no altera contratos, condiciones, licencia de conducir, asociación de
conductor o licencia comercial. Cambiar el rol técnico desde Personas y accesos
retira el perfil anterior para impedir aplicar un perfil de otra especialidad.
No se modifica el propio acceso ni el de administradores o identidades protegidas.
Versiones y marcas temporales impiden sobrescrituras; eventos inmutables conservan
autor, nombre, fecha, motivo y estados antes/después. ROOT/OWNER y
`resolveActorContext()` no se modifican.

## Soporte acotado (PL39)

Plataforma crea la cuenta con rol **Soporte acotado**. Este rol no recibe permisos
globales de empresas/usuarios ni ownership. Un administrador con gestión de usuarios
y empresas (o propietario) autoriza desde **Plataforma → Soporte acotado**:

- Empresa identificada y cuenta de soporte activa.
- Funciones: Personas y accesos, Personalización, Perfiles o Importación.
- Vencimiento expreso de hasta 30 días y motivo.

El técnico solo ve sus empresas autorizadas y debe abrir un caso con motivo para
operar. El caso dura hasta dos horas o hasta vencer su autorización, lo que ocurra
antes. La autorización puede revocarse; cada petición vuelve a comprobar caso,
empresa, funciones y vigencia. Cada intento autorizado queda auditado sin copiar
contraseñas, cuerpos completos ni datos de salud al log general.

Los endpoints ajenos a esos módulos se rechazan aunque se invoquen directamente.
No hay acceso a facturación, licencias comerciales, propietarios, archivos operativos
generales ni modificación de autorizaciones de soporte. No se convierte al técnico
en administrador empresarial ni se agregan permisos sintéticos a su identidad.
La administración global existente no se elimina: los administradores/propietarios
conservan su autoridad; la cuenta de soporte es una alternativa limitada específica.

Las autorizaciones son independientes: revocar una no revoca otras autorizaciones
expresas del mismo técnico. Abrir caso toma la autorización vigente más reciente para
esa empresa y cierra los casos anteriores propios de esa empresa.

## Importación inicial (PL40)

**Mi empresa → Importación de datos** (o plataforma con empresa seleccionada):

1. Elegir Clientes, Camiones/equipos o Personas sin acceso.
2. Descargar plantilla CSV UTF-8, separador punto y coma; también se acepta coma.
3. Completar de 1 a 200 filas, máximo 1 MiB. Conservar nombres de columnas en español.
4. Previsualizar: comprobar cada línea, datos normalizados, referencias y errores.
5. Si todas son válidas, confirmar expresamente con motivo.

No se edita información existente, se crean cuentas, se asignan conductores ni se
habilitan cupos comerciales. Personas ingresa borradores con RUT validado, sin
contratos ni accesos. Después se regulariza cada ficha desde Personas y accesos.
Los equipos pueden registrarse sin documentos/capacidad; eso no autoriza circular.

Clientes requiere nombre y RUT; admite código, contacto, comuna oficial por ID y
responsable opcional por RUT. La comuna debe existir y el responsable debe pertenecer
a la empresa y cumplir los mismos controles del formulario individual.
Equipos requiere patente, marca, modelo y tipo; los demás campos son opcionales.
Personas requiere nombre y RUT; nacimiento y cargo son opcionales en el borrador.
Fechas: `AAAA-MM-DD`; capacidad: número con punto decimal, no separador de miles.
Las plantillas incluyen cabeceras como `nombre`, `marca`, `modelo`, `cargo` y
`fecha_nacimiento`. También se aceptan sus identificadores técnicos anteriores.

El servidor vuelve a validar al confirmar: un dato válido durante la previsualización
puede dejar de serlo por cambios posteriores. Un error revierte todo el lote, incluidos
eventos. Repetir la confirmación del mismo lote devuelve el resultado anterior sin
duplicar registros. Los identificadores de lote no permiten acceder a otra empresa
ni aprobar un lote de otro usuario. Se exigen permisos administrativos y del tipo de
dato, o el alcance de soporte expresamente autorizado.

La previsualización vence en 24 horas. Al confirmar se eliminan del lote sus copias de
filas y datos previsualizados; quedan hash, actor, fechas y registros creados. Las
previsualizaciones vencidas sin confirmar se limpian al cargar otro lote de esa
empresa. No es un servicio de limpieza continua ni sustituye PL44 o PL41.

## Despliegue y aceptación pendiente

La migración aditiva 040 está registrada en el arranque, sin SQL manual de producción.
No genera perfiles, autorizaciones ni importaciones ficticias en empresas existentes.
Solo añade el rol global de soporte sin usuarios predeterminados ni contraseñas.

Validar en un entorno autorizado: dos empresas, perfiles limitados en sesión ya
abierta, conductor con contrato/licencia vencidos, revocación y vencimiento de soporte,
un archivo con errores, referencia cambiada después de previsualizar y reintento de
confirmación. Las pruebas PGlite no demuestran concurrencia multiconexión física.
La prueba opcional de navegador usa Playwright local y Chrome, sin iniciar la app ni
conectarse a producción. PL41/GPS permanente siguen aplazados; los conjuntos de cierre
PL42/44/45/46 y la aceptación integral PL43 siguen pendientes.
