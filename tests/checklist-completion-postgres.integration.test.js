'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{embedded,harness}=require('./helpers/acceptance'),C=require('../public/checklist-shared');
test('checklist SQL: todas las entradas, autoría, histórico, regularización e integridad',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,sqlErrors=[],connect=pool.connect.bind(pool);pool.connect=async()=>{const db=await connect(),query=db.query;db.query=async(...args)=>{try{return await query(...args)}catch(e){sqlErrors.push({code:e.code,message:e.message});throw e;}};return db;};
  const h=await harness(pool),a=await h.company('Checklist sintético A'),b=await h.company('Checklist sintético B'),driver=await h.account(a.id,'driver','Conductor sintético','12345678-5');
  const d=await h.one("insert into drivers(company_id,name,rut,status,operational_registered_at) values($1,'Conductor sintético','12345678-5','Activo',now()) returning id",[a.id]);
  await pool.query('update users set driver_id=$1 where id=$2',[d.id,driver.id]);await pool.query('update company_people set driver_id=$1 where user_id=$2',[d.id,driver.id]);
  const person=await h.one('select id from company_people where user_id=$1',[driver.id]);await pool.query("insert into person_driver_licenses(company_id,person_id,classes,printed_expiry,effective_expiry) values($1,$2,ARRAY['A5'],'2099-12-31','2099-12-31')",[a.id,person.id]);
  const truck=await h.one("insert into trucks(company_id,patente,tipo) values($1,'CHK042','Camión') returning id",[a.id]),client=await h.one("insert into clients(company_id,name) values($1,'Cliente sintético') returning id",[a.id]);let serial=0;
  const trip=async(number)=>h.one("insert into trips(company_id,truck_id,driver_id,client_id,trip_number,origin,destination,status) values($1,$2,$3,$4,$5,'O sintético','D sintético','Asignado') returning *",[a.id,truck.id,d.id,client.id,number||'CHECK-042-'+ ++serial]);
  const run=(token,method,url,body={},params={})=>h.run(token,method,url,{body,params}),items=C.ids.map(id=>({id,result:'ok'})),mobile='/api/driver/trips/:id/workflow/checklist';
  const submit=(v,body,token=driver.token)=>run(token,'post',mobile,{version:0,resource_version:0,client_key:'check-'+ ++serial,items,...body},{id:v.id});
  await t.test('admin y PWA rechazan vacíos, parciales y resultados contradictorios; no quedan escrituras',async()=>{
   const v=await trip();for(const bad of [[],items.slice(1),[...items.slice(1),items[1]]]){
    const admin=await run(a.admin.token,'post','/api/operations/trips/:id/checklist',{truck_id:Number(truck.id),driver_id:Number(d.id),status:'Aprobado',items:bad},{id:v.id});assert.equal(admin.statusCode,400,JSON.stringify(admin.payload));
    assert.equal((await submit(v,{items:bad})).statusCode,400);
   }
   const mismatch=await run(a.admin.token,'post','/api/operations/trips/:id/checklist',{truck_id:Number(truck.id),status:'Aprobado',items:items.map((i,n)=>({...i,result:n?'ok':'fail'}))},{id:v.id});assert.equal(mismatch.statusCode,400);assert.equal((await h.one('select count(*)::int n from vehicle_checklists where trip_id=$1',[v.id])).n,0);
  });
  await t.test('camino antiguo no aprueba pendiente vacío y registra el cierre con su autor real',async()=>{
   const v=await trip(),created=await run(driver.token,'post','/api/driver/trips/:id/checklist',{}, {id:v.id});assert.equal(created.statusCode,201,JSON.stringify(created.payload));
   const id=created.payload.id;let r=await run(driver.token,'patch','/api/driver/checklists/:id',{status:'Aprobado',items:[]},{id});assert.equal(r.statusCode,400);assert.equal((await h.one('select status from vehicle_checklists where id=$1',[id])).status,'Pendiente');
   r=await run(driver.token,'patch','/api/driver/checklists/:id',{status:'Aprobado',items},{id});assert.equal(r.statusCode,200,JSON.stringify({payload:r.payload,sqlErrors}));const row=await h.one('select * from vehicle_checklists where id=$1',[id]);assert.equal(Number(row.created_by),driver.id);assert.equal(Number(row.completed_by),driver.id);assert.equal(row.completed_by_name,'Conductor sintético');assert.ok(row.completed_at);
  });
  await t.test('reproducción sintética V-2026-4B4724: no borra histórico y crea inspección nueva trazable',async()=>{
   const v=await trip('V-2026-4B4724'),old=await h.one("insert into vehicle_checklists(truck_id,driver_id,trip_id,status,items) values($1,$2,$3,'Aprobado','[]') returning *",[truck.id,d.id,v.id]);
   const shown=await run(driver.token,'get','/api/driver/trips/:id/checklist',{}, {id:v.id});assert.equal(shown.payload.checklists[0].quality.complete,false);assert.equal(shown.payload.checklists[0].completed_by,null);
   assert.equal((await submit(v,{})).statusCode,409);assert.equal((await submit(v,{supersedes_id:old.id})).statusCode,409);
   const body={supersedes_id:old.id,reason:'Inspección nueva: histórico sin respuestas',client_key:'regularization-fixed'};let r=await submit(v,body);assert.equal(r.statusCode,201,JSON.stringify(r.payload));const next=r.payload;
   assert.equal(Number(next.supersedes_id),Number(old.id));assert.equal(Number(next.completed_by),driver.id);assert.deepEqual((await h.one('select * from vehicle_checklists where id=$1',[old.id])),old);
   r=await submit(v,body);assert.equal(r.statusCode,200);assert.equal(Number(r.payload.id),Number(next.id));assert.equal((await h.one('select count(*)::int n from vehicle_checklists where trip_id=$1',[v.id])).n,2);
   assert.equal((await run(b.admin.token,'get','/api/driver/trips/:id/checklist',{}, {id:v.id})).statusCode,403);
   const audit=await h.one("select after_data from audit_logs where entity='vehicle_checklist' and entity_id=$1 order by id desc limit 1",[String(next.id)]);assert.equal(audit.after_data.regularization_reason,body.reason);
  });
  await t.test('rechazo no se elude mediante regularización aunque le falten controles históricos',async()=>{
   const v=await trip(),old=await h.one("insert into vehicle_checklists(truck_id,driver_id,trip_id,status,items) values($1,$2,$3,'Rechazado','[]') returning id",[truck.id,d.id,v.id]);assert.equal((await submit(v,{supersedes_id:old.id,reason:'No debe eludir rechazo'})).statusCode,409);assert.equal((await h.one('select count(*)::int n from vehicle_checklists where trip_id=$1',[v.id])).n,1);
  });
  await t.test('fallo de auditoría revierte inspección nueva y recibo sin tocar el histórico',async()=>{
   const v=await trip(),old=await h.one("insert into vehicle_checklists(truck_id,driver_id,trip_id,status,items) values($1,$2,$3,'Aprobado','[]') returning id",[truck.id,d.id,v.id]);
   await pool.query("CREATE FUNCTION checklist_fail_audit() RETURNS trigger AS $$ BEGIN IF NEW.entity='vehicle_checklist' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;");await pool.query('CREATE TRIGGER checklist_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION checklist_fail_audit()');
   try{assert.equal((await submit(v,{supersedes_id:old.id,reason:'Inspección de prueba'})).statusCode,500);assert.equal((await h.one('select count(*)::int n from vehicle_checklists where trip_id=$1',[v.id])).n,1);assert.equal((await h.one('select count(*)::int n from driver_mobile_actions where trip_id=$1',[v.id])).n,0);}finally{await pool.query('DROP TRIGGER checklist_fail_audit ON audit_logs');}
  });
  await t.test('registro administrativo completo conserva al administrador como autor, no lo atribuye al conductor',async()=>{
   const v=await trip(),r=await run(a.admin.token,'post','/api/operations/trips/:id/checklist',{truck_id:Number(truck.id),driver_id:Number(d.id),status:'Aprobado',items},{id:v.id});assert.equal(r.statusCode,201,JSON.stringify({payload:r.payload,sqlErrors}));assert.equal(Number(r.payload.completed_by),a.admin.id);assert.match(r.payload.completed_by_name,/admin/);
  });
 }finally{await runtime.close();}
});
