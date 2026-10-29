# Guía breve por rol

Los permisos reales se aplican en backend. Un cargo laboral no equivale a un rol de acceso; no compartir cuentas o contraseñas.

## Administrador de empresa

Seleccionar la empresa autorizada; revisar Datos y licencia, capacidad contratada y servicios habilitados. Personalización modifica la identidad permitida y los PDF correspondientes, no datos contractuales. Personas y accesos permite mantener datos laborales, contrato, condición y licencias. Un conductor debe ser trabajador activo, elegible y tener licencia vigente; permisos/vacaciones/suspensión y vencimientos restringen acceso según políticas vigentes. La excepción laboral del administrador debe registrarse por plataforma con motivo.

Usuarios define cuentas; Roles de empresa limita los permisos de un rol base y no otorga funciones globales. Importación previsualiza errores y duplicados antes de confirmar; no crea automáticamente cuentas, habilitación comercial ni autorizaciones de circulación. Registrar y corregir con motivo; la trazabilidad identifica al actor.

Exportar datos prepara un paquete privado de su propia empresa y requiere contraseña; actualizar estado y descargar antes de 24 horas. Custodiarlo con acceso restringido. No usarlo como copia de recuperación. Solicitar ampliaciones comerciales; no se habilitan equipos adicionales por tener cupo teórico del plan.

## Operaciones

La sección **Documentos y vencimientos** centraliza documentos de vehículos y
conductores; no emite guías tributarias. **Rutas** ya no es un paso separado del
menú: el recorrido se planifica dentro de **Viajes → detalle → Resumen → Itinerario,
cargas y tiempos**. El bloque desplegable **Recorridos guardados (opcional)**
permite buscar o guardar un par origen/destino de la empresa. Reutilizarlo sólo
prepara un borrador; no asigna recursos ni activa el servicio. Se conservan las
paradas intermedias y se recalculan los tramos al guardar la nueva versión.

Crear cliente → vehículo/equipo y documentación → conductor elegible ya registrado como persona → composición cuando corresponda → carga del cliente propio → viaje/itinerario → asignación y validación. La capacidad corresponde al conjunto y se evalúa por tramo. Una planificación incompleta no autoriza iniciar. Confirmar restricciones de ruta no verificables por proveedor; distancia y ETA no se inventan si falla ruteo.

Registrar paradas, recogidas y entregas por carga; no completar todo un viaje por resolver una entrega. Reemplazos y cambios deben conservar autor, motivo y versiones anteriores. Consultar ficha GPS/viaje; una posición antigua no es ubicación actual garantizada. No prometer seguimiento con pantalla bloqueada en la PWA.

## Mantenimiento

Programar no inmoviliza; confirmar ingreso registra fecha/hora, medición y motivo. Incorporar diagnóstico, hallazgos, tareas, repuestos y costos según se conocen; desconocido no significa cero. Resolver hallazgos con responsable y evidencia. Liberación técnica permite volver a operar; cierre económico puede permanecer pendiente. Revisar historial de medidores y próximos mantenimientos. No cerrar una alerta como sustituto de reparar.

## Conductor (PWA actual)

Ingresar con su cuenta asociada; comprobar viaje, recursos y próxima parada. Completar controles requeridos antes de iniciar. Registrar eventos, recogidas y entregas de la carga correcta; revisar pendientes de sincronización y evitar cambiar de cuenta o borrar almacenamiento con acciones pendientes. Reintentar según avisos; una entrega fallida no confirma las demás.

Autorizar ubicación cuando se solicita y verificar señal mostrada. La PWA no garantiza GPS continuo con pantalla apagada o en segundo plano. GPS permanente está aplazado. Terminar servicio no significa regreso a base ni cierre económico. Cerrar sesión desde el menú cuando no haya acciones pendientes de recuperar; no prestar la cuenta.

## Finanzas / gerencia

Revisar presupuesto vs ejecución, origen del combustible/TAG y asignaciones por viaje/carga sin duplicar costos. Distinguir observado, aprobado y conciliado. Finalización operacional y cierre económico son estados diferentes. Corregir con autorización y motivo; comparar reporte, dashboard y exportación sobre el mismo período.

## Plataforma y soporte

La administración global se mantiene separada. Elegir empresa explícitamente para trabajo contextual. Soporte limitado necesita autorización y caso vigentes y solo puede ejecutar ámbitos concedidos; no recibe ROOT/OWNER ni exportación integral. Estado del servicio se reserva a administradores globales habilitados: revisar códigos, frecuencia y tareas sin divulgar secretos. Marcar revisado no repara un incidente.

## Capacitación y escalamiento

Usar una empresa de pruebas, no datos reales innecesarios. Ejecutar los casos de ACEPTACION_CIERRE.md y registrar persona, fecha y resultado. Comunicar código, hora y X-Request-Id; nunca enviar contraseñas, tokens, DSN, firmas o datos personales en capturas públicas. Guía funcional sujeta a permisos y módulos contratados; la aceptación en teléfono real sigue siendo necesaria.
