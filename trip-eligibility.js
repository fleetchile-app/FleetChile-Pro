'use strict';
const {assertVehicleRoadReady}=require('./vehicle-readiness');
const {assertDriverOperationalReady}=require('./driver-readiness');

// Assignment is stricter than registration. A planned trip without resources is
// valid; once supplied, resources must be road/legal and operationally enabled.
async function assertTripResourcesReady(db,{companyId,truckId,driverId,now}={}){
 if(!companyId)throw Object.assign(new Error('Empresa del viaje no disponible'),{status:403});
 // Personnel locks precede driver/truck locks, matching personnel renewals.
 if(driverId)await assertDriverOperationalReady(db,{companyId,driverId,now,lock:true});
 if(truckId)await assertVehicleRoadReady(db,{companyId,truckId,now,lock:true});
}
const requiresRoadAuthorization=status=>['Asignado','En carga','En tránsito'].includes(status);
function resourceFailure(res,error,fallback){
 if(error?.status&&['VEHICLE_NOT_ROAD_READY','DRIVER_NOT_OPERATIONAL_READY'].includes(error.code))return res.status(error.status).json({code:error.code,error:error.message,reasons:error.reasons||[],...(error.details?{details:error.details}:{})});
 return res.status(400).json({error:fallback});
}
module.exports={assertTripResourcesReady,requiresRoadAuthorization,resourceFailure};
