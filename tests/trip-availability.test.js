'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertTripAvailability,interval}=require('../trip-availability');
const {assertVehicleRoadReady}=require('../vehicle-readiness');
const {assertTripResourcesReady,resourceFailure}=require('../trip-eligibility');
const {response:vehicleResponse}=require('../vehicle-profile-api');

test('intervalo permite fechas omitidas pero no fechas inválidas ni llegada anterior/igual',()=>{
 assert.deepEqual(interval(),{start:null,end:null});
 for(const schedule of [{plannedDeparture:'incorrecta'},{plannedDeparture:'2026-10-26T12:00Z',plannedArrival:'2026-10-26T11:00Z'},{plannedDeparture:'2026-10-26T12:00Z',plannedArrival:'2026-10-26T12:00Z'}])assert.throws(()=>interval(schedule),e=>e.code==='INVALID_TRIP_INTERVAL');
});
test('conflicto informa solo IDs de viajes de la empresa y recursos afectados',async()=>{
 let call;const db={async query(sql,values){call={sql,values};return {rows:[{id:8,trip_number:'V-8',truck_id:4,driver_id:9}]};}};
 await assert.rejects(assertTripAvailability(db,{companyId:10,truckId:4,driverId:7,tripId:3}),e=>{
  assert.equal(e.code,'TRIP_RESOURCE_CONFLICT');assert.equal(e.status,409);
  assert.deepEqual(e.details.conflicts,[{trip_id:8,trip_number:'V-8',truck:true,driver:false}]);return true;
 });
 assert.deepEqual(call.values,[10,4,7,3,null,null,false]);
 assert.match(call.sql,/t.company_id=\$1/);assert.match(call.sql,/t.id<>\$4/);
 assert.match(call.sql,/not in \('Completado','Cancelado'\)/);assert.doesNotMatch(call.sql,/for update/i);
});
test('viaje en ejecución comprueba recursos ocupados incluso con ETA anterior',async()=>{
 const db={async query(sql,v){assert.equal(v[6],true);assert.match(sql,/t.actual_departure is not null/);return {rows:[]};}};
 await assertTripAvailability(db,{companyId:10,truckId:4,status:'En tránsito'});
});
test('sin recursos no consulta viajes, pero valida las fechas',async()=>{
 await assertTripAvailability({query(){throw Error('No debe consultar');}},{companyId:10});
});

test('un conductor recibe el bloqueo sin identidad de viajes de otros conductores',()=>{
 const res={status(n){this.code=n;return this;},json(v){this.payload=v;return this;}};
 resourceFailure(res,{code:'TRIP_RESOURCE_CONFLICT',status:409,message:'Reserva',details:{conflicts:[{trip_id:99,trip_number:'Privado'}]}},'Error',{hideConflicts:true});
 assert.equal(res.code,409);assert.equal(res.payload.code,'TRIP_RESOURCE_CONFLICT');assert.equal(res.payload.details,undefined);assert.doesNotMatch(JSON.stringify(res.payload),/99|Privado/);
});
function vehicleDb({status='Disponible',maintenance=false,rejected=false}={}){
 const calls=[];return {calls,async query(sql,values){calls.push({sql,values});
  if(sql.startsWith('select time_zone'))return {rows:[]};
  if(sql.startsWith('select id from trucks'))return {rows:[{id:4}]};
  if(sql.includes('from maintenance'))return {rows:maintenance?[{id:1}]:[]};
  if(sql.includes('from alerts'))return {rows:rejected?[{id:2}]:[]};
  if(sql.includes('from trips'))return {rows:[]};
  if(sql.includes('from trucks t'))return {rows:[{id:4,status,document_expiries:Object.fromEntries(['circulation','soap','inspection'].map(code=>[code,{expires_at:'2099-01-01',status:'Vigente'}]))}]};
  throw Error(sql);
 }};
}
for(const options of [{status:'Mantención'},{status:'Fuera de servicio'},{status:'Inactivo'},{status:'Suspendido'},{maintenance:true},{rejected:true}])test(`documentos vigentes no anulan bloqueo operacional ${JSON.stringify(options)}`,async()=>{
 await assert.rejects(assertVehicleRoadReady(vehicleDb(options),{companyId:10,truckId:4}),e=>e.code==='VEHICLE_NOT_ROAD_READY');
});
test('reserva se comprueba después de bloquear el vehículo; falla cerrada si SQL no está disponible',async()=>{
 const db=vehicleDb();await assertTripResourcesReady(db,{companyId:10,truckId:4});
 assert.ok(db.calls.findIndex(c=>/for no key update/.test(c.sql))<db.calls.findIndex(c=>/from trips/.test(c.sql)));
 const failed=vehicleDb(),query=failed.query;failed.query=(sql,v)=>sql.includes('from trips')?Promise.reject(Error('DB offline')):query(sql,v);
 await assert.rejects(assertTripResourcesReady(failed,{companyId:10,truckId:4}),/DB offline/);
});

test('la ficha no presenta como habilitado un vehículo documentalmente vigente pero bloqueado',()=>{
 const row={status:'Disponible',document_expiries:Object.fromEntries(['circulation','soap','inspection'].map(c=>[c,{expires_at:'2099-01-01',status:'Vigente'}]))};
 assert.equal(vehicleResponse(row).ready,true);
 for(const extra of [{status:'Mantención'},{maintenance_in_progress:true},{checklist_rejected:true}]){
  const result=vehicleResponse({...row,...extra});assert.equal(result.ready,false);assert.ok(result.reasons.operational.length);
 }
});
