'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup');
const {registerFleetRoutes}=require('../fleet-api');
const {registerCoreRoutes}=require('../core-api');
const {registerOperationsRoutes}=require('../operations-api');
const {assertTripResourcesReady}=require('../trip-eligibility');
const {assertTripAvailability}=require('../trip-availability');
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8'),CAT='/api/fleet/compositions',RES='/api/operations/trips/:id/resources';

test('PL16–PL24 PostgreSQL aislado: itinerarios, capacidad, tiempos y excepciones',
 {skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),pg=new PGlite();
 const query=async(sql,v=[])=>{const r=await pg.query(sql,v);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const one=async(sql,v)=>(await query(sql,v)).rows[0],pool={query,connect:async()=>({query,release(){}})};
 let serial=0;
 try{
  await pg.exec(source('schema.sql'));await pg.exec(source('migrations/002_core_platform.sql'));
  for(const m of MIGRATION_FILES)await pg.exec(source('migrations/'+m));
  const role=await one("select id from roles where code='company_admin'"),driverRole=await one("select id from roles where code='driver'");
  const app={},routes=[];for(const m of ['get','post','patch','put','delete'])app[m]=(p,...h)=>routes.push({m,p,h});
  registerCoreRoutes(app,pool);await registerFleetRoutes(app,pool);await registerOperationsRoutes(app,pool);
  let routingFails=false;
  require('../itinerary-api').registerItineraryRoutes(app,pool,{async route(a,b){if(routingFails)throw Error('fixture proveedor caído');return {distance_meters:1000,duration_seconds:600,provider:'fixture-router',calculated_at:'2026-10-26T00:00:00Z',geometry:{type:'LineString',coordinates:[[a.lng,a.lat],[b.lng,b.lat]]}};}});
  async function run(f,method,p,body={},params={},filters={}){
   const r=routes.find(r=>r.m===method&&r.p===p);assert.ok(r,p);
   const req={user:f.actor,body,params,query:filters,ip:'127.0.0.1'};
   const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},set(k,v){this.headers[k]=v;return this;},send(v){this.payload=v;return this;},sendStatus(n){this.statusCode=n;return this;}};
   const next=async i=>{let pending;await r.h[i](req,res,()=>{pending=next(i+1);return pending;});if(pending)await pending;};await next(0);return res;
  }
  async function truck(cid,type='Tractocamión',capacity=null){
   const row=await one('insert into trucks(company_id,patente,tipo,capacidad_t) values($1,$2,$3,$4) returning *',[cid,'EQ'+ ++serial,type,capacity]);
   for(const label of ['Permiso de circulación','SOAP','Revisión técnica'])await query("insert into vehicle_documents(truck_id,document_type,expires_at,status) values($1,$2,'2099-12-31','Vigente')",[row.id,label]);return row;
  }
  async function driver(cid){
   const d=await one("insert into drivers(company_id,name,status,operational_registered_at) values($1,$2,'Activo',now()) returning *",[cid,'Conductor '+ ++serial]);
   const u=await one('insert into users(company_id,driver_id,role_id,name,email) values($1,$2,$3,$4,$5) returning *',[cid,d.id,driverRole.id,d.name,'driver-eq-'+serial+'@example.invalid']);
   const m=await one('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3) returning *',[cid,u.id,driverRole.id]);
   const body=String(10000000+serial);let sum=0,factor=2;for(const digit of [...body].reverse()){sum+=Number(digit)*factor;factor=factor===7?2:factor+1;}const mod=11-sum%11,dv=mod===11?'0':mod===10?'K':String(mod);
   const p=await one("insert into company_people(company_id,user_id,membership_id,driver_id,name,rut,birth_date) values($1,$2,$3,$4,$5,$6,'1990-01-01') returning *",[cid,u.id,m.id,d.id,d.name,body+'-'+dv]);
   await query("insert into person_contracts(company_id,person_id,type,start_date) values($1,$2,'indefinite','2000-01-01')",[cid,p.id]);
   await query("insert into person_driver_licenses(company_id,person_id,classes,printed_expiry,effective_expiry) values($1,$2,ARRAY['A5'],'2099-12-31','2099-12-31')",[cid,p.id]);return {d,u,m,p};
  }
  async function fixture(){
   const c=await one('insert into companies(legal_name) values($1) returning id',['Equipos fixture '+ ++serial]);
   const user=await one('insert into users(company_id,role_id,name,email) values($1,$2,$3,$4) returning id',[c.id,role.id,'Operador '+serial,'eq-'+serial+'@example.invalid']);
   const client=await one("insert into clients(company_id,name) values($1,'Cliente fixture') returning id",[c.id]);
   const main=await truck(c.id),trailer=await truck(c.id,'Semirremolque',15),d=await driver(c.id);
   return {cid:c.id,main,trailer,d,client,actor:{id:user.id,name:'Operador fixture',company_id:c.id,actor_type:'company',scope:'company',membership_id:1,permissions:['fleet.manage','trips.manage','loads.manage','gps.read','maintenance.manage','dashboard.read','drivers.manage']}};
  }
  async function trip(f,extra={}){return one(`insert into trips(company_id,trip_number,client_id,origin,destination,planned_departure,planned_arrival,status)
   values($1,$2,$3,'Origen','Destino',$4,$5,$6) returning *`,[f.cid,'EQ-TRIP-'+ ++serial,f.client.id,extra.departure||'2026-11-01T08:00:00Z',extra.arrival||'2026-11-01T18:00:00Z',extra.status||'Planificado']);}
  async function composition(f,extra={}){const r=await run(f,'post',CAT,{name:'Conjunto fixture',truck_id:f.main.id,trailer_id:f.trailer.id,valid_from:'2000-01-01T00:00:00Z',...extra});assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;}
  const desired=(f,trip,c,extra={})=>({resource_version:trip.resource_version,composition_id:c?.id||null,...(c?{composition_version:c.version}:{truck_id:f.main.id,trailer_id:f.trailer.id}),driver_id:f.d.d.id,client_id:f.client.id,route_id:null,...extra});

  const assign=(f,t,c,extra={})=>run(f,'patch',RES,desired(f,t,c,extra),{id:t.id});
  const IT='/api/operations/trips/:id/itinerary';
  async function scenario(){
   const f=await fixture();await query('update trucks set capacidad_t=10 where id=$1',[f.trailer.id]);
   const p=await trip(f),assigned=await assign(f,p,null);assert.equal(assigned.statusCode,200,JSON.stringify(assigned.payload));f.trip=assigned.payload.trip;
   f.locations=[];for(let i=0;i<4;i++)f.locations.push(await one("insert into operational_locations(company_id,name,lat,lng,source,normalized_at) values($1,$2,$3,$4,'fixture',now()) returning *",[f.cid,'Lugar fixture '+i,-36+i*.1,-73+i*.1]));
   f.loads=[];for(const [i,weight] of [4000,3000,3000].entries())f.loads.push(await one("insert into trip_loads(trip_id,client_id,cargo,weight_kg) values($1,$2,$3,$4) returning *",[f.trip.id,f.client.id,'Carga fixture '+i,weight]));
   f.body={version:0,resource_version:f.trip.resource_version,departure:'2026-11-01T08:00:00Z',contingency_minutes:10,reason:'Plan multientrega fixture',vehicle_review:{acknowledged:true,notes:'Revisión operacional fixture, no certificación legal'},
    stops:f.locations.map((l,i)=>({key:'s'+i,location_id:Number(l.id),purpose:i?'delivery':'pickup',service_minutes:10,wait_minutes:5,rest_minutes:0})),
    loads:f.loads.map((l,i)=>({load_id:Number(l.id),pickup:'s0',delivery:'s'+(i+1)}))};return f;
  }
  const save=(f,extra={})=>run(f,'put',IT,{...f.body,...extra},{id:f.trip.id});
  const event=(f,kind,stop='s0',extra={})=>run(f,'post',IT+'/events',{version:1,event_key:'event-'+ ++serial,kind,stop_key:stop,...extra},{id:f.trip.id});

  await t.test('migración idempotente; no fabrica planes para viajes existentes',async()=>{
   const f=await scenario();await pg.exec(source('migrations/035_trip_itineraries.sql'));
   assert.equal((await one('select itinerary_version from trips where id=$1',[f.trip.id])).itinerary_version,0);
  });
  await t.test('viaje con tres entregas conserva clientes, tiempos de proveedor y capacidad por tramo',async()=>{
   const f=await scenario(),r=await save(f);assert.equal(r.statusCode,200,JSON.stringify(r.payload));const p=r.payload.plan;
   assert.equal(p.distance_meters,3000);assert.equal(p.driving_seconds,1800);assert.equal(p.stop_seconds,3600);assert.equal(p.total_seconds,6000);
   assert.deepEqual(p.capacity.segments.map(s=>s.weight_kg),[10000,6000,3000]);
   const state=await run(f,'get',IT,{}, {id:f.trip.id});assert.equal(state.statusCode,200);assert.equal(state.payload.progress.length,4);assert.equal(state.payload.eta.state,'stale_gps');
   const stored=await one('select * from trips where id=$1',[f.trip.id]);assert.equal(Number(stored.distance_km),3);assert.equal(stored.itinerary_version,1);
   assert.equal((await one('select count(*)::int n from trip_delivery_proofs where trip_id=$1',[f.trip.id])).n,0);
   await assert.rejects(query('update trips set planned_arrival=planned_arrival+interval \'1 hour\' where id=$1',[f.trip.id]),/itinerario auditado/i);
   await assert.rejects(query("update trip_itinerary_revisions set reason='No permitido' where trip_id=$1",[f.trip.id]),/inmutables/);
  });
  await t.test('sobrecarga, ubicación ajena, revisión ausente y caída de proveedor no dejan escrituras parciales',async()=>{
   const f=await scenario(),other=await scenario();await query('update trip_loads set weight_kg=6000 where id=$1',[f.loads[0].id]);
   let r=await save(f);assert.equal(r.statusCode,409);assert.equal(r.payload.code,'ITINERARY_OVERLOAD');
   await query('update trip_loads set weight_kg=4000 where id=$1',[f.loads[0].id]);
   const bad=structuredClone(f.body);bad.stops[0].location_id=Number(other.locations[0].id);r=await save(f,bad);assert.equal(r.statusCode,403);
   r=await save(f,{vehicle_review:{acknowledged:false,notes:'No'}});assert.equal(r.statusCode,400);
   routingFails=true;r=await save(f);routingFails=false;assert.equal(r.statusCode,502);
   assert.equal((await one('select itinerary_version from trips where id=$1',[f.trip.id])).itinerary_version,0);
   assert.equal((await one('select count(*)::int n from trip_itinerary_revisions where trip_id=$1',[f.trip.id])).n,0);
  });
  await t.test('versiones obsoletas y fallo de auditoría revierten cabecera e historial',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);
   let r=await save(f);assert.equal(r.statusCode,409);
   await pg.exec("create function fail_it_audit() returns trigger as $$ begin if NEW.entity='trip_itinerary' then raise exception 'fixture audit failure'; end if; return NEW; end; $$ language plpgsql; create trigger it_fail_audit before insert on audit_logs for each row execute function fail_it_audit();");
   try{r=await save(f,{version:1,reason:'Plan nuevo',contingency_minutes:20});assert.equal(r.statusCode,500);}finally{await pg.exec('drop trigger it_fail_audit on audit_logs; drop function fail_it_audit();');}
   assert.equal((await one('select itinerary_version from trips where id=$1',[f.trip.id])).itinerary_version,1);
   assert.equal((await one('select count(*)::int n from trip_itinerary_revisions where trip_id=$1',[f.trip.id])).n,1);
  });
  await t.test('llegadas y salidas ordenadas; reintento idempotente; fallida y parcial no entregan otras cargas',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);
   assert.equal((await event(f,'depart')).statusCode,409);
   const b={version:1,event_key:'retry-event',kind:'arrive',stop_key:'s0'};
   let r=await run(f,'post',IT+'/events',b,{id:f.trip.id});assert.equal(r.statusCode,201);
   r=await run(f,'post',IT+'/events',b,{id:f.trip.id});assert.equal(r.statusCode,200);
   assert.equal((await event(f,'depart')).statusCode,201);assert.equal((await event(f,'arrive','s1')).statusCode,201);
   r=await event(f,'failed','s1',{load_id:Number(f.loads[0].id),reason:'Receptor ausente'});assert.equal(r.statusCode,201);
   r=await event(f,'partial','s1',{load_id:Number(f.loads[0].id),reason:'Entrega parcial',delivered_kg:1000});assert.equal(r.statusCode,201);
   r=await event(f,'partial','s1',{load_id:Number(f.loads[0].id),reason:'Exceso',delivered_kg:3500});assert.equal(r.statusCode,400);
   const rows=(await query('select status,delivered_at from trip_loads where trip_id=$1',[f.trip.id])).rows;assert.ok(rows.every(l=>l.status!=='Entregada'&&!l.delivered_at));
   const moved=structuredClone(f.body);moved.stops[0].location_id=Number(f.locations[1].id);r=await save(f,{...moved,version:1,reason:'Intento de cambiar parada iniciada'});assert.equal(r.statusCode,409);
   await assert.rejects(query('delete from trip_itinerary_events where trip_id=$1',[f.trip.id]),/inmutables/);
   r=await event(f,'depart','s1');assert.equal(r.statusCode,409);
   const revised=structuredClone(f.body);revised.version=1;revised.loads[0].delivery='s3';revised.reason='Reprogramar saldo de entrega parcial';r=await save(f,revised);assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   assert.ok(r.payload.plan.impact.remaining_deliveries.find(l=>String(l.load_id)===String(f.loads[0].id)).delta_seconds>0);
   const after=await run(f,'get',IT,{}, {id:f.trip.id});assert.equal(after.payload.loads.find(l=>String(l.id)===String(f.loads[0].id)).remaining_kg,3000);assert.equal(after.payload.capacity.segments[1].weight_kg,9000);
   r=await event(f,'depart','s1',{version:2});assert.equal(r.statusCode,201);
  });
  await t.test('guard de activación detecta carga desactualizada y capacidad desconocida en API y PWA',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);
   await query('update trip_loads set weight_kg=0 where id=$1',[f.loads[0].id]);
   for(const p of ['/api/trips/:id/status','/api/operations/trips/:id/status']){const r=await run(f,'patch',p,{status:'En tránsito'},{id:f.trip.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));assert.equal(r.payload.code,'ITINERARY_STALE');}
   let r=await save(f,{version:1});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   const df={...f,actor:{id:f.d.u.id,company_id:f.cid,driver_id:f.d.d.id,role_code:'driver'}};
   r=await run(df,'patch','/api/driver/trips/:id/status',{status:'En tránsito'},{id:f.trip.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));assert.equal(r.payload.code,'ITINERARY_CAPACITY_UNKNOWN');
   r=await run(f,'patch','/api/operations/trips/:id/status',{status:'Detenido'},{id:f.trip.id});assert.equal(r.statusCode,200);
  });
  await t.test('reemplazo verifica capacidad y exige nueva revisión operacional sin borrar el plan previo',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);const a=await one('select * from trips where id=$1',[f.trip.id]),newTrailer=await truck(f.cid,'Semirremolque',8),g={...f,trailer:newTrailer};
   let r=await assign(g,a,null,{reason:'Reemplazo fixture',itinerary_review:{acknowledged:true,notes:'Revisión fixture'}});assert.equal(r.statusCode,409);assert.equal(r.payload.code,'ITINERARY_OVERLOAD');
   await query('update trucks set capacidad_t=12 where id=$1',[newTrailer.id]);
   r=await assign(g,a,null,{reason:'Reemplazo sin revisión'});assert.equal(r.statusCode,409);assert.equal(r.payload.code,'ITINERARY_REVIEW_REQUIRED');
   r=await assign(g,a,null,{reason:'Reemplazo revisado',itinerary_review:{acknowledged:true,notes:'Altura, peso y accesos revisados para equipo nuevo'}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.trip.itinerary_version,2);
   const history=(await query('select plan from trip_itinerary_revisions where trip_id=$1 order by version',[f.trip.id])).rows;assert.equal(history.length,2);assert.equal(history[0].plan.vehicle.capacity_t,10);assert.equal(history[1].plan.vehicle.capacity_t,12);
  });
  await t.test('un reemplazo después de descargar conserva capacidad histórica y verifica sólo los tramos pendientes con el equipo nuevo',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);
   assert.equal((await event(f,'arrive')).statusCode,201);assert.equal((await event(f,'depart')).statusCode,201);assert.equal((await event(f,'arrive','s1')).statusCode,201);
   await query("update trip_loads set status='Entregada',delivered_at=now() where id=$1",[f.loads[0].id]);
   const a=await one('select * from trips where id=$1',[f.trip.id]),newTrailer=await truck(f.cid,'Semirremolque',8),g={...f,trailer:newTrailer};
   const r=await assign(g,a,null,{reason:'Cambio después de primera descarga',itinerary_review:{acknowledged:true,notes:'Revisión de restricciones fixture'}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   const state=await run(f,'get',IT,{}, {id:f.trip.id});assert.deepEqual(state.payload.capacity.segments.map(s=>s.capacity_kg),[10000,8000,8000]);assert.equal(state.payload.capacity.overloaded,false);
  });
  await t.test('transferencia conserva historial del origen y deja las cargas del destino para su planificación explícita',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);const to=await trip(f),load=f.loads[0];
   const r=await run(f,'post','/api/operations/trips/:id/loads/:loadId/transfer',{target_trip_id:Number(to.id),reason:'Entrega en otro servicio'},{id:Number(f.trip.id),loadId:Number(load.id)});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   const state=await run(f,'get',IT,{}, {id:f.trip.id});assert.equal(state.statusCode,200);assert.equal(state.payload.version,2);assert.equal(state.payload.stale_loads,false);assert.equal(state.payload.revision.plan.loads.length,2);
   const original=await one('select plan from trip_itinerary_revisions where trip_id=$1 and version=1',[f.trip.id]);assert.equal(original.plan.loads.length,3);
  });
  await t.test('no permite completar el servicio con paradas y cargas pendientes, por ninguna API de estados',async()=>{
   const f=await scenario();assert.equal((await save(f)).statusCode,200);
   for(const p of ['/api/trips/:id/status','/api/operations/trips/:id/status']){const r=await run(f,'patch',p,{status:'Completado'},{id:f.trip.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));assert.equal(r.payload.code,'ITINERARY_PENDING');}
  });
  await t.test('API directa niega otra empresa y conductor sin trips.manage',async()=>{
   const f=await scenario(),other=await scenario();assert.equal((await run(other,'get',IT,{}, {id:f.trip.id})).statusCode,404);
   const df={...f,actor:{id:f.d.u.id,company_id:f.cid,driver_id:f.d.d.id,role_code:'driver'}};
   assert.equal((await run(df,'get',IT,{}, {id:f.trip.id})).statusCode,403);
  });
 }finally{await pg.close();}
});

