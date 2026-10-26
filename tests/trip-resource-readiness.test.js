const test=require('node:test');
const assert=require('node:assert/strict');
const {registerCoreRoutes}=require('../core-api');
const {registerOperationsRoutes}=require('../operations-api');

function app(){const r=[];for(const m of ['get','post','patch','put','delete'])r[m]=(path,...handlers)=>r.push({method:m,path,handlers});r.route=(method,path)=>r.find(x=>x.method===method&&x.path===path);return r}
function response(){return {statusCode:200,payload:null,status(n){this.statusCode=n;return this},json(v){this.payload=v;return this},sendStatus(n){this.statusCode=n;return this}}}
async function invoke(route,req){const res=response();let i=0;const next=async()=>{const h=route.handlers[i++];if(h)return h(req,res,next)};await next();return res}
function pool(status='Planificado'){const calls=[];const trip={id:7,company_id:10,truck_id:31,driver_id:41,client_id:51,route_id:61,status};const client={async query(sql,values=[]){calls.push(sql);if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(/from trips/.test(sql))return {rows:[trip],rowCount:1};if(/select id from/.test(sql))return {rows:[{id:1}],rowCount:1};return {rows:[trip],rowCount:1}},release(){}};return {calls,async connect(){return client},async query(sql,values=[]){calls.push(sql);return {rows:[]}}}}
const user={id:9,role_code:'operations',company_id:10,permissions:['trips.manage'],driver_id:41};
async function assertBlocked(register,method,path,body){const p=pool(path.includes('/driver/')?'Asignado':'Planificado');let guardCalls=0;const guard=async(db,resources)=>{guardCalls++;assert.equal(resources.companyId,10);assert.equal(resources.truckId,31);assert.equal(resources.driverId,41);const e=new Error('Documentación vial pendiente');e.status=409;e.code='VEHICLE_NOT_ROAD_READY';e.details={missing:['soap']};throw e};const a=app();register(a,p,{assertTripResourcesReady:guard});const actor=path.includes('/driver/')?{...user,role_code:'driver'}:user;const res=await invoke(a.route(method,path),{user:actor,params:{id:'7'},body});assert.equal(guardCalls,1,'Debe alcanzar y ejecutar la validación de recursos');assert.equal(res.statusCode,409,JSON.stringify(res.payload));assert.equal(res.payload.code,'VEHICLE_NOT_ROAD_READY');assert.deepEqual(res.payload.details.missing,['soap']);assert.equal(p.calls.filter(x=>x==='ROLLBACK').length,1);assert.equal(p.calls.some(x=>/^COMMIT$/.test(x)),false);return res}

test('readiness failure rolls back core trip creation and status',async()=>{
 await assertBlocked(registerCoreRoutes,'post','/api/trips',{origin:'A',destination:'B',client_id:51,truck_id:31,driver_id:41,route_id:61});
 await assertBlocked(registerCoreRoutes,'patch','/api/trips/:id/status',{status:'En tránsito'});
});
test('readiness failure rolls back operations assign/status and driver start',async()=>{
 await assertBlocked(registerOperationsRoutes,'patch','/api/operations/trips/:id/assign',{truck_id:31,driver_id:41,client_id:51,route_id:61});
 await assertBlocked(registerOperationsRoutes,'patch','/api/operations/trips/:id/status',{status:'En tránsito'});
 await assertBlocked(registerOperationsRoutes,'patch','/api/driver/trips/:id/status',{status:'En tránsito'});
});
test('completion, stop and cancellation do not invoke readiness guard',async()=>{
 for(const status of ['Detenido','Completado','Cancelado']){let called=0;const p=pool(),a=app();registerOperationsRoutes(a,p,{assertTripResourcesReady:async()=>{called++}});const res=await invoke(a.route('patch','/api/operations/trips/:id/status'),{user,params:{id:'7'},body:{status}});assert.equal(res.statusCode,200,JSON.stringify(res.payload));assert.equal(called,0)}
});
