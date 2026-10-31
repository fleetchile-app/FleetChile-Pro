'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {registerOperationalOutings}=require('../operational-outings');
const {assertTripAvailability}=require('../trip-availability');
let PGlite;
try{({PGlite}=require('@electric-sql/pglite'));}catch{
 try{({PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE||process.env.FLEETCHILE_PGLITE_MODULE||'D:/flota-adm/.fleetchile-test-runtime/node_modules/@electric-sql/pglite'));}catch{}
}
const admin={id:1,actor_type:'legacy',scope:'company',company_id:1,role_code:'admin'};
const driver={id:1,actor_type:'company',scope:'company',company_id:1,driver_id:1,role_code:'driver'};
test('salidas operacionales: PostgreSQL aislado, ciclo, alcance y reservas',{skip:!PGlite},async t=>{
 const db=new PGlite();
 try{
 await db.exec(`
 CREATE TABLE companies(id bigint PRIMARY KEY,commercial_enforced boolean DEFAULT false);
 CREATE TABLE users(id bigint PRIMARY KEY,company_id bigint,driver_id integer);
 CREATE TABLE drivers(id integer PRIMARY KEY,company_id bigint,name text,UNIQUE(company_id,id));
 CREATE TABLE trucks(id integer PRIMARY KEY,company_id bigint,patente text,tipo text DEFAULT 'Tractocamión',capacidad_t numeric,UNIQUE(company_id,id));
 CREATE TABLE user_memberships(id bigint PRIMARY KEY,company_id bigint,user_id bigint);
 CREATE TABLE company_people(id bigint PRIMARY KEY,company_id bigint,driver_id integer);
 CREATE TABLE operational_locations(id bigint PRIMARY KEY,company_id bigint,name text);
 CREATE TABLE trips(id integer PRIMARY KEY,company_id bigint,truck_id integer,driver_id integer,trailer_id integer,
  trip_number text,status text,origin text,destination text,origin_location_id bigint,destination_location_id bigint,
  planned_departure timestamptz,planned_arrival timestamptz,actual_departure timestamptz,resource_version integer DEFAULT 0,commercial_modules jsonb,
  client_id bigint,route_id bigint,composition_id bigint,composition_snapshot jsonb,itinerary_version integer DEFAULT 0,updated_at timestamptz,revenue_clp numeric DEFAULT 0,
  UNIQUE(company_id,id));
 CREATE TABLE trip_resource_revisions(id bigserial,company_id bigint,trip_id integer,version integer,effective_at timestamptz,snapshot jsonb,actor_user_id bigint,actor_name text,reason text,baseline_observation boolean DEFAULT false);
 CREATE TABLE trip_status_history(id bigserial,trip_id integer,from_status text,to_status text,notes text,created_by bigint);
 CREATE TABLE trip_events(id bigserial,trip_id integer,event_type text,notes text,created_by bigint,details jsonb);
 CREATE TABLE alerts(company_id bigint,source_type text,source_id bigint,condition_code text,resolved boolean,resolved_at timestamptz,resolution_note text);
 CREATE TABLE telemetry(id bigserial PRIMARY KEY,truck_id integer,trip_id bigint,lat numeric,lng numeric,speed_kmh numeric,km integer,recorded_at timestamptz);
 CREATE TABLE audit_logs(id bigserial PRIMARY KEY,company_id bigint,user_id bigint,action text,entity text,entity_id text,before_data jsonb,after_data jsonb,ip text);
 CREATE TABLE commercial_equipment_seats(company_id bigint,truck_id integer,active boolean,PRIMARY KEY(company_id,truck_id));
 CREATE TABLE maintenance(id integer PRIMARY KEY,company_id bigint,truck_id integer,status text);
 CREATE TABLE fixture_contract(company_id bigint,configuration jsonb);
 CREATE FUNCTION commercial_current(cid bigint) RETURNS TABLE(configuration jsonb) AS $$ SELECT configuration FROM fixture_contract WHERE company_id=cid $$ LANGUAGE sql;
 CREATE FUNCTION commercial_require(cid bigint,feature text,unit integer) RETURNS void AS $$ BEGIN
  IF (SELECT commercial_enforced FROM companies WHERE id=cid) AND
    (NOT EXISTS(SELECT 1 FROM fixture_contract WHERE company_id=cid AND configuration->'modules' ? feature)
     OR NOT EXISTS(SELECT 1 FROM commercial_equipment_seats WHERE company_id=cid AND truck_id=unit AND active)) THEN
    RAISE EXCEPTION USING ERRCODE='P7503',MESSAGE='No contratado'; END IF;
 END $$ LANGUAGE plpgsql;
 INSERT INTO companies VALUES(1,false),(2,false);
 INSERT INTO users VALUES(1,1,1);
 INSERT INTO drivers(id,company_id) VALUES(1,1),(2,2);
 INSERT INTO trucks(id,company_id) VALUES(1,1),(2,1),(3,2),(4,1);
 UPDATE trucks SET tipo='Semirremolque' WHERE id=2;
 INSERT INTO operational_locations VALUES(1,1,'Base'),(2,1,'Origen'),(3,1,'Destino'),(4,2,'Otra empresa');
 INSERT INTO commercial_equipment_seats VALUES(1,1,true),(1,2,true);
 INSERT INTO trips(id,company_id,truck_id,driver_id,trailer_id,trip_number,status,origin,destination,origin_location_id,destination_location_id,planned_departure,planned_arrival)
 VALUES(1,1,1,1,2,'V1','Asignado','Origen','Destino',2,3,'2026-01-01','2026-01-02'),
 (2,1,1,1,2,'V2','Planificado','Destino','Origen',3,2,'2026-02-01','2026-02-02'),
 (3,1,1,1,2,'V3','Planificado','Origen','Destino',2,3,'2027-01-01','2027-01-02'),
 (4,2,3,2,null,'Privado','Asignado','Otro','Otro',4,4,'2026-01-01','2026-01-02');
 `);
 await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/052_operational_outings.sql'),'utf8'));
 // Reapply safely; no historical trip gets an outing.
 await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/052_operational_outings.sql'),'utf8'));
 assert.equal((await db.query('select count(*)::int n from operational_outings')).rows[0].n,0);
 const routes=new Map();const app={get(p,...h){routes.set('GET '+p,h);},post(p,...h){routes.set('POST '+p,h);}};
 let personnelCalls=0;
 registerOperationalOutings(app,{connect:async()=>({query:db.query.bind(db),release(){}})},{driverAccess(req,res){if(req.user.role_code==='driver')return true;res.status(403).json({error:'driver'});return false;},async enforceDriverPersonnel(){personnelCalls++;return true;},assertTripResourcesReady:assertTripAvailability});
 const base='/api/operations/trips/:id/outing',mobile='/api/driver/trips/:id/outing';
 async function call(method,url,body={},user=admin,id=1){
  const req={params:{id:String(id)},user,body,ip:'127.0.0.1'},res={statusCode:200,status(c){this.statusCode=c;return this;},json(payload){this.payload=payload;this.sent=true;return this;}};
  for(const h of routes.get(method+' '+url)){let next=false;await h(req,res,()=>{next=true;});if(res.sent||!next)break;}
  return res;
 }
 const action=(action,version,extra={})=>call('POST',base+'/action',{action,version,reason:'Motivo comprobable',...extra});
 await t.test('scope y permiso, base explícita y motivo',async()=>{
  assert.equal((await call('GET',base,{},admin,4)).statusCode,404);
  assert.equal((await call('GET',base,{}, {...admin,role_code:'operator',permissions:[]})).statusCode,403);
  assert.equal((await call('POST',base,{base_location_id:1})).statusCode,400);
  assert.equal((await call('POST',base,{reason:'Inicio'})).statusCode,400);
  assert.equal((await call('POST',base,{base_location_id:4,reason:'Inicio'})).statusCode,404);
  assert.equal((await call('GET',base)).payload.outing,null);
 });
 let created;
 await t.test('creación, snapshot UI y recursos reservados sin fecha',async()=>{
  const r=await call('POST',base,{base_location_id:1,reason:'Inicio'});assert.equal(r.statusCode,201,JSON.stringify(r.payload));created=r.payload.outing;
  assert.equal(String(created.base_location_id),'1');assert.equal(created.status,'in_service');assert.equal(created.commercial_modules,null);
  assert.equal(r.payload.services.length,1);assert.equal(r.payload.events[0].kind,'create');assert.equal(r.payload.locations.length,3);
  assert.equal((await call('POST',base,{base_location_id:1,reason:'Otra'})).statusCode,409);
  await assert.rejects(assertTripAvailability(db,{companyId:1,truckId:1,driverId:1,tripId:3,plannedDeparture:'2027-01-01',plannedArrival:'2027-01-02'}),e=>e.code==='TRIP_RESOURCE_CONFLICT');
  await assertTripAvailability(db,{companyId:1,truckId:1,driverId:1,tripId:1,plannedDeparture:'2026-01-01',plannedArrival:'2026-01-02'});
 });
 await t.test('no retorna mientras servicio abierto y no acepta versión obsoleta',async()=>{
  assert.equal((await action('return',created.version)).statusCode,409);
  await db.query("update trips set status='Completado' where id=1");
  assert.equal((await action('return',0)).payload.code,'OUTING_STALE');
  assert.equal((await action('return',1,{reason:''})).statusCode,400);
  assert.equal((await call('GET',base)).payload.outing.status,'in_service');
 });
 await t.test('triggers conservan recursos/cupos/taller tras finalizar servicio',async()=>{
  await assert.rejects(db.query('update trips set truck_id=4 where id=1'),e=>e.code==='P7503');
  await assert.rejects(db.query('update commercial_equipment_seats set active=false where truck_id=1'),e=>e.code==='P7503');
  await assert.rejects(db.query('delete from commercial_equipment_seats where truck_id=2'),e=>e.code==='P7503');
  await assert.rejects(db.query("insert into maintenance values(1,1,2,'En proceso')"),e=>e.code==='P7503');
 });
 await t.test('driver retorna, GPS valida y mantiene scope y no puede liberar',async()=>{
  const r=await call('POST',mobile+'/action',{action:'return',version:1,reason:'Regreso'},driver);assert.equal(r.statusCode,200,JSON.stringify(r.payload));
  assert.equal(r.payload.outing.status,'returning');assert.equal(r.payload.locations,undefined);assert.equal(r.payload.candidates,undefined);
  assert.equal((await call('POST',mobile+'/action',{action:'release',version:2,reason:'Fuera'},driver)).statusCode,403);
  assert.equal((await call('GET',mobile,{}, {...driver,driver_id:2})).statusCode,404);
  assert.equal((await call('POST',mobile+'/positions',{version:2,lat:'',lng:1,recorded_at:new Date().toISOString()},driver)).statusCode,400);
  assert.equal((await call('POST',mobile+'/positions',{version:1,lat:-33,lng:-70,recorded_at:new Date().toISOString()},driver)).payload.code,'OUTING_STALE');
  const gps=await call('POST',mobile+'/positions',{version:2,lat:-33,lng:-70,accuracy_m:5,recorded_at:new Date().toISOString()},driver);assert.equal(gps.statusCode,200,JSON.stringify(gps.payload));assert.equal(gps.payload.last_position.lat,-33);
  const telemetry=(await db.query('select * from telemetry')).rows[0];assert.equal(telemetry.trip_id,null);assert.equal(telemetry.speed_kmh,null);assert.equal(telemetry.km,null);assert.equal(String(telemetry.outing_id),String(created.id));
  assert.ok(personnelCalls>0);
 });
 await t.test('link respeta continuidad y asigna recursos versionados a un servicio pendiente',async()=>{
  assert.equal((await action('link',2,{next_trip_id:3})).payload.code,'OUTING_LOCATION_CONFLICT');
  // Normal creation leaves resources empty, so its reservation does not bypass the outing.
  await db.query('update trips set truck_id=null,driver_id=null,trailer_id=null where id=2');
  const r=await action('link',2,{next_trip_id:2});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.services.length,2);assert.equal(r.payload.outing.status,'in_service');
  assert.equal(r.payload.outing.suggested_origin_location_id,null);
  const next=(await db.query('select * from trips where id=2')).rows[0];assert.equal(next.status,'Asignado');assert.equal(next.resource_version,1);assert.equal(next.truck_id,1);assert.equal(next.driver_id,1);assert.equal(next.trailer_id,2);
  assert.equal((await db.query('select count(*)::int n from trip_resource_revisions where trip_id=2')).rows[0].n,2);
  assert.equal((await action('return',3)).statusCode,409);
 });
 let liveVersion=3;
 await t.test('no reactiva un servicio anterior, pero permite actualizar sus finanzas',async()=>{
  await assert.rejects(db.query("update trips set status='En carga' where id=1"),e=>e.code==='P7503');
  await db.query('update trips set revenue_clp=123 where id=1');
  const previous=(await db.query('select status,revenue_clp from trips where id=1')).rows[0];assert.equal(previous.status,'Completado');assert.equal(Number(previous.revenue_clp),123);
 });
 await t.test('reemplazo versionado del último servicio activo mueve reserva sin liberar salida',async()=>{
  await assert.rejects(db.query('update trips set truck_id=4,resource_version=2 where id=2'),e=>e.code==='P7503');
  await db.query('BEGIN');
  await db.query('update trips set truck_id=4,resource_version=2 where id=2');
  await db.query(`insert into trip_resource_revisions(company_id,trip_id,version,effective_at,actor_user_id,actor_name,reason,snapshot)
   values(1,2,2,clock_timestamp(),1,'Operador','Reemplazo por falla',$1)`,[{truck:{id:4},driver:{id:1},trailer:{id:2}}]);
  await db.query('COMMIT');
  const current=(await call('GET',base)).payload;assert.equal(current.outing.truck_id,4);assert.equal(current.outing.closed_at,null);assert.equal(current.outing.version,4);liveVersion=4;
  assert.equal(current.events.at(-1).kind,'resource_change');assert.equal(current.events.at(-1).reason,'Reemplazo por falla');
  await assert.rejects(db.query('update trips set truck_id=4,resource_version=1 where id=1'),e=>e.code==='P7503');
  await assertTripAvailability(db,{companyId:1,truckId:1,plannedDeparture:'2028-01-01',plannedArrival:'2028-01-02'});
  await assert.rejects(assertTripAvailability(db,{companyId:1,truckId:4,plannedDeparture:'2028-01-01',plannedArrival:'2028-01-02'}),e=>e.code==='TRIP_RESOURCE_CONFLICT');
 });
 await t.test('cancelar servicio no libera salida; llegar base libera explícitamente',async()=>{
  await db.query("update trips set status='Cancelado' where id=2");
  assert.equal((await action('link',liveVersion,{next_trip_id:3})).statusCode,409);
  assert.equal((await action('arrive_base',liveVersion)).statusCode,409);
  assert.equal((await action('return',liveVersion)).statusCode,200);
  assert.equal((await action('arrive_base',liveVersion+1)).statusCode,200);
  const r=await call('GET',base);assert.equal(r.payload.outing.status,'arrived_base');assert.ok(r.payload.outing.closed_at);
  await db.query("update trips set status='En carga' where id=1");
  await db.query("update trips set status='Completado' where id=1");
  await assertTripAvailability(db,{companyId:1,truckId:1,driverId:1,tripId:3,plannedDeparture:'2027-01-01',plannedArrival:'2027-01-02'});
  await db.query('update commercial_equipment_seats set active=false where truck_id=1');
 });
 await t.test('snapshot de contrato actual impide GPS gratis y permite release trazable',async()=>{
  await db.exec(`update companies set commercial_enforced=true where id=1;
   update commercial_equipment_seats set active=true where truck_id=1;
   insert into fixture_contract values(1,'{"modules":["operations"]}');`);
  const r=await call('POST',base,{base_location_id:1,reason:'Salida contratada'},admin,3);assert.equal(r.statusCode,201,JSON.stringify(r.payload));assert.deepEqual(r.payload.outing.commercial_modules,['operations']);
  await db.query("update trips set status='Completado' where id=3");
  assert.equal((await call('POST',mobile+'/action',{action:'return',version:1,reason:'Regreso'},driver,3)).statusCode,200);
  const gps=await call('POST',mobile+'/positions',{version:2,lat:-33,lng:-70,recorded_at:new Date().toISOString()},driver,3);assert.equal(gps.statusCode,403);
  assert.equal((await call('POST',base+'/action',{action:'release',version:2,reason:'Liberado en destino por operaciones'},admin,3)).statusCode,200);
  const out=(await call('GET',base,{},admin,3)).payload;assert.equal(out.outing.status,'released');assert.equal(out.events.at(-1).reason,'Liberado en destino por operaciones');
 });
 await t.test('plataforma usa contexto efectivo; FK impide cruce de empresas',async()=>{
  const user={id:1,actor_type:'platform',scope:'platform',company_id:null,platform_membership_id:9,role_code:'owner',ownership_role:'owner',ownership_active:true,active_company_context:1};
  assert.equal((await call('GET',base,{}, {...user,company_id:1,active_company_context:null})).statusCode,403);
  assert.equal((await call('GET',base,{},user)).statusCode,200);
  await assert.rejects(db.query('insert into operational_outing_services(company_id,outing_id,trip_id,sequence) values(1,$1,4,3)',[created.id]),e=>e.code==='23503');
  await assert.rejects(db.query('insert into operational_outings(company_id,truck_id,driver_id,base_location_id) values(1,1,1,4)'),e=>e.code==='23503');
 });
 await t.test('fallo de auditoría revierte salida y todas sus relaciones',async()=>{
  await db.exec(`update companies set commercial_enforced=false where id=2;
   CREATE FUNCTION fixture_audit_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$ LANGUAGE plpgsql;
   CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fixture_audit_failure();`);
  const r=await call('POST',base,{base_location_id:4,reason:'Inicio'}, {...admin,company_id:2},4);assert.equal(r.statusCode,500);
  assert.equal((await db.query('select count(*)::int n from operational_outings where company_id=2')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from operational_outing_services where company_id=2')).rows[0].n,0);
 });
 }finally{await db.close();}
});

test('contención comercial o de viaje retorna conflicto sin esperar locks invertidos',async()=>{
 for(const tripBusy of [false,true]){
  const calls=[],routes=new Map();
  const app={get(p,...h){routes.set('GET '+p,h);},post(p,...h){routes.set('POST '+p,h);}};
  const pool={connect:async()=>({async query(sql){calls.push(sql);
   if(sql.includes('pg_try_advisory_xact_lock'))return {rows:[{locked:tripBusy}]};
   if(sql.includes('select * from trips')){assert.match(sql,/for update nowait/);throw Object.assign(Error('busy'),{code:'55P03'});}
   return {rows:[]};
  },release(){}})};
  registerOperationalOutings(app,pool,{driverAccess:()=>true,enforceDriverPersonnel:async()=>true});
  const handler=routes.get('POST /api/operations/trips/:id/outing').at(-1);
  const res={status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
  await handler({user:admin,params:{id:'1'},body:{base_location_id:1,reason:'Inicio'}},res);
  assert.equal(res.code,409);assert.ok(calls.includes('ROLLBACK'));assert.equal(calls.includes('COMMIT'),false);
  if(!tripBusy)assert.equal(calls.some(sql=>sql.includes('from trips')),false);
 }
});
