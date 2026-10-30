# Valor del servicio y cierre económico

El valor del servicio es el monto pactado que se cobrará al cliente. No equivale
a dinero recibido, facturación, combustible ni peajes. La advertencia incluye un
acceso directo y distingue monto registrado de monto confirmado.

1. Abrir **Control económico > Confirmar valor del servicio**.
2. Revisar monto, condición de IVA y motivo. El sistema no confirma por abrir el formulario.
3. Si el viaje comenzó, se crea una solicitud. Si ya existe, usar **Revisar solicitud pendiente**.
4. Un autorizador distinto, con `economics.approve`, puede resolverla con contraseña y motivo.
5. Excepción autorizada: un administrador empresarial efectivo (`company_admin`) o gerente (`manager`),
   con membresía activa y permiso existente de aprobación en la misma empresa,
   puede resolver su propia solicitud **de ingreso**, con contraseña y motivo.
   La acción **Aprobar como administrador** o **Aprobar como gerente** explica la excepción antes de confirmarla.
6. Actualizar y, si no hay otros pendientes, **Cerrar económicamente**.

No es obligatorio inventar un superior ni crear otra cuenta para el administrador o gerente.
Operaciones, administración de plataforma y cuentas heredadas no reciben
esta excepción por su nombre, permisos globales o empresa seleccionada. No se
otorgan permisos nuevos ni se modifica la resolución de actores. Las solicitudes
propias de costos conservan la separación entre solicitante y autorizador.

La migración **048_company_admin_revenue_resolution.sql** añade `self_resolution`,
ajusta la restricción de usuarios distintos únicamente para ingreso y valida en
base de datos la membresía, rol y permiso efectivos del administrador o gerente. Históricos
previos conservan el valor `false`; no se aprueban solicitudes automáticamente.

Auditoría registra solicitante, resolutor, fecha, motivo, confirmación de
reautenticación y política `company_admin_revenue_exception` o `company_manager_revenue_exception`, sin almacenar contraseña.
Una solicitud resuelta, un ingreso/IVA que cambió o un cierre económico no admite
una segunda aplicación silenciosa. Un fallo de auditoría revierte toda la resolución.
