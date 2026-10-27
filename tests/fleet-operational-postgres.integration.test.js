'use strict';

// Optional PostgreSQL/WASM integration. No network, server, or DATABASE_URL.
// FLEETCHILE_TEST_PGLITE points to an externally installed @electric-sql/pglite.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MIGRATION_FILES}=require('../startup');
const {registerCoreRoutes}=require('../core-api');
const {registerOperationsRoutes}=require('../operations-api');
const {assertVehicleRoadReady,ROAD_CODES}=require('../vehicle-readiness');
const {assertDriverOperationalReady}=require('../driver-readiness');
const {assertTripResourcesReady}=require('../trip-eligibility');
const {assertTripAvailability}=require('../trip-availability');
const {reconcileVehicleDocumentAlerts}=require('../vehicle-document-alerts');
const migration='032_fleet_operational_registration.sql';
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('flota operacional PostgreSQL aislado: migración, documentos y onboarding',
 {skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite();
 const query=async(sql,values=[])=>{const r=await db.query(sql,values);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const pool={query,connect:async()=>({query,release(){}})};
 const one=async(sql,values)=>(await query(sql,values)).rows[0];
 let serial=0,legacy;
 try{
  await db.exec(source('schema.sql'));
  await db.exec(source('migrations/002_core_platform.sql'));
  assert.ok(MIGRATION_FILES.includes(migration),'Startup registra la migración 032');
  for(const file of MIGRATION_FILES){
   if(file===migration){
    const company=await one("insert into companies(legal_name) values('Fleet migration fixture') returning id");
    const driver=await one("insert into drivers(company_id,name) values($1,'Conductor previo') returning id",[company.id]);
    const truck=await one("insert into trucks(company_id,patente,tipo,capacidad_t) values($1,'MIG032','Camión',8) returning id",[company.id]);
    const old=await one("insert into vehicle_documents(truck_id,document_type,expires_at,created_at) values($1,'SOAP','2001-01-01','2000-01-01') returning id",[truck.id]);
    const current=await one("insert into vehicle_documents(truck_id,document_type,expires_at,created_at) values($1,'Seguro obligatorio','2099-01-01','2001-01-01') returning id",[truck.id]);
    const unknown=await one("insert into vehicle_documents(truck_id,document_type,expires_at) values($1,'Documento desconocido','2099-01-01') returning id",[truck.id]);
    legacy={company,driver,truck,old,current,unknown};
   }
   await db.exec(source('migrations/'+file));
  }
  const role=(await one("select id from roles where code='driver'")).id;
  const adminRole=(await one("select id from roles where code='company_admin'")).id;
  const routes=[],app={};
  for(const method of ['get','post','patch','put','delete'])app[method]=(route,...handlers)=>routes.push({method,route,handlers});
  // The real core registration owns the profile routes and legacy aliases too.
  registerCoreRoutes(app,pool);
  registerOperationsRoutes(app,pool);
  assert.equal(routes.filter(r=>r.method==='post'&&r.route==='/api/trucks').length,1);
  async function run(method,route,user,{params={},body={},query:filters={}}={}){
   const r=routes.find(r=>r.method===method&&r.route===route);assert.ok(r,route);
   const req={user,params,body,query:filters,ip:'127.0.0.1'};
   const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},sendStatus(n){this.statusCode=n;return this;},set(k,v){this.headers[k]=v;return this;},send(v){this.payload=v;return this;}};
   const next=async n=>{if(n>=r.handlers.length)return;let pending;await r.handlers[n](req,res,()=>{pending=next(n+1);return pending;});if(pending)await pending;};
   await next(0);return res;
  }
  async function company(){
   const id=(await one('insert into companies(legal_name) values($1) returning id',['Fleet test '+ ++serial])).id;
   const user=(await one('insert into users(company_id,role_id,name,email,active) values($1,$2,$3,$4,true) returning id',[id,adminRole,'Fleet operator',`operator-${serial}@example.invalid`])).id;
   return {id,actor:{id:user,name:'Fleet operator',actor_type:'company',scope:'company',company_id:id,permissions:['fleet.manage','drivers.manage','dashboard.read','documents.manage']}};
  }
  async function truck(companyId,{complete=false,expiry='2099-12-31'}={}){
   const row=await one("insert into trucks(company_id,patente,tipo,brand,model,status) values($1,$2,'Camión','Marca fixture','Modelo fixture','Disponible') returning *",[companyId,'FLEET'+ ++serial]);
   if(complete)for(const label of ['Permiso de circulación','SOAP','Revisión técnica'])await query('insert into vehicle_documents(truck_id,document_type,expires_at,status) values($1,$2,$3,\'Vigente\')',[row.id,label,expiry]);
   return row;
  }
  async function candidate(companyId,{onboarded=false}={}){
   const n=++serial;
   const d=await one("insert into drivers(company_id,name,status,operational_registered_at) values($1,$2,'Activo',case when $3 then now() else null end) returning *",[companyId,'Driver fixture '+n,onboarded]);
   const u=await one('insert into users(company_id,role_id,driver_id,name,email,active) values($1,$2,$3,$4,$5,true) returning *',[companyId,role,d.id,d.name,`driver-${n}@example.invalid`]);
   const m=await one('insert into user_memberships(user_id,company_id,role_id,active) values($1,$2,$3,true) returning *',[u.id,companyId,role]);
   const p=await one("insert into company_people(company_id,user_id,membership_id,driver_id,name,rut,birth_date,job_title) values($1,$2,$3,$4,$5,'12345678-5','1990-01-01','Conductor') returning *",[companyId,u.id,m.id,d.id,d.name]);
   await query("insert into person_contracts(company_id,person_id,type,start_date) values($1,$2,'indefinite','2000-01-01')",[companyId,p.id]);
   await query("insert into person_driver_licenses(company_id,person_id,classes,printed_expiry,effective_expiry) values($1,$2,ARRAY['A4'],'2099-12-31','2099-12-31')",[companyId,p.id]);
   return {d,u,m,p};
  }
  const roadFailure=(missing=[],expired=[])=>e=>e.status===409&&e.code==='VEHICLE_NOT_ROAD_READY'&&missing.every(x=>e.details.missing.includes(x))&&expired.every(x=>e.details.expired.includes(x));
  const driverFailure=reason=>e=>e.status===409&&e.code==='DRIVER_NOT_OPERATIONAL_READY'&&e.reasons.includes(reason);

  await t.test('032 es idempotente: conserva fechas e historial y no registra identidades técnicas nuevas',async()=>{
   const before=await one('select operational_registered_at from drivers where id=$1',[legacy.driver.id]);
   assert.ok(before.operational_registered_at);
   const technical=await one("insert into drivers(company_id,name) values($1,'Nueva identidad técnica') returning id",[legacy.company.id]);
   await db.exec(source('migrations/'+migration));
   await db.exec(source('migrations/'+migration));
   assert.deepEqual((await one('select operational_registered_at from drivers where id=$1',[legacy.driver.id])),before);
   assert.equal((await one('select operational_registered_at from drivers where id=$1',[technical.id])).operational_registered_at,null);
   const docs=(await query('select id,document_type,expires_at::text expiry,road_requirement_code code,road_requirement_superseded superseded from vehicle_documents where truck_id=$1 order by id',[legacy.truck.id])).rows;
   assert.equal(docs.length,3);
   assert.equal(docs.find(d=>d.id===legacy.old.id).expiry,'2001-01-01');
   assert.equal(docs.find(d=>d.id===legacy.old.id).superseded,true);
   assert.equal(docs.find(d=>d.id===legacy.current.id).code,'soap');
   assert.equal(docs.find(d=>d.id===legacy.current.id).expiry,'2099-01-01');
   assert.equal(docs.find(d=>d.id===legacy.unknown.id).code,null);
   await assert.rejects(query("insert into vehicle_documents(truck_id,document_type) values($1,'SOAP')",[legacy.truck.id]),/unique|duplicate/i);
  });

  await t.test('alta incompleta permitida, capacidad opcional y guard impide usarla operacionalmente',async()=>{
   const c=await company();
   const r=await run('post','/api/fleet/vehicles',c.actor,{body:{patente:'CREATE'+ ++serial,brand:'Marca',model:'Modelo',tipo:'Camión'}});
   assert.equal(r.statusCode,201,JSON.stringify(r.payload));assert.equal(r.payload.ready,false);
   assert.equal((await one('select capacidad_t from trucks where id=$1',[r.payload.id])).capacidad_t,null);
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:c.id,truckId:r.payload.id}),roadFailure(ROAD_CODES));
   await assert.rejects(assertTripResourcesReady(pool,{companyId:c.id,truckId:r.payload.id}),roadFailure(ROAD_CODES));
   assert.equal((await one("select count(*)::int n from audit_logs where company_id=$1 and entity='truck_profile' and user_id=$2",[c.id,c.actor.id])).n,1);
  });

  await t.test('guard SQL real rechaza incompleto, vencido y ajeno; acepta sólo canónicos vigentes',async()=>{
   const a=await company(),b=await company(),incomplete=await truck(a.id),expired=await truck(a.id,{complete:true,expiry:'2000-01-01'}),ready=await truck(a.id,{complete:true});
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:a.id,truckId:incomplete.id}),roadFailure(ROAD_CODES));
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:a.id,truckId:expired.id}),roadFailure([],ROAD_CODES));
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:b.id,truckId:ready.id}),e=>e.status===404);
   const r=await run('get','/api/fleet/vehicles/:id',b.actor,{params:{id:ready.id}});assert.equal(r.statusCode,404);
   assert.equal((await assertVehicleRoadReady(pool,{companyId:a.id,truckId:ready.id,lock:true})).allowed,true);
   await query("update vehicle_documents set status='Vencido' where truck_id=$1 and road_requirement_code='soap'",[ready.id]);
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:a.id,truckId:ready.id}),e=>e.details.invalid_status.includes('soap'));
  });

  await t.test('bloqueos operacionales reales: mantención y checklist rechazado hasta resolución',async()=>{
   const c=await company(),v=await truck(c.id,{complete:true});
   await query("update trucks set status='Mantención' where id=$1",[v.id]);
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:c.id,truckId:v.id}),e=>e.code==='VEHICLE_NOT_ROAD_READY');
   await query("update trucks set status='Disponible' where id=$1",[v.id]);
   const m=await one("insert into maintenance(company_id,truck_id,item,status) values($1,$2,'Reparación fixture','En proceso') returning id",[c.id,v.id]);
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:c.id,truckId:v.id}),e=>e.details.reasons.some(r=>r.includes('mantención en proceso')));
   await query("update maintenance set status='Completada' where id=$1",[m.id]);
   const trip=await one("insert into trips(company_id,trip_number,truck_id,origin,destination) values($1,$2,$3,'Origen','Destino') returning id",[c.id,'CHECK-'+ ++serial,v.id]);
   const checklist=await one("insert into vehicle_checklists(truck_id,trip_id,status) values($1,$2,'Rechazado') returning id",[v.id,trip.id]);
   const alert=await one("insert into alerts(company_id,source_type,source_id,condition_code,resolved) values($1,'checklist',$2,'checklist_rejected',false) returning id",[c.id,checklist.id]);
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:c.id,truckId:v.id}),e=>e.details.reasons.some(r=>r.includes('checklist rechazado')));
   await query('update alerts set resolved=true where id=$1',[alert.id]);
   assert.equal((await assertVehicleRoadReady(pool,{companyId:c.id,truckId:v.id})).allowed,true);
  });

  await t.test('reservas SQL: intervalos, exclusión propia, camión/conductor, empresa y estados terminales',async()=>{
   const c=await company(),other=await company(),v=await truck(c.id,{complete:true}),d=await candidate(c.id,{onboarded:true});
   const trip=await one("insert into trips(company_id,trip_number,truck_id,driver_id,origin,destination,planned_departure,planned_arrival,status) values($1,$2,$3,$4,'Origen','Destino','2026-11-01T10:00:00Z','2026-11-01T18:00:00Z','Asignado') returning id",[c.id,'RES-'+ ++serial,v.id,d.d.id]);
   const request={companyId:c.id,truckId:v.id,plannedDeparture:'2026-11-01T12:00:00Z',plannedArrival:'2026-11-01T19:00:00Z'};
   await assert.rejects(assertTripAvailability(pool,request),e=>e.code==='TRIP_RESOURCE_CONFLICT'&&e.details.conflicts[0].truck);
   await assert.rejects(assertTripAvailability(pool,{...request,truckId:null,driverId:d.d.id}),e=>e.details.conflicts[0].driver);
   await assertTripAvailability(pool,{...request,tripId:trip.id});
   await assertTripAvailability(pool,{...request,companyId:other.id});
   await assertTripAvailability(pool,{...request,plannedDeparture:'2026-11-01T18:00:00Z',plannedArrival:'2026-11-01T23:00:00Z'});
   await assert.rejects(assertTripAvailability(pool,{...request,plannedDeparture:null,plannedArrival:null}),e=>e.code==='TRIP_RESOURCE_CONFLICT');
   await query("update trips set status='En tránsito',actual_departure=now() where id=$1",[trip.id]);
   await assert.rejects(assertTripAvailability(pool,{...request,status:'En tránsito',plannedDeparture:'2026-11-02T18:00:00Z',plannedArrival:'2026-11-02T23:00:00Z'}),e=>e.code==='TRIP_RESOURCE_CONFLICT');
   for(const status of ['Completado','Cancelado']){await query('update trips set status=$1 where id=$2',[status,trip.id]);await assertTripAvailability(pool,request);}
  });

  await t.test('flujo integrado real crea, rechaza reserva superpuesta, reasigna y activa sin conflicto consigo mismo',async()=>{
   const c=await company(),v=await truck(c.id,{complete:true}),d=await candidate(c.id,{onboarded:true});
   const client=await one("insert into clients(company_id,name) values($1,'Cliente fixture') returning id",[c.id]);
   const actor={...c.actor,permissions:[...c.actor.permissions,'trips.manage']};
   const body={truck_id:v.id,driver_id:d.d.id,client_id:client.id,origin:'Origen fixture',destination:'Destino fixture',planned_departure:'2026-11-01T10:00:00Z',planned_arrival:'2026-11-01T18:00:00Z'};
   const first=await run('post','/api/trips',actor,{body});assert.equal(first.statusCode,201,JSON.stringify(first.payload));
   const blocked=await run('post','/api/trips',actor,{body});assert.equal(blocked.statusCode,409,JSON.stringify(blocked.payload));assert.equal(blocked.payload.code,'TRIP_RESOURCE_CONFLICT');
   assert.equal((await one('select count(*)::int n from trips where company_id=$1',[c.id])).n,1);
   assert.equal((await one("select count(*)::int n from audit_logs where company_id=$1 and entity='trip' and action='create'",[c.id])).n,1);
   const assign=await run('patch','/api/operations/trips/:id/assign',actor,{params:{id:first.payload.id},body:{truck_id:v.id,driver_id:d.d.id,client_id:client.id}});
   assert.equal(assign.statusCode,200,JSON.stringify(assign.payload));assert.equal(assign.payload.status,'Asignado');
   const activate=await run('patch','/api/trips/:id/status',actor,{params:{id:first.payload.id},body:{status:'En tránsito'}});
   assert.equal(activate.statusCode,200,JSON.stringify(activate.payload));
   await query("update trucks set status='Mantención' where id=$1",[v.id]);
   const stop=await run('patch','/api/operations/trips/:id/status',actor,{params:{id:first.payload.id},body:{status:'Detenido'}});
   assert.equal(stop.statusCode,200,JSON.stringify(stop.payload));
   const resume=await run('patch','/api/operations/trips/:id/status',actor,{params:{id:first.payload.id},body:{status:'En tránsito'}});
   assert.equal(resume.statusCode,409,JSON.stringify(resume.payload));
   assert.equal((await one('select status from trips where id=$1',[first.payload.id])).status,'Detenido');
  });

  await t.test('renovación API actualiza canónicos sin duplicar documentos ni aceptar versión obsoleta',async()=>{
   const c=await company(),v=await truck(c.id,{complete:true,expiry:'2000-01-01'});
   const before=(await query('select id from vehicle_documents where truck_id=$1 order by id',[v.id])).rows;
   const r=await run('patch','/api/fleet/vehicles/:id',c.actor,{params:{id:v.id},body:{profile_version:1,reason:'Renovación de documentos',circulation_expiry:'2099-12-31',soap_expiry:'2099-12-31',inspection_expiry:'2099-12-31'}});
   assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   assert.deepEqual((await query('select id from vehicle_documents where truck_id=$1 order by id',[v.id])).rows,before);
   assert.equal((await assertVehicleRoadReady(pool,{companyId:c.id,truckId:v.id})).allowed,true);
   const stale=await run('patch','/api/fleet/vehicles/:id',c.actor,{params:{id:v.id},body:{profile_version:1,soap_expiry:'2000-01-01',reason:'Pantalla desactualizada'}});
   assert.equal(stale.statusCode,409,JSON.stringify(stale.payload));
   assert.equal((await one("select expires_at::text expiry from vehicle_documents where truck_id=$1 and road_requirement_code='soap'",[v.id])).expiry,'2099-12-31');
  });

  await t.test('job real deduplica alertas y las resuelve al renovar sin afectar otra empresa',async()=>{
   const a=await company(),b=await company(),v=await truck(a.id,{complete:true,expiry:'2000-01-01'}),foreign=await truck(b.id,{complete:true,expiry:'2000-01-01'});
   await reconcileVehicleDocumentAlerts(pool,{companyId:a.id});
   const first=(await query("select id,condition_code from alerts where company_id=$1 and source_type='truck' and source_id=$2 and not resolved order by id",[a.id,v.id])).rows;
   assert.equal(first.length,3);assert.equal(new Set(first.map(x=>x.condition_code)).size,3);
   await reconcileVehicleDocumentAlerts(pool,{companyId:a.id});
   assert.deepEqual((await query("select id,condition_code from alerts where company_id=$1 and source_type='truck' and source_id=$2 and not resolved order by id",[a.id,v.id])).rows,first);
   assert.equal((await one("select count(*)::int n from alerts where company_id=$1 and source_type='truck' and source_id=$2",[b.id,foreign.id])).n,0);
   // Isolate the job from the PATCH contract exercised by the preceding test.
   // This changes canonical fixture rows in this in-memory database only.
   await query("update vehicle_documents set expires_at='2099-12-31',status='Vigente' where truck_id=$1 and road_requirement_code is not null",[v.id]);
   assert.equal((await assertVehicleRoadReady(pool,{companyId:a.id,truckId:v.id})).allowed,true);
   const result=await reconcileVehicleDocumentAlerts(pool,{companyId:a.id});assert.equal(result.resolved,3);
   const all=(await query("select id,resolved,resolved_at from alerts where company_id=$1 and source_type='truck' and source_id=$2 order by id",[a.id,v.id])).rows;
   assert.deepEqual(all.map(x=>x.id),first.map(x=>x.id));assert.ok(all.every(x=>x.resolved&&x.resolved_at));
   await reconcileVehicleDocumentAlerts(pool,{companyId:a.id});
   assert.equal((await one("select count(*)::int n from alerts where company_id=$1 and source_type='truck' and source_id=$2",[a.id,v.id])).n,3);
  });

  await t.test('rutas documentales antiguas comparten canónicos, bump versión, tenant y rollback auditado',async()=>{
   const c=await company(),other=await company(),v=await truck(c.id),ids=[];
   for(const document_type of ['Permiso de circulación','SOAP','Revisión técnica']){
    const r=await run('post','/api/vehicle-documents',c.actor,{body:{truck_id:v.id,document_type,issued_at:'2020-01-01',expires_at:'2099-12-31'}});
    assert.equal(r.statusCode,201,JSON.stringify(r.payload));ids.push(r.payload.id);
   }
   const repeat=await run('post','/api/vehicle-documents',c.actor,{body:{truck_id:v.id,document_type:'Seguro obligatorio',issued_at:'2020-01-01',expires_at:'2099-12-31'}});
   assert.equal(repeat.statusCode,201,JSON.stringify(repeat.payload));assert.equal(repeat.payload.id,ids[1]);
   assert.equal((await one('select count(*)::int n from vehicle_documents where truck_id=$1 and road_requirement_code is not null',[v.id])).n,3);
   assert.equal((await assertVehicleRoadReady(pool,{companyId:c.id,truckId:v.id})).allowed,true);
   const version=(await one('select profile_version from trucks where id=$1',[v.id])).profile_version;
   const patch=await run('patch','/api/vehicle-documents/:id',c.actor,{params:{id:ids[1]},body:{expires_at:'2098-12-31'}});assert.equal(patch.statusCode,200,JSON.stringify(patch.payload));
   assert.equal((await one('select profile_version from trucks where id=$1',[v.id])).profile_version,version+1);
   assert.equal((await one('select issued_at::text issued from vehicle_documents where id=$1',[ids[1]])).issued,'2020-01-01');
   const old=await one("insert into vehicle_documents(truck_id,document_type,expires_at,road_requirement_superseded) values($1,'SOAP','2000-01-01',true) returning id",[v.id]);
   const list=await run('get','/api/documents',c.actor,{query:{resource_type:'vehicle',truck_id:v.id}});assert.equal(list.statusCode,200,JSON.stringify(list.payload));assert.equal(list.payload.length,3);assert.equal(list.payload.some(d=>d.id===old.id),false);
   assert.equal((await run('post','/api/vehicle-documents',other.actor,{body:{truck_id:v.id,document_type:'SOAP',expires_at:'2099-12-31'}})).statusCode,404);
   assert.equal((await run('patch','/api/vehicle-documents/:id',other.actor,{params:{id:ids[1]},body:{expires_at:'2099-12-31'}})).statusCode,404);
   await db.exec("create function fleet_document_audit_failure() returns trigger as $$ begin if NEW.entity='vehicle_document' then raise exception 'document audit unavailable'; end if; return NEW; end $$ language plpgsql; create trigger fleet_document_audit_failure before insert on audit_logs for each row execute function fleet_document_audit_failure();");
   try{
    for(const method of ['post','patch']){
     const r=await run(method,method==='post'?'/api/vehicle-documents':'/api/vehicle-documents/:id',c.actor,{params:{id:ids[1]},body:{truck_id:v.id,document_type:'SOAP',expires_at:'2000-01-01'}});assert.ok(r.statusCode>=400,JSON.stringify(r.payload));
     assert.equal((await one('select expires_at::text expiry from vehicle_documents where id=$1',[ids[1]])).expiry,'2098-12-31');
     assert.equal((await one('select profile_version from trucks where id=$1',[v.id])).profile_version,version+1);
    }
   }finally{await db.exec('drop trigger fleet_document_audit_failure on audit_logs; drop function fleet_document_audit_failure();');}
  });

  await t.test('candidatos sólo de empresa actual; onboarding conserva asociaciones y habilita guard',async()=>{
   const c=await company(),foreign=await company(),f=await candidate(c.id),other=await candidate(foreign.id);
   await assert.rejects(assertDriverOperationalReady(pool,{companyId:c.id,driverId:f.d.id}),driverFailure('OPERATIONAL_REGISTRATION_MISSING'));
   const list=await run('get','/api/fleet/drivers/candidates',c.actor);
   assert.equal(list.statusCode,200,JSON.stringify(list.payload));
   assert.equal(list.payload.rows.find(x=>String(x.user_id)===String(f.u.id))?.eligible,true);
   assert.equal(list.payload.rows.some(x=>String(x.user_id)===String(other.u.id)),false);
   const r=await run('post','/api/fleet/drivers',c.actor,{body:{user_id:f.u.id}});
   assert.equal(r.statusCode,201,JSON.stringify(r.payload));assert.equal(r.payload.driver_id,f.d.id);
   assert.equal((await one('select driver_id from users where id=$1',[f.u.id])).driver_id,f.d.id);
   assert.equal((await one('select driver_id from company_people where id=$1',[f.p.id])).driver_id,f.d.id);
   assert.equal((await assertDriverOperationalReady(pool,{companyId:c.id,driverId:f.d.id,lock:true})).ready,true);
   const after=await run('get','/api/fleet/drivers/candidates',c.actor);assert.equal(after.statusCode,200,JSON.stringify(after.payload));
   assert.equal(after.payload.rows.some(x=>String(x.user_id)===String(f.u.id)),false);
   const v=await truck(c.id,{complete:true});await assertTripResourcesReady(pool,{companyId:c.id,driverId:f.d.id,truckId:v.id});
   const audit=await one("select company_id,user_id from audit_logs where company_id=$1 and action='driver_operational_onboard' order by id desc limit 1",[c.id]);
   assert.equal(String(audit.company_id),String(c.id));assert.equal(String(audit.user_id),String(c.actor.id));
  });

  for(const blocked of ['membership','condition','license','foreign'])await t.test(`onboarding rechaza ${blocked} sin mutar ni auditar éxito`,async()=>{
    const c=await company(),target=blocked==='foreign'?await company():c,f=await candidate(target.id);
    if(blocked==='membership')await query('update user_memberships set active=false where id=$1',[f.m.id]);
    if(blocked==='condition')await query("insert into person_conditions(company_id,person_id,type,start_date,end_date) values($1,$2,'suspended','2000-01-01','2099-12-31')",[c.id,f.p.id]);
    if(blocked==='license')await query("update person_driver_licenses set printed_expiry='2000-01-01',effective_expiry='2000-01-01' where person_id=$1",[f.p.id]);
    const r=await run('post','/api/fleet/drivers',c.actor,{body:{user_id:f.u.id}});
    assert.ok([403,404,409].includes(r.statusCode),blocked+': '+JSON.stringify(r.payload));
    assert.equal((await one('select operational_registered_at from drivers where id=$1',[f.d.id])).operational_registered_at,null);
    assert.equal((await one("select count(*)::int n from audit_logs where company_id=$1 and action='driver_operational_onboard'",[c.id])).n,0);
  });

  await t.test('candidato sin identidad técnica crea un solo driver y enlaza persona/cuenta existentes',async()=>{
   const c=await company(),f=await candidate(c.id);
   await query('update company_people set driver_id=null where id=$1',[f.p.id]);
   await query('update users set driver_id=null where id=$1',[f.u.id]);
   await query('delete from drivers where id=$1',[f.d.id]);
   const list=await run('get','/api/fleet/drivers/candidates',c.actor);assert.equal(list.statusCode,200,JSON.stringify(list.payload));
   const row=list.payload.rows.find(x=>String(x.user_id)===String(f.u.id));assert.ok(row);assert.equal(row.driver_id,null);assert.equal(row.eligible,true);
   const r=await run('post','/api/fleet/drivers',c.actor,{body:{user_id:f.u.id}});assert.equal(r.statusCode,201,JSON.stringify(r.payload));
   assert.equal((await one('select driver_id from users where id=$1',[f.u.id])).driver_id,r.payload.driver_id);
   assert.equal((await one('select driver_id from company_people where id=$1',[f.p.id])).driver_id,r.payload.driver_id);
   assert.equal((await one('select count(*)::int n from drivers where company_id=$1',[c.id])).n,1);
   assert.equal((await assertDriverOperationalReady(pool,{companyId:c.id,driverId:r.payload.driver_id})).ready,true);
  });

  await t.test('membresía/condición/licencia vigentes se reevalúan después del onboarding',async()=>{
   const c=await company(),f=await candidate(c.id,{onboarded:true}),v=await truck(c.id,{complete:true});
   await assertTripResourcesReady(pool,{companyId:c.id,driverId:f.d.id,truckId:v.id});
   await query('update user_memberships set active=false where id=$1',[f.m.id]);
   await assert.rejects(assertTripResourcesReady(pool,{companyId:c.id,driverId:f.d.id,truckId:v.id}),driverFailure('MEMBERSHIP_INACTIVE'));
   await query('update user_memberships set active=true where id=$1',[f.m.id]);
   await query("insert into person_conditions(company_id,person_id,type,start_date,end_date) values($1,$2,'vacation','2000-01-01','2099-12-31')",[c.id,f.p.id]);
   await assert.rejects(assertDriverOperationalReady(pool,{companyId:c.id,driverId:f.d.id}),driverFailure('CONDITION_ACTIVE'));
   await query('update person_conditions set cancelled_at=now() where person_id=$1',[f.p.id]);
   await query("update person_driver_licenses set printed_expiry='2000-01-01',effective_expiry='2000-01-01' where person_id=$1",[f.p.id]);
   await assert.rejects(assertDriverOperationalReady(pool,{companyId:c.id,driverId:f.d.id}),driverFailure('LICENSE_MISSING_OR_EXPIRED'));
  });

  await t.test('endpoint real de eventos crea suspensión canónica sin mutar otra empresa',async()=>{
   const c=await company(),b=await company(),f=await candidate(c.id,{onboarded:true});
   const event=await run('post','/api/fleet/drivers/:id/events',c.actor,{params:{id:f.d.id},body:{event_type:'note',event_date:'2026-01-01',notes:'Nota de integración'}});
   assert.equal(event.statusCode,201,JSON.stringify(event.payload));
   const suspension=await run('post','/api/fleet/drivers/:id/events',c.actor,{params:{id:f.d.id},body:{event_type:'suspension',event_date:'2000-01-01',ends_on:'2099-12-31',notes:'Suspensión de integración'}});
   assert.equal(suspension.statusCode,201,JSON.stringify(suspension.payload));
   assert.equal((await one("select count(*)::int n from person_conditions where company_id=$1 and person_id=$2 and type='suspended'",[c.id,f.p.id])).n,1);
   await assert.rejects(assertDriverOperationalReady(pool,{companyId:c.id,driverId:f.d.id}),driverFailure('CONDITION_ACTIVE'));
   assert.equal((await run('post','/api/fleet/drivers/:id/events',b.actor,{params:{id:f.d.id},body:{event_type:'note',event_date:'2026-01-01',notes:'Ajena'}})).statusCode,404);
  });

  await t.test('endpoints reales ficha y PDF ejecutan SQL y preservan aislamiento',async()=>{
   const c=await company(),b=await company(),f=await candidate(c.id,{onboarded:true});
   await query("insert into driver_profile_events(company_id,driver_id,actor_user_id,actor_name,event_type,event_date,notes) values($1,$2,$3,'Fixture','note','2026-01-01','Historial fixture')",[c.id,f.d.id,c.actor.id]);
   const detail=await run('get','/api/fleet/drivers/:id',c.actor,{params:{id:f.d.id}});assert.equal(detail.statusCode,200,JSON.stringify(detail.payload));
   assert.equal(detail.payload.events.length,1);assert.equal(detail.payload.licenses.length,1);
   const pdf=await run('get','/api/fleet/drivers/:id/pdf',c.actor,{params:{id:f.d.id}});assert.equal(pdf.statusCode,200,JSON.stringify(pdf.payload));
   assert.equal(pdf.headers['Content-Type'],'application/pdf');assert.ok(Buffer.isBuffer(pdf.payload));assert.match(pdf.payload.subarray(0,8).toString(),/^%PDF-/);
   assert.equal((await one("select count(*)::int n from audit_logs where company_id=$1 and entity='driver_profile_pdf' and user_id=$2",[c.id,c.actor.id])).n,1);
   for(const endpoint of ['/api/fleet/drivers/:id','/api/fleet/drivers/:id/pdf'])assert.equal((await run('get',endpoint,b.actor,{params:{id:f.d.id}})).statusCode,404);
  });

  await t.test('FK compuesta e historial inmutable; fallo auditoría revierte onboarding completo',async()=>{
   const c=await company(),b=await company(),f=await candidate(c.id);
   await assert.rejects(query("insert into driver_profile_events(company_id,driver_id,actor_user_id,actor_name,event_type,event_date,notes) values($1,$2,$3,'Fixture','note','2026-01-01','Nota')",[b.id,f.d.id,c.actor.id]),/foreign key/i);
   const event=await one("insert into driver_profile_events(company_id,driver_id,actor_user_id,actor_name,event_type,event_date,notes) values($1,$2,$3,'Fixture','note','2026-01-01','Nota') returning id",[c.id,f.d.id,c.actor.id]);
   await assert.rejects(query("update driver_profile_events set notes='Cambio' where id=$1",[event.id]),/inmutable/i);
   await assert.rejects(query('delete from driver_profile_events where id=$1',[event.id]),/inmutable/i);
   await db.exec("create function fleet_test_audit_failure() returns trigger as $$ begin if NEW.action='driver_operational_onboard' then raise exception 'fleet test audit unavailable'; end if; return NEW; end $$ language plpgsql; create trigger fleet_test_audit_failure before insert on audit_logs for each row execute function fleet_test_audit_failure();");
   try{
    const r=await run('post','/api/fleet/drivers',c.actor,{body:{user_id:f.u.id}});assert.ok(r.statusCode>=400,JSON.stringify(r.payload));
    const row=await one('select operational_registered_at,profile_version from drivers where id=$1',[f.d.id]);assert.equal(row.operational_registered_at,null);assert.equal(row.profile_version,1);
    assert.equal((await one("select count(*)::int n from audit_logs where company_id=$1 and action='driver_operational_onboard'",[c.id])).n,0);
   }finally{await db.exec('drop trigger fleet_test_audit_failure on audit_logs; drop function fleet_test_audit_failure();');}
  });
 }finally{await db.close();}
});
