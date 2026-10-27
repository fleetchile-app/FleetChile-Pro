'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup');
const {registerFleetRoutes}=require('../fleet-api');
const {registerCoreRoutes}=require('../core-api');
const {registerOperationsRoutes}=require('../operations-api');
const {assertTripResourcesReady}=require('../trip-eligibility');
const {assertTripAvailability}=require('../trip-availability');
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8'),CAT='/api/fleet/compositions',RES='/api/operations/trips/:id/resources';

test('PL14/15 PostgreSQL aislado: composiciones, reservas, reemplazos, GPS e historial inmutable',
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
   return {cid:c.id,main,trailer,d,client,actor:{id:user.id,name:'Operador fixture',company_id:c.id,actor_type:'company',scope:'company',membership_id:1,permissions:['fleet.manage','trips.manage','gps.read','maintenance.manage','dashboard.read','drivers.manage']}};
  }
  async function trip(f,extra={}){return one(`insert into trips(company_id,trip_number,client_id,origin,destination,planned_departure,planned_arrival,status)
   values($1,$2,$3,'Origen','Destino',$4,$5,$6) returning *`,[f.cid,'EQ-TRIP-'+ ++serial,f.client.id,extra.departure||'2026-11-01T08:00:00Z',extra.arrival||'2026-11-01T18:00:00Z',extra.status||'Planificado']);}
  async function composition(f,extra={}){const r=await run(f,'post',CAT,{name:'Conjunto fixture',truck_id:f.main.id,trailer_id:f.trailer.id,valid_from:'2000-01-01T00:00:00Z',...extra});assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;}
  const desired=(f,trip,c,extra={})=>({resource_version:trip.resource_version,composition_id:c?.id||null,...(c?{composition_version:c.version}:{truck_id:f.main.id,trailer_id:f.trailer.id}),driver_id:f.d.d.id,client_id:f.client.id,route_id:null,...extra});
  const assign=(f,t,c,extra={})=>run(f,'patch',RES,desired(f,t,c,extra),{id:t.id});

  await t.test('migración idempotente no inventa composición o historia pasada',async()=>{
   const f=await fixture(),t=await trip(f);await pg.exec(source('migrations/034_fleet_compositions_assignments.sql'));
   const row=await one('select trailer_id,composition_id,resource_version from trips where id=$1',[t.id]);assert.equal(row.resource_version,0);assert.equal(row.trailer_id,null);assert.equal(row.composition_id,null);
   assert.equal((await one('select count(*)::int n from trip_resource_revisions')).n,0);
  });
  await t.test('catálogo versionado y aislado, capacidad del acoplado, revisiones inmutables',async()=>{
   const f=await fixture(),other=await fixture(),c=await composition(f);assert.equal(c.snapshot.capacity_t,15);
   let r=await run(other,'patch',CAT+'/:id',{version:1,active:false,reason:'Ajeno'},{id:c.id});assert.equal(r.statusCode,404);
   r=await run(f,'patch',CAT+'/:id',{version:1,name:'Conjunto actualizado',reason:'Nombre comercial'},{id:c.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.version,2);
   r=await run(f,'patch',CAT+'/:id',{version:1,name:'Pantalla antigua',reason:'Obsoleta'},{id:c.id});assert.equal(r.statusCode,409);
   const history=await run(f,'get',CAT+'/:id/history',{}, {id:c.id});assert.equal(history.payload.rows.length,2);assert.equal(history.payload.rows[1].snapshot.name,'Conjunto fixture');
   await assert.rejects(query("update fleet_composition_revisions set reason='Cambiar' where composition_id=$1",[c.id]),/inmutables/i);
   const foreign=await run(f,'post',CAT,{name:'Ajeno',truck_id:other.main.id,valid_from:'2000-01-01T00:00:00Z'});assert.equal(foreign.statusCode,403);
  });
  await t.test('conductor y ambos vehículos se asignan; remolque reservado no puede usarse por otro viaje',async()=>{
   const f=await fixture(),c=await composition(f),t=await trip(f);let r=await assign(f,t,c);assert.equal(r.statusCode,200,JSON.stringify(r.payload));const assigned=r.payload.trip;
   assert.equal(assigned.status,'Asignado');assert.equal(assigned.trailer_id,f.trailer.id);assert.equal(assigned.resource_version,1);assert.equal(assigned.composition_snapshot.capacity_t,15);
   const another=await trip(f),main2=await truck(f.cid),driver2=await driver(f.cid),g={...f,main:main2,d:driver2};r=await assign(g,another,null);assert.equal(r.statusCode,409,JSON.stringify(r.payload));assert.match(r.payload.error,/reservad/);
   assert.equal((await one('select resource_version from trips where id=$1',[another.id])).resource_version,0);
   await assertTripAvailability(pool,{companyId:f.cid,truckId:main2.id,driverId:driver2.d.id,trailerId:f.trailer.id,plannedDeparture:'2026-11-02T08:00:00Z',plannedArrival:'2026-11-02T18:00:00Z'});
   await assertTripResourcesReady(pool,{companyId:f.cid,truckId:f.main.id,trailerId:f.trailer.id,driverId:f.d.d.id,tripId:assigned.id,plannedDeparture:assigned.planned_departure,plannedArrival:assigned.planned_arrival});
  });
  await t.test('reservas históricas terminan en el relevo y no inmovilizan los recursos retirados',async()=>{
   const f=await fixture(),p=await trip(f,{departure:'2026-11-01T08:00:00Z',arrival:'2026-11-01T18:00:00Z'}),next=await truck(f.cid);
   await query('update trips set truck_id=$1,resource_version=2 where id=$2',[next.id,p.id]);
   for(const [version,at,id] of [[1,'2026-11-01T08:00:00Z',f.main.id],[2,'2026-11-01T12:00:00Z',next.id]])await query(`insert into trip_resource_revisions(company_id,trip_id,version,effective_at,actor_name,reason,snapshot) values($1,$2,$3,$4,'Fixture','Relevo de prueba',$5)`,[f.cid,p.id,version,at,{truck:{id}}]);
   const check=(id,from,to)=>assertTripAvailability(pool,{companyId:f.cid,truckId:id,plannedDeparture:from,plannedArrival:to});
   await assert.rejects(check(f.main.id,'2026-11-01T10:00:00Z','2026-11-01T11:00:00Z'),{code:'TRIP_RESOURCE_CONFLICT'});
   await check(f.main.id,'2026-11-01T12:00:00Z','2026-11-01T18:00:00Z');
   await check(next.id,'2026-11-01T08:00:00Z','2026-11-01T12:00:00Z');
   await assert.rejects(check(next.id,'2026-11-01T12:00:00Z','2026-11-01T18:00:00Z'),{code:'TRIP_RESOURCE_CONFLICT'});
   await assertTripAvailability(pool,{companyId:f.cid,truckId:f.main.id,plannedDeparture:'2026-11-01T08:00:00Z',plannedArrival:'2026-11-01T18:00:00Z',effectiveFrom:'2026-11-01T12:00:00Z'});
  });
  await t.test('documentos o mantención del remolque impiden asignar y reanudar desde todas las vías',async()=>{
   const f=await fixture(),c=await composition(f),t=await trip(f);
   await query("update vehicle_documents set expires_at='2000-01-01' where truck_id=$1 and road_requirement_code='soap'",[f.trailer.id]);
   let r=await assign(f,t,c);assert.equal(r.statusCode,409,JSON.stringify(r.payload));
   await query("update vehicle_documents set expires_at='2099-12-31' where truck_id=$1",[f.trailer.id]);
   r=await assign(f,t,c);assert.equal(r.statusCode,200);const a=r.payload.trip;
   await query("insert into maintenance(company_id,truck_id,item,status) values($1,$2,'Reparación acoplado','En proceso')",[f.cid,f.trailer.id]);
   for(const p of ['/api/trips/:id/status','/api/operations/trips/:id/status']){r=await run(f,'patch',p,{status:'En tránsito'},{id:a.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));}
   r=await run(f,'patch','/api/driver/trips/:id/status',{status:'En tránsito'},{id:a.id});assert.equal(r.statusCode,403);
   const df={...f,actor:{id:f.d.u.id,name:f.d.d.name,company_id:f.cid,driver_id:f.d.d.id,role_code:'driver'}};
   r=await run(df,'patch','/api/driver/trips/:id/status',{status:'En tránsito'},{id:a.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));
   r=await run(f,'patch','/api/operations/trips/:id/status',{status:'Detenido'},{id:a.id});assert.equal(r.statusCode,200);
  });
  await t.test('reemplazo exige motivo/version, conserva fotografías/POD/cargas y no expone el viaje al conductor anterior',async()=>{
   const f=await fixture(),c=await composition(f),t=await trip(f);let r=await assign(f,t,c);let a=r.payload.trip;
   const load=await one("insert into trip_loads(trip_id,client_id,cargo) values($1,$2,'Madera') returning id",[a.id,f.client.id]);
   const proof=await one("insert into trip_delivery_proofs(trip_id,load_id,recipient_name,created_by) values($1,$2,'Receptor', $3) returning id",[a.id,load.id,f.d.u.id]);
   const file=await one("insert into delivery_proof_files(proof_id,type,storage_key,mime_type,size,sha256,created_by) values($1,'signature','equipment-fixture/signature.png','image/png',10,$2,$3) returning *",[proof.id,'a'.repeat(64),f.d.u.id]);
   r=await run(f,'patch','/api/operations/trips/:id/status',{status:'En tránsito'},{id:a.id});assert.equal(r.statusCode,200);a=r.payload;
   const main2=await truck(f.cid),trailer2=await truck(f.cid,'Remolque',8),d2=await driver(f.cid),g={...f,main:main2,trailer:trailer2,d:d2};
   r=await assign(g,a,null);assert.equal(r.statusCode,400);r=await assign(g,a,null,{reason:'Falla mecánica y relevo autorizado'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));const next=r.payload.trip;
   assert.equal(next.resource_version,2);assert.equal(next.status,'En tránsito');
   r=await assign(f,a,c,{reason:'Pantalla obsoleta'});assert.equal(r.statusCode,409);
   r=await run(f,'patch','/api/operations/trips/:id/assign',{truck_id:f.main.id,driver_id:f.d.d.id,client_id:f.client.id,reason:'Legacy'},{id:a.id});assert.equal(r.statusCode,409);assert.equal(r.payload.code,'VERSIONED_RESOURCES_REQUIRED');
   assert.equal((await one('select trip_id from trip_loads where id=$1',[load.id])).trip_id,a.id);
   assert.equal((await one('select created_by from trip_delivery_proofs where trip_id=$1',[a.id])).created_by,f.d.u.id);
   const unchanged=await one('select storage_key,sha256,created_by from delivery_proof_files where id=$1',[file.id]);assert.equal(unchanged.storage_key,file.storage_key);assert.equal(unchanged.sha256,file.sha256);assert.equal(unchanged.created_by,file.created_by);
   const history=await run(f,'get',RES,{}, {id:a.id});assert.equal(history.payload.history.length,3);
   const first=history.payload.history.find(h=>h.version===1);assert.equal(first.snapshot.truck.patente,f.main.patente);assert.equal(first.snapshot.driver.name,f.d.d.name);
   assert.equal(history.payload.history.find(h=>h.version===0).effective_at,null);
   await assert.rejects(query('delete from trip_resource_revisions where trip_id=$1',[a.id]),/inmutables/i);
   await assert.rejects(query('update trips set driver_id=$1 where id=$2',[f.d.d.id,a.id]),/asignación auditada/i);
   const previousDriver={...f,actor:{id:f.d.u.id,company_id:f.cid,driver_id:f.d.d.id,role_code:'driver'}};
   r=await run(previousDriver,'get','/api/driver/trips/:id',{}, {id:a.id});assert.equal(r.statusCode,404);
   const newDriver={...g,actor:{id:d2.u.id,company_id:f.cid,driver_id:d2.d.id,role_code:'driver'}};
   r=await run(newDriver,'get','/api/driver/trips/:id',{}, {id:a.id});assert.equal(r.statusCode,200);assert.equal(r.payload.composition_snapshot.trailer.patente,trailer2.patente);
   r=await run(f,'get','/api/fleet/drivers/:id',{}, {id:f.d.d.id});assert.equal(r.statusCode,200);assert.equal(r.payload.trips.find(t=>String(t.id)===String(a.id)).currently_assigned,false);
   r=await run(f,'get','/api/fleet/drivers/:id/pdf',{}, {id:f.d.d.id});assert.equal(r.statusCode,200);
  });
  await t.test('editar o desactivar catálogo no muta un viaje; nuevas selecciones controlan versión y vigencia',async()=>{
   const f=await fixture(),c=await composition(f),t=await trip(f);let r=await assign(f,t,c);assert.equal(r.statusCode,200);const a=r.payload.trip;
   const newTrailer=await truck(f.cid,'Remolque',20);r=await run(f,'patch',CAT+'/:id',{version:1,trailer_id:newTrailer.id,active:false,reason:'Reconfiguración para próximos servicios'},{id:c.id});assert.equal(r.statusCode,200);
   const stored=await one('select trailer_id,composition_snapshot from trips where id=$1',[a.id]);assert.equal(stored.trailer_id,f.trailer.id);assert.equal(stored.composition_snapshot.composition_version,1);
   const newTrip=await trip(f);r=await assign(f,newTrip,c);assert.equal(r.statusCode,409);
   r=await run(f,'patch','/api/operations/trips/:id/status',{status:'Cancelado'},{id:a.id});assert.equal(r.statusCode,200);
   const limited=await composition(f,{name:'Conjunto limitado',valid_from:'2090-01-01T00:00:00Z'});r=await assign(f,newTrip,limited);assert.equal(r.statusCode,409);assert.equal(r.payload.code,'COMPOSITION_OUTSIDE_WINDOW');
  });
  await t.test('ingreso a taller también detecta viaje en ejecución cuando el activo es el remolque',async()=>{
   const f=await fixture(),t=await trip(f);let r=await assign(f,t,null);assert.equal(r.statusCode,200);const a=r.payload.trip;
   r=await run(f,'patch','/api/operations/trips/:id/status',{status:'En tránsito'},{id:a.id});assert.equal(r.statusCode,200);
   r=await run(f,'post','/api/fleet/work-orders',{mode:'receive',truck_id:f.trailer.id,maintenance_type:'Correctiva',reason:'Acoplado',received_at:new Date().toISOString(),odometer_km:0});assert.equal(r.statusCode,409);
   await query('insert into telemetry(truck_id,trip_id,lat,lng) values($1,$2,-36,-73)',[f.main.id,a.id]);
   const main2=await truck(f.cid),g={...f,main:main2};r=await assign(g,a,null,{reason:'Reemplazo de tracto'});assert.equal(r.statusCode,200);
   r=await run(f,'get','/api/fleet/trucks/:id/position',{}, {id:f.main.id});assert.equal(r.statusCode,200);assert.equal(r.payload.associated_trip_id,null);
  });
  await t.test('fallo de auditoría revierte punteros, versión, historial y estado del viaje',async()=>{
   const f=await fixture(),t=await trip(f),c=await composition(f);
   await pg.exec("create function eq_fail() returns trigger as $$ begin if NEW.action='assign_resources' then raise exception 'fallo controlado'; end if; return NEW; end $$ language plpgsql; create trigger eq_fail before insert on audit_logs for each row execute function eq_fail();");
   try{const r=await assign(f,t,c);assert.ok(r.statusCode>=400);const old=await one('select * from trips where id=$1',[t.id]);assert.equal(old.resource_version,0);assert.equal(old.truck_id,null);assert.equal(old.status,'Planificado');
    assert.equal((await one('select count(*)::int n from trip_resource_revisions where trip_id=$1',[t.id])).n,0);
   }finally{await pg.exec('drop trigger eq_fail on audit_logs; drop function eq_fail();');}
   const denied={...f,actor:{...f.actor,permissions:[]}};assert.equal((await run(denied,'get',RES,{}, {id:t.id})).statusCode,403);
   const other=await fixture();assert.equal((await run(other,'get',RES,{}, {id:t.id})).statusCode,404);
  });
 }finally{await pg.close();}
});
