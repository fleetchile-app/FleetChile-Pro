'use strict';
const {assertVehicleRoadReady}=require('./vehicle-readiness');
const {assertDriverOperationalReady}=require('./driver-readiness');
const {assertTripAvailability}=require('./trip-availability');
const E=require('./equipment-domain');

// Assignment is stricter than registration. A planned trip without resources is
// valid; once supplied, resources must be road/legal and operationally enabled.
async function assertTripResourcesReady(db,{companyId,truckId,driverId,trailerId=null,compositionSnapshot=null,now,...schedule}={}){
 if(!companyId)throw Object.assign(new Error('Empresa del viaje no disponible'),{status:403});
 // Personnel locks precede driver/truck locks, matching personnel renewals.
 if(driverId)await assertDriverOperationalReady(db,{companyId,driverId,now,lock:true});
 if(trailerId){
  if(!truckId)throw E.fail('El remolque requiere un vehículo principal');
  const ids=[...new Set([Number(truckId),Number(trailerId)])].sort((a,b)=>a-b);
  const rows=(await db.query('select id,tipo from trucks where company_id=$1 and id=any($2::integer[]) order by id for no key update',[companyId,ids])).rows;
  if(rows.length!==ids.length)throw E.fail('Uno de los componentes no pertenece a la empresa',403);
  E.pair(rows.find(v=>String(v.id)===String(truckId)),rows.find(v=>String(v.id)===String(trailerId)));
  for(const id of ids)await assertVehicleRoadReady(db,{companyId,truckId:id,now,primary:String(id)===String(truckId)});
 }else if(truckId)await assertVehicleRoadReady(db,{companyId,truckId,now,lock:true,primary:true});
 if(schedule.itineraryVersion>0&&schedule.tripId){
  await require('./itinerary-api').checkItinerary(db,{id:schedule.tripId,company_id:companyId,itinerary_version:schedule.itineraryVersion,truck_id:truckId,trailer_id:trailerId});
 }
 E.windowCheck(compositionSnapshot,{...schedule,now:now||new Date()});
 await assertTripAvailability(db,{companyId,truckId,driverId,trailerId,...schedule});
}
const requiresRoadAuthorization=status=>['Asignado','En carga','En tránsito'].includes(status);
function resourceFailure(res,error,fallback,{hideConflicts=false}={}){
 if(error?.code?.startsWith('P75'))return res.status(409).json({code:'COMMERCIAL_BLOCKED',error:error.message+'. Solicita revisión de los cupos pagados en Capacidad y servicios.'});
 if(hideConflicts&&error?.code==='TRIP_RESOURCE_CONFLICT')return res.status(409).json({code:error.code,error:'El camión o conductor tiene otra reserva incompatible. Contacta a operaciones para revisar la asignación.'});
 if(error?.status&&(error.code?.startsWith('ITINERARY_')||['VEHICLE_NOT_ROAD_READY','DRIVER_NOT_OPERATIONAL_READY','TRIP_RESOURCE_CONFLICT','INVALID_TRIP_INTERVAL','EQUIPMENT_INVALID','COMPOSITION_OUTSIDE_WINDOW'].includes(error.code)))return res.status(error.status).json({code:error.code,error:error.message,reasons:error.reasons||[],...(error.details?{details:error.details}:{})});
 return res.status(400).json({error:fallback});
}
module.exports={assertTripResourcesReady,requiresRoadAuthorization,resourceFailure};
