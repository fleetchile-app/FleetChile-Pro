'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createRequire}=require('node:module');
const {embedded,harness}=require('./helpers/acceptance');

test('auditoría Render: SQL real de combustible, entregas, cupos de cargas y motivos',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,errors=[],query=pool.query;
  pool.query=async(...args)=>{try{return await query(...args);}catch(e){errors.push({code:e.code,message:e.message});throw e;}};
  pool.connect=async()=>({query:pool.query,release(){}});
  const h=await harness(pool),a=await h.company('Auditoría sintética A');
  const truck=await h.one("insert into trucks(company_id,patente,tipo) values($1,'QA-AUD','camion') returning id",[a.id]);
  const client=await h.one("insert into clients(company_id,name) values($1,'Cliente QA') returning id",[a.id]);
  let mobile;
  await t.test('combustible calcula el total con parámetros NUMERIC en PostgreSQL',async()=>{
   const r=await h.run(a.admin.token,'post','/api/fleet/fuel',{body:{truck_id:truck.id,date:'2026-10-28',liters:100,price_clp:1000,odometer_km:1001,station:'QA'}});
   assert.equal(r.statusCode,201,JSON.stringify({payload:r.payload,errors}));assert.equal(Number(r.payload.total_clp),100000);
  });
  await t.test('entregas consulta una carga aun sin POD y conserva evidencia privada',async()=>{
   const driver=await h.account(a.id,'driver','Conductor QA','12345678-5');
   const d=await h.one("insert into drivers(company_id,name) values($1,'Conductor QA') returning id",[a.id]);
   await pool.query('update users set driver_id=$1 where id=$2',[d.id,driver.id]);
   await pool.query('update company_people set driver_id=$1 where user_id=$2',[d.id,driver.id]);
   const person=await h.one('select id from company_people where user_id=$1',[driver.id]);
   await pool.query("insert into person_driver_licenses(company_id,person_id,classes,printed_expiry,effective_expiry) values($1,$2,ARRAY['A4'],'2099-12-31','2099-12-31')",[a.id,person.id]);
   const trip=await h.one("insert into trips(company_id,trip_number,driver_id,origin,destination) values($1,'QA-AUD',$2,'O','D') returning id",[a.id,d.id]);
   mobile={driver,d,trip,person};
   const load=await h.one("insert into trip_loads(trip_id,client_id,cargo) values($1,$2,'Madera QA') returning id",[trip.id,client.id]);
   const r=await h.run(driver.token,'get','/api/driver/trips/:id/deliveries',{params:{id:trip.id}});
   assert.equal(r.statusCode,200,JSON.stringify({payload:r.payload,errors}));assert.equal(String(r.payload.deliveries[0].id),String(load.id));assert.deepEqual(r.payload.deliveries[0].deliveries,[]);
   const proof=await h.one("insert into trip_delivery_proofs(trip_id,load_id,client_submission_id,status) values($1,$2,'qa-proof','CLOSED') returning id",[trip.id,load.id]);
   await pool.query("insert into delivery_proof_files(proof_id,type,storage_key,mime_type,size,sha256) values($1,'signature','private/DO_NOT_RETURN','image/png',123,repeat('a',64))",[proof.id]);
   const shown=await h.run(driver.token,'get','/api/driver/trips/:id/deliveries',{params:{id:trip.id}});assert.equal(shown.statusCode,200,JSON.stringify(errors));assert.equal(shown.payload.deliveries[0].deliveries[0].evidence[0].exists,true);assert.doesNotMatch(JSON.stringify(shown.payload),/DO_NOT_RETURN|storage_key/);
  });
  await t.test('carga sin cupo informa la restricción comercial y revierte',async()=>{
   await pool.query('update companies set commercial_enforced=true where id=$1',[a.id]);
   const source=fs.readFileSync(require.resolve('../server'),'utf8').replace(/\r\n/g,'\n'),start=source.indexOf('async function legacyTruckBelongs'),end=source.indexOf('\n}\n',source.indexOf('async function createLegacyLoad',start))+2;
   const handler=Function('writeAudit','require',source.slice(start,end)+';return createLegacyLoad;')(require('../audit').writeAudit,createRequire(require.resolve('../server')));
   const req={resourceCompanyId:a.id,user:{id:a.admin.id},body:{client_id:client.id,truck:'QA-AUD',cargo:'QA',origin:'O',destination:'D'}},res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};
   await handler(req,res,pool);assert.equal(res.statusCode,409,JSON.stringify({payload:res.payload,errors}));assert.equal(res.payload.code,'COMMERCIAL_BLOCKED');assert.match(res.payload.error,/cupo|pagado|comercial|período/i);assert.equal((await h.one('select count(*)::int n from loads where company_id=$1',[a.id])).n,0);
   await pool.query('update companies set commercial_enforced=false where id=$1',[a.id]);
   const origin=await h.one("insert into operational_locations(company_id,name,lat,lng,source) values($1,'Origen sintético',-36,-73,'test-only') returning id",[a.id]);
   const destination=await h.one("insert into operational_locations(company_id,name,lat,lng,source) values($1,'Destino sintético',-33,-70,'test-only') returning id",[a.id]);
   const saved={...req,body:{...req.body,truck:'',origin_location_id:origin.id,destination_location_id:destination.id}},ok={...res,statusCode:200};
   await handler(saved,ok,pool);assert.equal(ok.statusCode,201,JSON.stringify({payload:ok.payload,errors}));assert.equal(ok.payload.truck,null);assert.equal(String(ok.payload.origin_location_id),String(origin.id));assert.equal(String(ok.payload.destination_location_id),String(destination.id));
   const audit=await h.one("select after_data from audit_logs where entity='loads' and entity_id=$1",[String(ok.payload.id)]);assert.equal(String(audit.after_data.client_id),String(client.id));
  });
  await t.test('el motivo obligatorio del permiso queda en historial de persona',async()=>{
   const person=await h.one('select id from company_people where user_id=$1',[a.approver.id]),reason='Motivo sintético de permiso';
   const r=await h.run(a.admin.token,'post','/api/company/people/:id/conditions',{params:{id:person.id},body:{type:'permission',start_date:'2026-10-28',end_date:'2026-10-29',reason}});
   assert.equal(r.statusCode,200,JSON.stringify(r.payload));const e=await h.one("select reason,actor_user_id from person_events where person_id=$1 and action='condition_create' order by id desc",[person.id]);assert.equal(e.reason,reason);assert.equal(Number(e.actor_user_id),a.admin.id);
  });
  await t.test('ninguna transición inicia sin aceptación e inspección; aprobar conserva el flujo y detener sigue permitido',async()=>{
   const {driver,d,trip}=mobile;
   await pool.query("update drivers set operational_registered_at=now(),status='Activo' where id=$1",[d.id]);
   for(const [code,label] of [['circulation','Permiso de circulación'],['soap','SOAP'],['inspection','Revisión técnica']])await pool.query("insert into vehicle_documents(truck_id,document_type,road_requirement_code,expires_at,status) values($1,$2,$3,'2099-12-31','Vigente')",[truck.id,label,code]);
   await pool.query("update trips set truck_id=$1,status='Asignado' where id=$2",[truck.id,trip.id]);
   const paths=['/api/trips/:id/status','/api/operations/trips/:id/status','/api/driver/trips/:id/status'];
   const run=(path)=>h.run(path.includes('/driver/')?driver.token:a.admin.token,'patch',path,{params:{id:trip.id},body:{status:'En tránsito'}});
   for(const p of paths){const r=await run(p);assert.equal(r.statusCode,409,JSON.stringify({path:p,body:r.payload,errors}));assert.equal(r.payload.code,'TRIP_ACCEPTANCE_REQUIRED');}
   const accepted=await h.run(driver.token,'post','/api/driver/trips/:id/workflow/accept',{params:{id:trip.id},body:{client_key:'qa-accept',version:0,resource_version:0}});assert.equal(accepted.statusCode,201,JSON.stringify(accepted.payload));
   for(const p of paths){const r=await run(p);assert.equal(r.statusCode,409,JSON.stringify(r.payload));assert.equal(r.payload.code,'TRIP_CHECKLIST_REQUIRED');}
   assert.equal((await h.one('select status from trips where id=$1',[trip.id])).status,'Asignado');assert.equal((await h.one('select count(*)::int n from trip_status_history where trip_id=$1',[trip.id])).n,0);
   const check=await h.run(driver.token,'post','/api/driver/trips/:id/workflow/checklist',{params:{id:trip.id},body:{client_key:'qa-checklist',version:0,resource_version:0,items:require('../public/checklist-shared').ids.map(id=>({id,result:'ok'}))}});assert.equal(check.statusCode,201,JSON.stringify(check.payload));
   assert.equal((await run(paths[2])).statusCode,200,JSON.stringify(errors));
   await pool.query("insert into vehicle_checklists(trip_id,truck_id,driver_id,status,items) values($1,$2,$3,'Pendiente','[]')",[trip.id,truck.id,d.id]);
   const stop=await h.run(driver.token,'patch',paths[2],{params:{id:trip.id},body:{status:'Detenido'}});assert.equal(stop.statusCode,200,JSON.stringify(stop.payload));assert.equal((await run(paths[2])).payload.code,'TRIP_CHECKLIST_REQUIRED');
  });
 }finally{await runtime.close();}
});
