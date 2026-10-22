const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {registerOperationsRoutes}=require('../operations-api');
function app(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>routes.find(r=>r.method===method&&r.path===path);return routes}
function response(){return {statusCode:200,payload:null,status(c){this.statusCode=c;return this},json(v){this.payload=v;return this},sendStatus(c){this.statusCode=c;return this}}}
async function invoke(route,req){const res=response();let i=0;const next=async()=>{const h=route.handlers[i++];if(h)return h(req,res,next)};await next();return res}
function pool(trip,{failAt=null,rollbackFails=false,lockedTrip=trip}={}){
 const calls=[];let connects=0,releases=0;
 const client={async query(sql,values=[]){
  const label=sql.includes('from trips')?'LOCK_TRIP':sql.startsWith('insert into telemetry')?'INSERT':sql;
  calls.push({sql,values,label});
  if(label===failAt||(label==='ROLLBACK'&&rollbackFails))throw Error(`simulated ${label} failure`);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(label))return {rowCount:0,rows:[]};
  if(label==='LOCK_TRIP')return {rowCount:lockedTrip?1:0,rows:lockedTrip?[lockedTrip]:[]};
  if(label==='INSERT')return {rowCount:1,rows:[{id:90,truck_id:values[0],trip_id:values[1],lat:values[2],lng:values[3],speed_kmh:values[4],km:values[5],recorded_at:values[6]}]};
  throw Error(`unexpected ${sql}`);
 },release(){releases++;}};
 return {calls,get connects(){return connects;},get releases(){return releases;},
  async connect(){connects++;if(failAt==='CONNECT')throw Error('simulated connect failure');return client;},
  async query(){throw Error('GPS must use the dedicated transaction client');}
 };
}
const user={role_code:'driver',company_id:10,driver_id:4};
test('callback GPS de una generación anterior queda invalidada',()=>{const js=fs.readFileSync(path.join(__dirname,'..','public','driver.js'),'utf8');assert.match(js,/gpsGeneration\+\+/);assert.match(js,/generation!==gpsGeneration\|\|gpsTripId!==trip\.id/);assert.match(js,/clearWatch\(gpsWatch\)/);assert.match(js,/now-gpsLastSent<10000/)});
test('driver GPS deriva camión, aplica scope y permite En tránsito/Detenido',async()=>{for(const status of ['En tránsito','Detenido']){const p=pool({id:7,company_id:10,driver_id:4,truck_id:31,status});const a=app();registerOperationsRoutes(a,p);const res=await invoke(a.route('post','/api/driver/trips/:id/positions'),{user,params:{id:'7'},body:{lat:-33.45,lng:-70.66,truck_id:999,company_id:999,driver_id:999}});assert.equal(res.statusCode,201);const insert=p.calls.find(c=>c.sql.startsWith('insert into telemetry'));assert.deepEqual(insert.values.slice(0,2),[31,7])}});
test('driver GPS rechaza viaje ajeno, identidad inválida y estados no capturables',async()=>{for(const trip of [null,{id:7,company_id:10,driver_id:4,truck_id:31,status:'Asignado'},{id:7,company_id:10,driver_id:4,truck_id:31,status:'Completado'}]){const p=pool(trip);const a=app();registerOperationsRoutes(a,p);const res=await invoke(a.route('post','/api/driver/trips/:id/positions'),{user,params:{id:'7'},body:{lat:0,lng:0}});assert.equal(res.statusCode,trip&&trip.status!=='Asignado'&&trip.status!=='Completado'?201:trip?409:404)}});
test('driver GPS exige rol y asociación',async()=>{const p=pool({id:7,company_id:10,driver_id:4,truck_id:31,status:'En tránsito'});const a=app();registerOperationsRoutes(a,p);for(const u of [{role_code:'driver',company_id:10,driver_id:null},{role_code:'operations',company_id:10,driver_id:4},{role_code:'admin',company_id:null,driver_id:null}])assert.equal((await invoke(a.route('post','/api/driver/trips/:id/positions'),{user:u,params:{id:'7'},body:{lat:0,lng:0}})).statusCode,403)});
test('driver GPS valida coordenadas velocidad y timestamp',async()=>{const p=pool({id:7,company_id:10,driver_id:4,truck_id:31,status:'En tránsito'});const a=app();registerOperationsRoutes(a,p);const route=a.route('post','/api/driver/trips/:id/positions');for(const body of [{lat:91,lng:0},{lat:0,lng:0,speed_kmh:-1},{lat:0,lng:0,recorded_at:'bad'}])assert.equal((await invoke(route,{user,params:{id:'7'},body})).statusCode,400)});

