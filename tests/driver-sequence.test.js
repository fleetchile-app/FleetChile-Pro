'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerOperationsRoutes}=require('../operations-api');
const {driverSequence,validateDeliveryContext}=require('../driver-workflow-api');
const D=require('../itinerary-domain'),Checklist=require('../public/checklist-shared');
const user={id:8,company_id:10,driver_id:4,role_code:'driver'};
const signature='iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGklEQVQ4jWP4TyFgGDXg/2gY/B8Ng//DIgwAXXj8LuMlDaEAAAAASUVORK5CYII=';
function fixture({itinerary=true,accepted=true,checked=true,status='Asignado',loads,failOn=''}={}){
 const trip={id:7,company_id:10,driver_id:4,truck_id:3,status,resource_version:0,itinerary_version:itinerary?1:0};
 const cargo=loads||[{id:9,trip_id:7,client_id:2,cargo:'Carga',weight_kg:100,status:'Planificada',origin_location_id:1,destination_location_id:2}];
 const stops=[{key:'a',location_id:1,purpose:'pickup',location:{name:'Origen',lat:-33,lng:-70}},{key:'b',location_id:2,purpose:'delivery',location:{name:'Destino',lat:-34,lng:-71}}];
 const plan={stops,loads:cargo.map(l=>({load_id:l.id,pickup:'a',delivery:'b'})),load_signature:D.signature(cargo)};
 let events=[],snapshot;const calls=[];
 const db={release(){},async query(sql,v=[]){
  calls.push({sql,v});
  if(failOn&&sql.includes(failOn))throw Error('Fallo transaccional de prueba');
  if(sql==='BEGIN'){snapshot=structuredClone({trip,cargo,events});return {rows:[]};}
  if(sql==='ROLLBACK'){Object.assign(trip,snapshot.trip);cargo.splice(0,cargo.length,...snapshot.cargo);events=snapshot.events;return {rows:[]};}
  if(sql==='COMMIT')return {rows:[]};
  if(sql.includes('from driver_mobile_actions a join trips'))return {rows:accepted?[{id:1}]:[]};
  if(sql.includes('from vehicle_checklists vc'))return {rows:checked?[{status:'Aprobado',current_assignment:true,completed_at:'2026-01-01',completed_by:8,items:Checklist.ids.map(id=>({id,result:'ok'}))}]:[]};
  if(sql.includes('from trip_itinerary_revisions'))return {rows:itinerary?[{plan}]:[]};
  if(sql.includes('from trip_itinerary_events'))return {rows:sql.includes('event_key=$3')?events.filter(e=>e.event_key===v[2]):events};
  if(sql.startsWith('select * from trip_loads'))return {rows:cargo};
  if(sql.startsWith('select id,trip_id,status from trip_loads'))return {rows:cargo.filter(l=>String(l.id)===String(v[0]))};
  if(sql.includes('from operational_locations'))return {rows:stops.map(s=>({id:s.location_id,...s.location}))};
  if(sql.includes('from trips where'))return {rows:[{...trip}]};
  if(sql.startsWith('update trips')){trip.status=v[0];return {rows:[{...trip}]};}
  if(sql.startsWith('insert into trip_itinerary_events')){const e={id:events.length+1,event_key:v[3],stop_key:v[4],load_id:v[5],kind:v[6],itinerary_version:v[2],occurred_at:new Date().toISOString()};events.push(e);return {rows:[e]};}
  if(sql.startsWith('select * from trip_delivery_proofs')||sql.startsWith('select id from trip_delivery_proofs')||sql.includes('from delivery_proof_files'))return {rows:[]};
  if(sql.startsWith('insert into trip_delivery_proofs'))return {rows:[{id:21,trip_id:7,load_id:9,status:'DRAFT'}]};
  if(sql.startsWith('update trip_delivery_proofs'))return {rows:[{id:21,trip_id:7,load_id:9,status:'CLOSED'}]};
  if(sql.startsWith('update trip_loads')){cargo[0].status='Entregada';return {rows:[cargo[0]]};}
  if(sql.startsWith('insert into')||sql.startsWith('update alerts'))return {rows:[],rowCount:1};
  throw Error('Unexpected SQL: '+sql);
 }};
 return {trip,cargo,plan,calls,get events(){return events;},db,pool:{query:db.query.bind(db),connect:async()=>db}};
}
async function harness(f){
 const routes=[];const app={};for(const method of ['get','patch','post'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
 await registerOperationsRoutes(app,f.pool,{assertTripResourcesReady:async()=>{},storage:{put:async()=>{},delete:async()=>{}}});
 return async(method,suffix,body={})=>{
  const route=routes.find(r=>r.method===method&&r.path==='/api/driver/trips/:id/'+suffix);
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;},sendStatus(n){this.statusCode=n;return this;}};
  await route.handlers.at(-1)({user,params:{id:'7'},body},res);return res;
 };
}
test('secuencia multientrega sincroniza estados y bloquea saltos, POD prematuro y cierre implícito',async()=>{
 const f=fixture(),run=await harness(f);let n=0;
 const event=(kind,stop_key,extra={})=>run('post','workflow/events',{kind,stop_key,version:1,resource_version:0,event_key:'event-'+ ++n,...extra});
 assert.deepEqual((await run('get','allowed-statuses')).body.allowed_statuses,[]);
 assert.equal((await run('patch','status',{status:'En tránsito'})).statusCode,409);
 assert.equal((await event('arrive','a')).statusCode,201);assert.equal(f.trip.status,'En carga');
 assert.equal((await event('depart','a')).statusCode,409);
 assert.equal((await event('pickup','a',{load_id:9})).statusCode,201);
 const departure={kind:'depart',stop_key:'a',version:1,resource_version:0,event_key:'departure-stable'};
 assert.equal((await run('post','workflow/events',departure)).statusCode,201);assert.equal(f.trip.status,'En tránsito');
 assert.equal((await run('post','workflow/events',departure)).statusCode,200);
 assert.equal(f.events.filter(e=>e.event_key==='departure-stable').length,1);
 assert.equal((await event('arrive','b')).statusCode,201);assert.equal(f.trip.status,'Llegó a destino');
 const pod={load_id:9,client_submission_id:'pod',recipient_name:'Receptor',signature,resource_version:0,version:1};
 assert.equal((await run('post','deliveries',pod)).statusCode,409);
 assert.deepEqual((await run('get','allowed-statuses')).body.allowed_statuses,['Descargando']);
 assert.equal((await run('patch','status',{status:'Descargando'})).statusCode,200);
 assert.equal((await run('patch','status',{status:'Completado'})).statusCode,409);
 assert.equal((await run('post','deliveries',pod)).statusCode,201);assert.equal(f.trip.status,'Descargando');
 assert.equal((await run('get','allowed-statuses')).body.allowed_statuses.includes('Completado'),false);
 assert.equal((await event('depart','b')).statusCode,201);assert.equal(f.trip.status,'Descargando');
 assert.deepEqual((await run('get','allowed-statuses')).body.allowed_statuses,['Completado']);
 assert.equal((await run('patch','status',{status:'Completado'})).statusCode,200);
 assert.equal((await run('post','workflow/events',departure)).statusCode,200,'Un reintento confirmado no reabre el servicio');
 assert.equal(f.trip.status,'Completado');
 assert.equal(f.calls.some(c=>/update (trucks|operational_outings)/.test(c.sql)),false);
});
test('POD requiere recogida previa aun con llegada administrativa y descarga registradas',async()=>{
 const f=fixture({status:'Descargando'});f.events.push({kind:'depart',stop_key:'a',occurred_at:'2026-01-01'},{kind:'arrive',stop_key:'b',occurred_at:'2026-01-02'});
 await assert.rejects(validateDeliveryContext(f.db,f.trip,{},9),{code:'DELIVERY_PICKUP_REQUIRED'});
 f.events.push({kind:'pickup',load_id:9,stop_key:'a'});
 await validateDeliveryContext(f.db,f.trip,{},9);
 f.events.splice(1,1);
 await assert.rejects(validateDeliveryContext(f.db,f.trip,{},9),{code:'DELIVERY_STOP_PENDING'});
});
test('legacy exige cargar antes de traslado, sin obligar recogidas de itinerario inexistente',async()=>{
 const f=fixture({itinerary:false}),run=await harness(f);
 assert.deepEqual((await run('get','allowed-statuses')).body.allowed_statuses,['En carga']);
 assert.equal((await run('patch','status',{status:'En tránsito'})).statusCode,409);
 assert.equal((await run('patch','status',{status:'En carga'})).statusCode,200);
 assert.equal((await run('patch','status',{status:'En tránsito'})).statusCode,200);
 f.trip.status='Descargando';await validateDeliveryContext(f.db,f.trip,{},9);
});
test('aceptación y checklist vigentes controlan allowed-statuses y movimientos del móvil',async()=>{
 for(const options of [{accepted:false},{checked:false}]){
  const f=fixture(options),run=await harness(f),state=await driverSequence(f.db,f.trip,['En carga','En tránsito']);
  assert.equal(state.ready,false);assert.equal(state.allowed_statuses.includes('En tránsito'),false);
  assert.equal((await run('post','workflow/events',{kind:'arrive',stop_key:'a',version:1,resource_version:0,event_key:'arrival'})).statusCode,201);
  assert.equal((await run('post','workflow/events',{kind:'pickup',load_id:9,stop_key:'a',version:1,resource_version:0,event_key:'pickup'})).statusCode,201);
  assert.equal((await run('post','workflow/events',{kind:'depart',stop_key:'a',version:1,resource_version:0,event_key:'blocked'})).statusCode,409);
  assert.equal(f.events.some(e=>e.kind==='depart'),false);
 }
});
test('legacy no completa cargas pendientes y POD sólo acepta estado descarga',async()=>{
 const f=fixture({itinerary:false,status:'Descargando'}),run=await harness(f);
 assert.equal((await run('patch','status',{status:'Completado'})).statusCode,409);
 for(const status of ['Asignado','En carga','En tránsito','Llegó a destino']){
  f.trip.status=status;await assert.rejects(validateDeliveryContext(f.db,f.trip,{},9),{code:'DELIVERY_UNLOADING_REQUIRED'});
 }
});
test('fallo al sincronizar historial revierte estado y evento de parada juntos',async()=>{
 const f=fixture({failOn:'insert into trip_status_history'}),run=await harness(f);
 const result=await run('post','workflow/events',{kind:'arrive',stop_key:'a',version:1,resource_version:0,event_key:'rollback'});
 assert.equal(result.statusCode,500);assert.equal(f.trip.status,'Asignado');assert.equal(f.events.length,0);
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
test('servicio completado sigue consultable con salida abierta aunque su histórico diverja',async()=>{
 const f=fixture({status:'Completado'}),run=await harness(f);f.cargo[0].weight_kg=200;
 const result=await run('get','allowed-statuses');assert.equal(result.statusCode,200);assert.deepEqual(result.body.allowed_statuses,[]);
});
test('itinerario activo obsoleto devuelve conflicto explícito al consultar acciones',async()=>{
 const f=fixture(),run=await harness(f);f.cargo[0].weight_kg=200;
 const result=await run('get','allowed-statuses');assert.equal(result.statusCode,409);assert.equal(result.body.code,'ITINERARY_STALE');
});
test('nueva carga hereda puntos del viaje sólo sin alternativas explícitas ni opt-out',async()=>{
 for(const input of [{},{inherit_trip_locations:false},{origin:'Otro origen'},{destination:'Otro destino'},{origin_location_id:11,destination_location_id:12}]){
  const calls=[],routes=[];let created;
  const db={release(){},async query(sql,v=[]){
   calls.push({sql,v});
   if(sql.includes('from trips t'))return {rows:[{id:7,company_id:10,origin_location_id:1,destination_location_id:2}]};
   if(sql.includes('from clients'))return {rows:[{id:2}],rowCount:1};
   if(sql.startsWith('insert into trip_loads')){created={id:9,trip_id:7,origin:v[7],destination:v[8]};return {rows:[created]};}
   if(sql.includes('from operational_locations'))return {rows:v[1].map(id=>({id,name:'Punto '+id}))};
   if(sql.startsWith('update trip_loads'))return {rows:[{...created,origin_location_id:v[0],destination_location_id:v[1],origin:v[2],destination:v[3]}]};
   return {rows:[]};
  }};
  const app={};for(const method of ['get','post','patch'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
  await registerOperationsRoutes(app,{query:db.query.bind(db),connect:async()=>db});
  const handler=routes.find(r=>r.method==='post'&&r.path==='/api/operations/trips/:id/loads').handlers.at(-1);
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;},sendStatus(n){this.statusCode=n;return this;}};
  await handler({user:{...user,role_code:'company_admin'},params:{id:'7'},body:{client_id:2,cargo:'Carga',...input}},res);
  assert.equal(res.statusCode,201,JSON.stringify(input));
  const bound=calls.find(c=>c.sql.startsWith('update trip_loads'));
  if(!Object.keys(input).length)assert.deepEqual(bound.v.slice(0,2),[1,2]);
  else if(input.origin_location_id)assert.deepEqual(bound.v.slice(0,2),[11,12]);
  else assert.equal(bound,undefined,'No debe sustituir puntos alternativos ni ignorar opt-out');
 }
});
