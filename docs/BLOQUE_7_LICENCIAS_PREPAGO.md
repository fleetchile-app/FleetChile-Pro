# Bloque 7 — Primera entrega: PL35 y PL38

## Modelo acordado

El plan comercial fija un máximo total de unidades y módulos disponibles/incluidos.
No concede cupos de uso ni cobra una tarifa por categoría del plan.
El período pagado define cantidades y precios acordados por categoría:
camión, tractocamión, remolque/semirremolque y otros equipos.
Cada componente identificado ocupa un cupo propio de su categoría, incluso estando
en mantenimiento. Una composición no fusiona identidades ni documentos.

Los cupos solo se aplican a unidades identificadas habilitadas por plataforma.
Registrar inventario no habilita viajes, GPS, combustible ni mantenciones.
La documentación, personal, checklist y disponibilidad siguen siendo requisitos
independientes: una habilitación comercial no autoriza por sí sola la circulación.

No se precargan planes, precios ni pagos ficticios. Los precios se ingresan
expresamente en CLP por período y categoría utilizada. Las categorías no contratadas
conservan precio desconocido, no cero. Un precio cero exige entrada explícita o un
módulo declarado incluido en el plan. Esta gestión no emite facturas ni verifica
automáticamente el banco; identifica a quien confirma manualmente el pago.

## Secuencia de plataforma

1. Planes comerciales: crear código, nombre, máximo y módulos permitidos/incluidos.
   Reutilizar código crea una revisión; no modifica planes ni contratos anteriores.
2. Empresas y licencias → Licencia y cupos: consultar inventario, solicitudes y períodos.
3. Preparar propuesta con plan, cantidades totales deseadas, precios por categoría,
   módulos, período exacto, vencimiento de propuesta y motivo. Publicar calcula el cargo,
   pero no habilita capacidad.
4. La empresa acepta o rechaza desde Capacidad y servicios. Plataforma también puede
   registrar una aceptación autorizada externa, indicando el detalle y su autor.
5. Confirmar pago recibido: referencia única, importe exacto, motivo y confirmación
   expresa. No registrar una promesa de pago como recibida. Pago y contrato se guardan
   en una transacción con auditoría; si algo falla, se revierte todo.
6. Si el período ya comenzó, se pueden seleccionar unidades para habilitarlas en la
   misma transacción. En una primera activación deben incluirse las unidades de los
   trabajos en ejecución. Si no caben, regularizar sin bloquearlos silenciosamente.
7. Habilitar, liberar o sustituir unidades desde la misma ficha. La sustitución es
   atómica y de la misma categoría. No se libera una unidad con viajes no terminales
   o mantenciones En proceso; el historial nunca se elimina.

No existe botón empresarial para comprar/habilitar cupos por cuenta propia. Crear
usuarios, asignar roles o editar los campos históricos de licencia no concede módulos
ni cupos. ROOT/OWNER y RBAC se conservan sin modificar resolveActorContext ni sus políticas.

## Ampliaciones y renovaciones

- La empresa solicita cantidades totales y módulos, no un incremento ambiguo.
- Una ampliación selecciona la última revisión de un período pagado vigente o futuro.
  Conserva su comienzo y fin y no reduce cupos, elimina módulos ni cambia precios
  contratados anteriores. Puede cambiar de plan si necesita un techo superior.
- Cargo de ampliación = diferencia entre precios completos de las configuraciones ×
  segundos pendientes / segundos del período. Se redondea una vez al peso CLP.
  Si el período aún no comienza, la fracción es uno. El momento de cálculo y la fórmula
  quedan registrados en la propuesta. El importe es fijo hasta su vencimiento.
- Una renovación pagada anticipadamente comienza cuando termina el último período
  pagado; no anticipa el acceso. Si la suscripción ya venció, se fija un nuevo período
  al renovar, sin imponer el pago retroactivo de días sin servicio.
- Las habilitaciones respetan también la capacidad de renovaciones futuras ya pagadas.
  Para pasar de tres a cuatro unidades con renovación futura de tres: ampliar ambos
  períodos y confirmar sus diferencias antes de habilitar la cuarta unidad.
