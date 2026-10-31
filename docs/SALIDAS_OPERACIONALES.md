# Servicios, salida del equipo y retorno

## Uso desde administración

Los puntos confirmados del viaje se reutilizan al agregar cargas y al abrir el planificador. La carga ofrece heredar el recorrido o indicar accesos distintos. Un cambio de ubicación en el itinerario mantiene las confirmaciones e historial existentes.

En la ficha completa del viaje, sección Resumen → Salida del equipo y retorno:

1. Con vehículo y conductor asignados, abrir una salida seleccionando una ubicación guardada como base y registrando el motivo. La base no se presume igual al origen de recogida.
2. Ejecutar y completar el servicio con su cliente, cargas, entregas y economía propios.
3. Decidir la continuidad: esperar instrucciones, retornar a base, encadenar otro servicio compatible o liberar el equipo fuera de base con motivo.
4. Confirmar la llegada a base para cerrar la salida. Entregar el POD o cerrar económicamente un servicio no sustituye este paso.

Para preparar la continuidad sin repetir el origen, usar **Preparar siguiente servicio desde el destino actual**. El punto se consulta y confirma por ID dentro de la empresa; cliente y destino quedan pendientes. Guardar el siguiente servicio sin recursos y después encadenarlo desde la salida: la asignación se registra de manera atómica y versionada. Si ya tiene itinerario, confirmar la revisión de restricciones cuando corresponda.

El origen general del siguiente servicio debe representar la ubicación final confirmada del anterior. Si la recogida del nuevo cliente está en otra instalación, registrarla como punto propio de la carga y parada intermedia: el tramo hasta esa recogida transcurre vacío. No se presupone que dos direcciones en una misma ciudad sean el mismo acceso.

La salida abierta reserva sus recursos aunque el servicio esté completado. Una unidad no debe quedar comercialmente liberada ni ingresar a taller mientras su salida siga abierta. Se preservan las comprobaciones de contratos, documentos, personal y disponibilidad. La elección de un siguiente servicio no representa una bolsa externa de cargas ni inventa distancias.

Los reemplazos de recursos del último servicio activo conservan el circuito versionado existente y sincronizan la salida con auditoría. No se reactivan servicios anteriores de una salida todavía abierta. Las posiciones del retorno aparecen en telemetría con su salida identificada, sin atribuirlas al servicio ya completado; velocidad y odómetro desconocidos se muestran sin informar.

Las salidas requieren registro explícito: la migración no transforma servicios históricos en salidas ni supone que hayan retornado a base. Las ubicaciones de base se registran con el selector de accesos de la empresa.

## Aplicación del conductor

Las acciones se ajustan al estado y a la parada vigente. Se requiere la aceptación y el checklist válido para iniciar la ejecución. Con itinerario, el conductor registra llegadas, recogidas y salidas; para el POD debe haber llegado a la parada correspondiente e iniciado descarga. Entregar una carga no entrega las demás ni confirma el retorno del equipo.

Los servicios asociados a salidas abiertas siguen accesibles para consultar instrucciones de retorno. En retorno, el conductor puede activar ubicación y confirmar llegada a base. La liberación fuera de base y el encadenamiento corresponden a operaciones.

El GPS del retorno requiere autorización del dispositivo y módulo contratado. Funciona en primer plano; no incorpora un servicio Android de seguimiento permanente ni garantiza posiciones con pantalla apagada. La pantalla distingue posiciones recibidas de ausencia de señal. GPS permanente y PL41 continúan aplazados.

## Publicación y validación

La migración versionada `052_operational_outings.sql` se aplica mediante el arranque habitual al publicar. No ejecutar SQL manual en producción. Los registros son por empresa, con auditoría e historial; la exportación incluye las nuevas tablas de salidas y posiciones bajo el aislamiento existente.

El proyecto de Android Studio contiene las fuentes actualizadas. El backend debe desplegarse antes de actualizar el teléfono. La preparación local no instala una APK, no elimina pendientes del dispositivo ni acredita una prueba Android real. Tras publicar, verificar un servicio completo, continuidad con otra carga, retorno y consulta administrativa de las posiciones recibidas.
