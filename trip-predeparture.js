'use strict';
const Checklist=require('./public/checklist-shared');
const blocked=(code,message)=>Object.assign(new Error(message),{status:409,code});

// Called inside the locked trip transaction, only when starting/resuming travel.
// Assignment, loading, stopping and emergency/cancellation remain independent.
async function assertPredeparture(db,{companyId,tripId,truckId,driverId}){
 const accepted=(await db.query(`select a.id,t.itinerary_version,t.origin_location_id,t.destination_location_id from driver_mobile_actions a join trips t
  on t.id=a.trip_id and t.company_id=a.company_id and t.driver_id=a.driver_id and t.resource_version=a.resource_version
  where a.company_id=$1 and a.trip_id=$2 and a.driver_id=$3 and a.kind='accept' limit 1`,[companyId,tripId,driverId])).rows[0];
 if(!accepted)throw blocked('TRIP_ACCEPTANCE_REQUIRED','El conductor debe aceptar la asignación vigente antes de iniciar o reanudar el viaje.');
 const check=(await db.query(`select vc.*,vc.completed_at >= coalesce((select max(h.effective_at) from trip_resource_revisions h
   where h.trip_id=vc.trip_id and h.company_id=$4 and h.baseline_observation=false),'-infinity'::timestamptz) current_assignment
  from vehicle_checklists vc
  where vc.trip_id=$1 and vc.truck_id=$2 and vc.driver_id=$3
  and exists(select 1 from trips t where t.id=vc.trip_id and t.company_id=$4)
  order by vc.id desc limit 1`,[tripId,truckId,driverId,companyId])).rows[0];
 if(!check||check.current_assignment!==true||check.status!=='Aprobado'||!Checklist.quality(check).complete||!check.completed_at||!check.completed_by)
  throw blocked('TRIP_CHECKLIST_REQUIRED','Completa y aprueba el checklist preoperacional de este camión y conductor antes de iniciar o reanudar el viaje.');
 if((accepted.origin_location_id||accepted.destination_location_id)&&!accepted.itinerary_version)
  throw blocked('ITINERARY_LOCATION_CONFLICT','Confirma las paradas y calcula el itinerario del viaje antes de iniciar o reanudar.');
}
module.exports={assertPredeparture};