- Cambiar precios o reducir servicios se plantea en una renovación nueva. No hay
  devoluciones, créditos, pasarela de pagos, cobro automático ni débito recurrente en
  esta entrega. No se aplican decisiones comerciales no acordadas por defecto.

## Vigencia y cierre seguro

El acceso efectivo combina período pagado, módulo y permisos existentes.
No hay gracia automática que otorgue servicios sin pago. El inventario, datos básicos
y consulta histórica siguen disponibles según permisos. Reportes generados y GPS vivo
requieren contratación; el historial GPS puede consultarse explícitamente por período.

Al vencer, se impiden nuevos viajes, asignaciones, inicios y nuevas prestaciones.
Se conserva un camino acotado para registrar hechos y finalizar viajes ya iniciados,
con sus unidades originales y los módulos de su operación; no se concede POD gratis a
un viaje creado sin ese módulo. Los viajes anteriores al control conservan un cierre
compatible. También se permite terminar/liberar y cerrar trabajos de taller en curso.
El GPS ya autorizado de un viaje En tránsito/Detenido puede continuar hasta finalizarlo,
sin habilitar nuevos viajes ni conceder GPS a uno que comenzó sin ese módulo. Esto no
modifica el motor GPS, permisos Android ni las limitaciones de segundo plano de la PWA.
La liberación puede conservar su recordatorio preventivo sucesor; ese registro
pendiente no autoriza otro ingreso a taller sin período y módulo vigentes.
Cambiar recursos o contratar otra prestación requiere regularizar el período.
Los nuevos registros económicos y cambios comerciales requieren su contratación;
el historial no se elimina. No se amplían permisos de ningún actor mediante la licencia.

SQL refuerza cupos, módulos operativos, sustituciones e integridad del pago/contrato,
incluyendo rutas heredadas. El middleware comunica restricciones antes de nuevas
acciones. Los bloqueos comerciales se serializan por empresa y las versiones evitan
sobrescrituras. PGlite no demuestra concurrencia entre dos conexiones físicas de
PostgreSQL: esa aceptación sigue correspondiendo a PL43.

## Transición de clientes existentes

La migración 038 no inventa pagos, asigna cupos ni bloquea en masa los datos existentes.
Estos clientes aparecen pendientes de configuración y conservan temporalmente su
comportamiento anterior hasta una activación explícita con pago confirmado.
Las empresas nuevas creadas desde plataforma nacen controladas, sin período pagado.
Los campos históricos de licencia no son la autoridad del nuevo modelo y quedan
protegidos frente a edición cuando el control comercial está activo.

## Prueba de aceptación en entorno autorizado

1. Crear un plan con techo cinco; registrar cinco camiones de prueba.
2. Cotizar tres, aceptar y confirmar pago real de prueba autorizado, habilitando tres.
3. Verificar que los cinco figuran en inventario, solo tres ocupan cupos y el cuarto
   no admite viaje ni mantención mediante UI ni API directa.
4. Solicitar cuatro desde empresa: no cambia el acceso hasta aceptar y pagar.
5. Confirmar la diferencia proporcional: habilitar el cuarto, no el quinto.
6. Probar mantenimiento/GPS descontratados y roles con permisos: no deben autoactivarlos.
7. Intentar liberar una unidad en taller o con viaje abierto: debe rechazarse.
8. Sustituir una unidad libre por otra, comprobar cupo, auditoría e historial.
9. Repetir el mismo pago: un solo contrato, sin duplicar habilitaciones.
10. Verificar vencimiento, consulta, cierre de servicios iniciados y renovación futura.
11. Probar con dos empresas; nunca exponer propuestas, unidades ni solicitudes ajenas.
12. Confirmar aspecto y usabilidad en navegador real, además de las pruebas automatizadas.

No se ha iniciado el servidor, ejecutado migraciones en producción, hecho commit,
push o despliegue. No se añadieron dependencias. PL36, PL37, PL39–PL46 no se dan por
terminados por esta entrega. PL41 y GPS permanente siguen aplazados.
