'use strict';
const {assertVehicleRoadReady}=require('./vehicle-readiness');
const {assertDriverOperationalReady}=require('./driver-readiness');
const {assertTripAvailability}=require('./trip-availability');

// Assignment is stricter than registration. A planned trip without resources is
// valid; once supplied, resources must be road/legal and operationally enabled.
async function assertTripResourcesReady(db,{companyId,truckId,driverId,now,...schedule}={}){
 if(!companyId)throw Object.assign(new Error('Empresa del viaje no disponible'),{status:403});
 // Personnel locks precede driver/truck locks, matching personnel renewals.
 if(driverId)await assertDriverOperationalReady(db,{companyId,driverId,now,lock:true});
 if(truckId)await assertVehicleRoadReady(db,{companyId,truckId,now,lock:true});
 await assertTripAvailability(db,{companyId,truckId,driverId,...schedule});
}
const requiresRoadAuthorization=status=>['Asignado','En carga','En tránsito'].includes(status);
function resourceFailure(res,error,fallback,{hideConflicts=false}={}){
 if(hideConflicts&&error?.code==='TRIP_RESOURCE_CONFLICT')return res.status(409).json({code:error.code,error:'El camión o conductor tiene otra reserva incompatible. Contacta a operaciones para revisar la asignación.'});
 if(error?.status&&['VEHICLE_NOT_ROAD_READY','DRIVER_NOT_OPERATIONAL_READY','TRIP_RESOURCE_CONFLICT','INVALID_TRIP_INTERVAL'].includes(error.code))return res.status(error.status).json({code:error.code,error:error.message,reasons:error.reasons||[],...(error.details?{details:error.details}:{})});
 return res.status(400).json({error:fallback});
}
module.exports={assertTripResourcesReady,requiresRoadAuthorization,resourceFailure};
