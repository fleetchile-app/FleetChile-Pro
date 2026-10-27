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

async function assertTripAvailability(db,{companyId,truckId,driverId,trailerId=null,tripId=null,status='Planificado',plannedDeparture,plannedArrival,effectiveFrom=null}={}){
 const {start,end}=interval({plannedDeparture,plannedArrival});
 if(!truckId&&!driverId&&!trailerId)return;
 const executing=['En carga','En tránsito','Detenido','Llegó a destino','Descargando'].includes(status);
 const conflicts=(await db.query(`with revisions as (
   select h.*,lead(h.effective_at) over(partition by h.trip_id order by h.version) effective_until
   from trip_resource_revisions h where h.company_id=$1
  ), reservations as (
   select p.id,p.company_id,p.trip_number,p.status,p.actual_departure,
    case when h.id is null then p.truck_id else coalesce((h.snapshot->'truck'->>'id')::integer,(h.snapshot->>'truck_id')::integer) end truck_id,
    case when h.id is null then p.trailer_id else coalesce((h.snapshot->'trailer'->>'id')::integer,(h.snapshot->>'trailer_id')::integer) end trailer_id,
    case when h.id is null then p.driver_id else coalesce((h.snapshot->'driver'->>'id')::integer,(h.snapshot->>'driver_id')::integer) end driver_id,
    greatest(p.planned_departure,h.effective_at) planned_departure,
    least(p.planned_arrival,h.effective_until) planned_arrival,
    (h.id is null or h.version=p.resource_version) current_configuration
   from trips p left join revisions h on h.trip_id=p.id and h.company_id=p.company_id
   where p.company_id=$1 and p.status not in ('Completado','Cancelado')
  ), candidate as (
   select greatest($5::timestamptz,coalesce($9::timestamptz,(select h.effective_at from trip_resource_revisions h
    join trips p on p.id=h.trip_id and p.company_id=h.company_id and p.resource_version=h.version
    where h.company_id=$1 and h.trip_id=$4))) starts_at
  ) select distinct t.id,t.trip_number,t.truck_id,t.driver_id,t.trailer_id
  from reservations t cross join candidate c where t.company_id=$1 and ($4::bigint is null or t.id<>$4)
  and t.status not in ('Completado','Cancelado')
  and (($2::integer is not null and (t.truck_id=$2 or t.trailer_id=$2)) or ($3::integer is not null and t.driver_id=$3)
   or ($8::integer is not null and (t.truck_id=$8 or t.trailer_id=$8)))
  and (($7::boolean and t.current_configuration and (t.actual_departure is not null or t.status in ('En carga','En tránsito','Detenido','Llegó a destino','Descargando')))
   or ((t.planned_departure is null or t.planned_arrival is null or t.planned_departure<t.planned_arrival)
    and (t.planned_departure is null or $6::timestamptz is null or t.planned_departure<$6)
    and (t.planned_arrival is null or c.starts_at is null or t.planned_arrival>c.starts_at)))
  order by t.id limit 20`,[companyId,truckId||null,driverId||null,tripId,start,end,executing,trailerId||null,effectiveFrom])).rows;
 if(conflicts.length)throw Object.assign(new Error('El camión, remolque o conductor ya está reservado en otro viaje durante ese período. Revisa las asignaciones y sus fechas.'),{
  status:409,code:'TRIP_RESOURCE_CONFLICT',details:{conflicts:conflicts.map(row=>({trip_id:row.id,trip_number:row.trip_number,
   truck:truckId!=null&&[row.truck_id,row.trailer_id].some(id=>String(id)===String(truckId)),driver:driverId!=null&&String(row.driver_id)===String(driverId),
   trailer:trailerId!=null&&[row.truck_id,row.trailer_id].some(id=>String(id)===String(trailerId))}))}
 });
}
module.exports={assertTripAvailability,interval};