const trip={id:7,company_id:10,driver_id:4,truck_id:31,status:'En tránsito'};
async function gps(p,{actor=user,body={lat:-33.45,lng:-70.66},id='7'}={}){
 const a=app();await registerOperationsRoutes(a,p);
 return invoke(a.route('post','/api/driver/trips/:id/positions'),{user:actor,params:{id},body});
}
function assertLock(p,values=['7',10,4]){
 const lock=p.calls.find(c=>c.label==='LOCK_TRIP');assert.ok(lock);
 assert.match(lock.sql,/from trips where id=\$1 and company_id=\$2 and driver_id=\$3 for update$/);
 assert.deepEqual(lock.values,values);
}
test('GPS commits only after locked authorization and INSERT on the same client',async()=>{
 const p=pool(trip),recorded='2026-10-21T12:00:00.000Z';
 const res=await gps(p,{body:{lat:-33.45,lng:-70.66,speed_kmh:12,km:450,recorded_at:recorded,truck_id:999,trip_id:999,company_id:999,driver_id:999}});
 assert.equal(res.statusCode,201);assert.equal(res.payload.truck_id,31);assert.equal(res.payload.trip_id,7);
 assert.deepEqual(p.calls.map(c=>c.label),['BEGIN','LOCK_TRIP','INSERT','COMMIT']);assertLock(p);
 assert.deepEqual(p.calls.find(c=>c.label==='INSERT').values,[31,7,-33.45,-70.66,12,450,recorded]);
 assert.equal(p.connects,1);assert.equal(p.releases,1);
});
test('GPS derives the current truck returned by the locked read, with existing optional defaults',async()=>{
 const p=pool(trip,{lockedTrip:{...trip,truck_id:82,status:'Detenido'}}),res=await gps(p);
 assert.equal(res.statusCode,201);assert.equal(res.payload.truck_id,82);
 const insert=p.calls.find(c=>c.label==='INSERT');assert.deepEqual(insert.values.slice(0,6),[82,7,-33.45,-70.66,0,null]);assert.ok(Number.isFinite(Date.parse(insert.values[6])));
 assertLock(p);assert.equal(p.releases,1);
});
for(const [name,actor,id] of [
 ['other company',{...user,company_id:20},'7'],['other driver',{...user,driver_id:8},'7'],['other trip',user,'88']
])test(`GPS binds session scope for ${name} and rolls back an empty locked result`,async()=>{
 // DB returns no authorized row; SQL and bound scope are verified independently.
 const p=pool(null),res=await gps(p,{actor,id,body:{lat:0,lng:0,company_id:10,driver_id:4,truck_id:31}});
 assert.equal(res.statusCode,404);assertLock(p,[id,actor.company_id,actor.driver_id]);
 assert.deepEqual(p.calls.map(c=>c.label),['BEGIN','LOCK_TRIP','ROLLBACK']);assert.equal(p.releases,1);
});
test('GPS revalidates a driver reassignment committed before acquiring the lock',async()=>{
 const p=pool(trip,{lockedTrip:null}),res=await gps(p);
 assert.equal(res.statusCode,404);assertLock(p);assert.deepEqual(p.calls.map(c=>c.label),['BEGIN','LOCK_TRIP','ROLLBACK']);assert.equal(p.releases,1);
});
for(const status of ['Planificado','Asignado','En carga','Llegó a destino','Descargando','Completado','Cancelado'])test(`GPS rejects current locked state ${status} and releases without INSERT`,async()=>{
 const p=pool(trip,{lockedTrip:{...trip,status}}),res=await gps(p);
 assert.equal(res.statusCode,409);assert.equal(res.payload.status,status);
 assert.deepEqual(p.calls.map(c=>c.label),['BEGIN','LOCK_TRIP','ROLLBACK']);assert.equal(p.releases,1);
});
test('GPS rolls back a current trip without truck',async()=>{
 const p=pool({...trip,truck_id:null}),res=await gps(p);
 assert.equal(res.statusCode,409);assert.match(res.payload.error,/camión asignado/);
 assert.deepEqual(p.calls.map(c=>c.label),['BEGIN','LOCK_TRIP','ROLLBACK']);assert.equal(p.releases,1);
});
for(const failAt of ['BEGIN','LOCK_TRIP','INSERT','COMMIT'])test(`GPS rolls back and releases on ${failAt} failure without success response`,async()=>{
 const p=pool(trip,{failAt}),res=await gps(p);
 assert.equal(res.statusCode,400);assert.equal(p.calls.at(-1).label,'ROLLBACK');assert.equal(p.releases,1);
 const expected=['BEGIN','LOCK_TRIP','INSERT','COMMIT'];assert.deepEqual(p.calls.map(c=>c.label),[...expected.slice(0,expected.indexOf(failAt)+1),'ROLLBACK']);
});
test('GPS releases even if ROLLBACK fails',async()=>{
 const p=pool(trip,{failAt:'INSERT',rollbackFails:true}),res=await gps(p);
 assert.equal(res.statusCode,400);assert.equal(p.calls.at(-1).label,'ROLLBACK');assert.equal(p.releases,1);
});
test('GPS connection failure returns existing error without nonexistent release',async()=>{
 const p=pool(trip,{failAt:'CONNECT'}),res=await gps(p);
 assert.equal(res.statusCode,400);assert.equal(p.connects,1);assert.equal(p.releases,0);assert.deepEqual(p.calls,[]);
});
test('GPS rejects association and payload errors before opening a transaction',async()=>{
 for(const options of [{actor:{...user,driver_id:null}},{actor:{...user,role_code:'operations'}},{body:{lat:91,lng:0}},{body:{lat:0,lng:0,km:-1}},{body:{lat:0,lng:0,recorded_at:'invalid'}}]){
  const p=pool(trip),res=await gps(p,options);assert.ok([400,403].includes(res.statusCode));assert.equal(p.connects,0);assert.equal(p.releases,0);assert.deepEqual(p.calls,[]);
 }
});
