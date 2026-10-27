'use strict';

// Called inside the assignment transaction, after locking the driver/truck.
// Do not lock competing trips: they may already be locked by another dispatcher.
function interval({plannedDeparture,plannedArrival}={}){
 const parse=value=>{
  if(value===undefined||value===null||value==='')return null;
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))throw Object.assign(new Error('Fecha planificada no válida'),{status:400,code:'INVALID_TRIP_INTERVAL'});
  return date.toISOString();
 };
 const start=parse(plannedDeparture),end=parse(plannedArrival);
 if(start&&end&&end<=start)throw Object.assign(new Error('La llegada debe ser posterior a la salida'),{status:400,code:'INVALID_TRIP_INTERVAL'});
 return {start,end};
}

async function assertTripAvailability(db,{companyId,truckId,driverId,tripId=null,status='Planificado',plannedDeparture,plannedArrival}={}){
 const {start,end}=interval({plannedDeparture,plannedArrival});
 if(!truckId&&!driverId)return;
 const executing=['En carga','En tránsito','Detenido','Llegó a destino','Descargando'].includes(status);
 const conflicts=(await db.query(`select t.id,t.trip_number,t.truck_id,t.driver_id
  from trips t where t.company_id=$1 and ($4::bigint is null or t.id<>$4)
  and t.status not in ('Completado','Cancelado')
  and (($2::integer is not null and t.truck_id=$2) or ($3::integer is not null and t.driver_id=$3))
  and (($7::boolean and (t.actual_departure is not null or t.status in ('En carga','En tránsito','Detenido','Llegó a destino','Descargando')))
   or ((t.planned_departure is null or $6::timestamptz is null or t.planned_departure<$6)
    and (t.planned_arrival is null or $5::timestamptz is null or t.planned_arrival>$5)))
  order by t.id limit 20`,[companyId,truckId||null,driverId||null,tripId,start,end,executing])).rows;
 if(conflicts.length)throw Object.assign(new Error('El camión o conductor ya está reservado en otro viaje durante ese período. Revisa las asignaciones y sus fechas.'),{
  status:409,code:'TRIP_RESOURCE_CONFLICT',details:{conflicts:conflicts.map(row=>({trip_id:row.id,trip_number:row.trip_number,
   truck:truckId!=null&&String(row.truck_id)===String(truckId),driver:driverId!=null&&String(row.driver_id)===String(driverId)}))}
 });
}
module.exports={assertTripAvailability,interval};
