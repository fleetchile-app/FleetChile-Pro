const RESOURCE_ALERT='trip_resources_missing';
const terminal=status=>['Completado','Cancelado'].includes(status);
const inExecution=trip=>Boolean(trip.actual_departure)||['En carga','En tránsito','Detenido','Llegó a destino','Descargando'].includes(trip.status);
function activationError(trip,status){
  if(['Planificado','Cancelado'].includes(status))return null;
  if(!trip.truck_id||!trip.driver_id)return 'No se puede activar el servicio sin camión y conductor asignados';
  return null;
}
async function syncResourceAlert(db,trip){
  if(!trip.id||!trip.company_id)throw new Error('Viaje sin identidad empresarial para sincronizar alertas');
  if(!terminal(trip.status)&&(!trip.truck_id||!trip.driver_id)){
    const missing=[!trip.truck_id?'camión':null,!trip.driver_id?'conductor':null].filter(Boolean).join(' y ');
    await db.query(`insert into alerts(company_id,level,title,text,resolved,created_at,source_type,source_id,condition_code)
      values($1,'critical','Viaje con recursos pendientes',$2,false,now(),'trip',$3,$4)
      on conflict (company_id,source_type,source_id,condition_code)
      where resolved=false and source_type is not null and source_id is not null and condition_code is not null
      do update set text=excluded.text`,[trip.company_id,'Viaje '+(trip.trip_number||'#'+trip.id)+': falta asignar '+missing,trip.id,RESOURCE_ALERT]);
  }else{
    await db.query(`update alerts set resolved=true,resolved_at=now(),resolution_note='Condición de recursos resuelta'
      where company_id=$1 and source_type='trip' and source_id=$2 and condition_code=$3 and resolved=false`,[trip.company_id,trip.id,RESOURCE_ALERT]);
  }
}
module.exports={RESOURCE_ALERT,terminal,inExecution,activationError,syncResourceAlert};
