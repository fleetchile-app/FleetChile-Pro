'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup');
const {registerMaintenanceWorkOrderRoutes}=require('../maintenance-workorders');
const {assertVehicleRoadReady}=require('../vehicle-readiness');
const BASE='/api/fleet/work-orders';
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');

test('PL07–PL13 PostgreSQL aislado: ciclo de taller, recurrencia, auditoría y disponibilidad',
 {skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),pg=new PGlite();
 const query=async(sql,values=[])=>{const r=await pg.query(sql,values);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const one=async(sql,v)=>(await query(sql,v)).rows[0],pool={query,connect:async()=>({query,release(){}})};
 let serial=0;const now=new Date(),intake=new Date(now.getTime()-7200000).toISOString(),release=new Date(now.getTime()-3600000).toISOString();
 try{
  await pg.exec(source('schema.sql'));await pg.exec(source('migrations/002_core_platform.sql'));
  for(const f of MIGRATION_FILES)await pg.exec(source('migrations/'+f));
  const role=await one("select id from roles where code='maintenance'");
  const routes=[],app={};for(const m of ['get','post','patch'])app[m]=(p,...handlers)=>routes.push({m,p,handlers});
  registerMaintenanceWorkOrderRoutes(app,pool,{now:()=>now});
  async function run(f,method,suffix,body={},params={}){
   const route=routes.find(r=>r.m===method&&r.p===BASE+suffix);assert.ok(route,suffix);
   const req={user:f.actor,params,query:method==='get'?body:{},body,ip:'127.0.0.1'};
   const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};
   const next=async i=>{let pending;await route.handlers[i](req,res,()=>{pending=next(i+1);return pending;});if(pending)await pending;};await next(0);return res;
  }
  async function fixture(){
   const n=++serial,c=await one('insert into companies(legal_name) values($1) returning id',['Taller fixture '+n]);
   const u=await one('insert into users(company_id,role_id,name,email) values($1,$2,$3,$4) returning id',[c.id,role.id,'Técnico '+n,`taller-${n}@example.invalid`]);
   await query('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3)',[c.id,u.id,role.id]);
   const truck=await one("insert into trucks(company_id,patente,tipo,km,hour_meter_hours) values($1,$2,'Camión',100,50) returning *",[c.id,'MW'+n]);
   for(const type of ['SOAP','Permiso de circulación','Revisión técnica'])await query("insert into vehicle_documents(truck_id,document_type,expires_at,status) values($1,$2,'2099-12-31','Vigente')",[truck.id,type]);
   return {cid:c.id,truck,actor:{id:u.id,name:'Técnico '+n,actor_type:'company',scope:'company',company_id:c.id,membership_id:n,permissions:['maintenance.manage','fleet.manage']}};
  }
  async function create(f,extra={}){
   const r=await run(f,'post','',{mode:'receive',truck_id:f.truck.id,reason:'Revisión y reparación',maintenance_type:'Preventiva',received_at:intake,odometer_km:100,hour_meter_hours:50,...extra});
   assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;
  }
  async function edit(f,o,route,body={},method='post',extraParams={}){
   return run(f,method,route,{work_order_version:o.work_order_version,...body},{id:o.id,...extraParams});
  }
  async function prepare(f,o){const r=await edit(f,o,'/:id',{diagnosis:'Diagnóstico verificado',work_summary:'Trabajos realizados según diagnóstico'},'patch');assert.equal(r.statusCode,200,JSON.stringify(r.payload));return r.payload;}

  await t.test('migración idempotente; históricos conservan costo y no reciben ingreso ficticio',async()=>{
   const f=await fixture(),legacy=await one("insert into maintenance(company_id,truck_id,item,cost_clp,status) values($1,$2,'Histórico',185000,'Pendiente') returning *",[f.cid,f.truck.id]);
   await pg.exec(source('migrations/033_maintenance_workorders.sql'));
   const after=await one('select * from maintenance where id=$1',[legacy.id]);assert.equal(after.operation_stage,null);assert.equal(after.received_at,null);assert.equal(after.cost_clp,legacy.cost_clp);
  });
  await t.test('programar no inmoviliza; ingresar exige odómetro y registra autor sin inventar costos',async()=>{
   const f=await fixture(),scheduled=await create(f,{mode:'schedule',scheduled_for:'2099-01-01'});
   assert.equal(scheduled.operation_stage,'scheduled');assert.equal(scheduled.cost_clp,null);assert.equal(scheduled.received_at,null);
   assert.equal((await one('select status from trucks where id=$1',[f.truck.id])).status,'Disponible');
   const bad=await edit(f,scheduled,'/:id/receive',{received_at:intake});assert.equal(bad.statusCode,400);
   const received=await edit(f,scheduled,'/:id/receive',{received_at:intake,odometer_km:100,hour_meter_hours:50});assert.equal(received.statusCode,200,JSON.stringify(received.payload));
   assert.equal(received.payload.operation_stage,'received');assert.equal(received.payload.readings.length,1);assert.equal(received.payload.costs.actual,null);
   assert.equal(received.payload.events[0].actor_name,f.actor.name);assert.equal(String(received.payload.events[0].actor_user_id),String(f.actor.id));
   await assert.rejects(assertVehicleRoadReady(pool,{companyId:f.cid,truckId:f.truck.id}),e=>e.code==='VEHICLE_NOT_ROAD_READY');
  });
  await t.test('rechaza ingreso con viaje en ejecución, segunda recepción, responsable o conductor ajenos',async()=>{
   const f=await fixture(),other=await fixture();
   await query("insert into trips(company_id,truck_id,trip_number,origin,destination,status) values($1,$2,$3,'A','B','En tránsito')",[f.cid,f.truck.id,'TEST-MW-'+serial]);
   const body={mode:'receive',truck_id:f.truck.id,reason:'Ingreso',maintenance_type:'Correctiva',received_at:intake,odometer_km:100};
   assert.equal((await run(f,'post','',body)).statusCode,409);
   assert.equal((await one('select count(*)::int n from maintenance where company_id=$1',[f.cid])).n,0);
   await query("update trips set status='Completado' where company_id=$1",[f.cid]);
   assert.equal((await run(f,'post','',{...body,responsible_user_id:other.actor.id})).statusCode,400);
   const driver=await one("insert into drivers(company_id,name) values($1,'Ajeno') returning id",[other.cid]);
   assert.equal((await run(f,'post','',{...body,delivered_by_driver_id:driver.id})).statusCode,400);
   await create(f);assert.equal((await run(f,'post','',body)).statusCode,409);
  });
  await t.test('ciclo completo: hallazgo reparado/verificado, liberación sin precio y cierre financiero posterior',async()=>{
   const f=await fixture();let o=await prepare(f,await create(f));
   let r=await edit(f,o,'/:id/items',{kind:'part',description:'Filtro',quantity:2,estimated_unit_cost_clp:5000,status:'done'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));o=r.payload;
   assert.equal(o.costs.estimated,10000);assert.equal(o.costs.actual,null);
   r=await edit(f,o,'/:id/findings',{description:'Fuga detectada',severity:'critical',responsible_user_id:f.actor.id});assert.equal(r.statusCode,200);o=r.payload;const finding=o.findings[0];
   const releaseBody={released_at:release,odometer_km:105,hour_meter_hours:51,release_note:'Prueba técnica satisfactoria'};
   assert.equal((await edit(f,o,'/:id/release',releaseBody)).statusCode,409);
   assert.equal((await edit(f,o,'/:id/findings/:findingId',{state:'verified',remedy:'Intento directo'},'patch',{findingId:finding.id})).statusCode,409);
   r=await edit(f,o,'/:id/findings/:findingId',{state:'fixed',remedy:'Sello reemplazado'},'patch',{findingId:finding.id});assert.equal(r.statusCode,200);o=r.payload;
   r=await edit(f,o,'/:id/findings/:findingId',{state:'verified',remedy:'Se verificó ausencia de fuga'},'patch',{findingId:finding.id});assert.equal(r.statusCode,200);o=r.payload;
   r=await edit(f,o,'/:id/release',releaseBody);assert.equal(r.statusCode,200,JSON.stringify(r.payload));o=r.payload;
   assert.equal(o.operation_stage,'released');assert.equal(o.cost_clp,null);assert.ok(Math.abs(Number(o.downtime_hours)-1)<0.001);
   assert.equal((await one('select status from trucks where id=$1',[f.truck.id])).status,'Disponible');
   assert.equal((await assertVehicleRoadReady(pool,{companyId:f.cid,truckId:f.truck.id})).allowed,true);
   assert.equal((await edit(f,o,'/:id/close')).statusCode,409);
   const line=o.lines[0];r=await edit(f,o,'/:id/items/:itemId',{actual_unit_cost_clp:6000},'patch',{itemId:line.id});assert.equal(r.statusCode,200);o=r.payload;
   assert.equal((await edit(f,o,'/:id/items/:itemId',{description:'Reescribir trabajo'},'patch',{itemId:line.id})).statusCode,409);
   r=await edit(f,o,'/:id/close');assert.equal(r.statusCode,200,JSON.stringify(r.payload));o=r.payload;
   assert.equal(o.operation_stage,'closed');assert.equal(Number(o.cost_clp),12000);assert.equal(Number(o.parts_cost_clp),12000);
   assert.equal((await edit(f,o,'/:id',{work_summary:'Reescritura'},'patch')).statusCode,409);
   assert.equal((await one("select count(*)::int n from audit_logs where company_id=$1 and entity='maintenance_work_order'",[f.cid])).n,o.events.length);
   await assert.rejects(query('delete from maintenance where id=$1',[o.id]),/no puede eliminarse/i);
   await assert.rejects(query('update maintenance_meter_readings set odometer_km=0 where maintenance_id=$1',[o.id]),/inmutable/i);
  });
  await t.test('rutina por días/km/horas programa siguiente orden al liberar; cero requiere confirmación',async()=>{
   const f=await fixture();let o=await prepare(f,await create(f,{routine:{name:'Servicio periódico',days:30,km:1000,hours:100}}));
   let r=await edit(f,o,'/:id/release',{released_at:release,odometer_km:110,hour_meter_hours:55,release_note:'Inspección sin repuestos'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));o=r.payload;
   const next=await one('select * from maintenance where previous_work_order_id=$1',[o.id]);assert.equal(next.operation_stage,'scheduled');assert.equal(Number(next.next_due_odometer_km),1110);assert.equal(Number(next.next_due_hours),155);assert.ok(next.due);
   assert.equal((await one('select status from trucks where id=$1',[f.truck.id])).status,'Disponible');
   assert.equal((await edit(f,o,'/:id/close')).statusCode,400);
   r=await edit(f,o,'/:id/close',{zero_cost_reason:'Inspección interna sin costo adicional'});assert.equal(r.statusCode,200);assert.equal(Number(r.payload.cost_clp),0);
  });
  await t.test('aislamiento, falta de permiso, versión obsoleta y cancelación sin falsa liberación',async()=>{
   const f=await fixture(),other=await fixture(),o=await create(f,{mode:'schedule',scheduled_for:'2099-01-01'});
   assert.equal((await run(other,'get','/:id',{}, {id:o.id})).statusCode,404);
   assert.equal((await edit(other,o,'/:id/cancel',{reason:'Ajeno'})).statusCode,404);
   const denied={...f,actor:{...f.actor,permissions:[]}};assert.equal((await run(denied,'get','')).statusCode,403);
   const stale=await edit(f,o,'/:id',{work_order_version:999,reason:'Pantalla antigua'},'patch');assert.equal(stale.statusCode,409);assert.equal(stale.payload.code,'MAINTENANCE_CONFLICT');
   const result=await edit(f,o,'/:id/cancel',{reason:'Reprogramado por operación'});assert.equal(result.statusCode,200);assert.equal(result.payload.operation_stage,'cancelled');
   const active=await create(f);assert.equal((await edit(f,active,'/:id/cancel',{reason:'No se debe liberar así'})).statusCode,409);
   assert.equal((await one('select status from trucks where id=$1',[f.truck.id])).status,'Mantención');
  });
  await t.test('lecturas monotónicas, rollback real si falla auditoría o evento',async()=>{
   const f=await fixture();const o=await create(f);
   assert.equal((await edit(f,o,'/:id/meters',{reading_at:release,odometer_km:90,reason:'Incorrecta'})).statusCode,400);
   for(const table of ['audit_logs','maintenance_work_order_events']){
    await pg.exec(`create function mw_fail() returns trigger as $$ begin raise exception 'fallo controlado'; end $$ language plpgsql; create trigger mw_fail before insert on ${table} for each row execute function mw_fail();`);
    try{const r=await edit(f,o,'/:id/meters',{reading_at:release,odometer_km:120,hour_meter_hours:70,reason:'Lectura'});assert.equal(r.statusCode,500);
     assert.equal(Number((await one('select km from trucks where id=$1',[f.truck.id])).km),100);
     assert.equal((await one('select count(*)::int n from maintenance_meter_readings where maintenance_id=$1',[o.id])).n,1);
     assert.equal((await one('select work_order_version from maintenance where id=$1',[o.id])).work_order_version,1);
    }finally{await pg.exec(`drop trigger mw_fail on ${table}; drop function mw_fail();`);}
   }
  });
  await t.test('maintenance.manage no amplía fleet.manage; la programación no necesita mutar la flota',async()=>{
   const f=await fixture(),limited={...f,actor:{...f.actor,permissions:['maintenance.manage']}},o=await create(f,{mode:'schedule',scheduled_for:'2099-01-01'});
   const read=await run(limited,'get','/options');assert.equal(read.statusCode,200);assert.equal(read.payload.can_operate_fleet,false);
   const denied=await edit(limited,o,'/:id/receive',{received_at:intake,odometer_km:100});assert.equal(denied.statusCode,403);
   assert.equal((await one('select status from trucks where id=$1',[f.truck.id])).status,'Disponible');
  });
  await t.test('programación por lecturas sin fecha y no retroceso cronológico',async()=>{
   const f=await fixture(),o=await create(f,{mode:'schedule',scheduled_odometer_km:100,scheduled_hours:50});assert.equal(o.due,null);
   const list=await run(f,'get','');assert.equal(list.payload.rows[0].overdue,true);
   let r=await edit(f,o,'/:id/receive',{received_at:intake,odometer_km:100,hour_meter_hours:50});assert.equal(r.statusCode,200);let active=await prepare(f,r.payload);
   const late=new Date(now.getTime()-1800000).toISOString();r=await edit(f,active,'/:id/meters',{reading_at:late,odometer_km:110,reason:'Prueba posterior'});assert.equal(r.statusCode,200);active=r.payload;
   r=await edit(f,active,'/:id/release',{released_at:release,odometer_km:110,release_note:'Fecha incorrecta'});assert.equal(r.statusCode,400);
   assert.equal((await one('select status from trucks where id=$1',[f.truck.id])).status,'Mantención');
  });
  await t.test('fallo de auditoría al liberar revierte disponibilidad, lecturas y próxima rutina',async()=>{
   const f=await fixture(),o=await prepare(f,await create(f,{routine:{name:'Rutina de rollback',days:30}}));
   await pg.exec("create function mw_release_fail() returns trigger as $$ begin if NEW.action='technical_release' then raise exception 'fallo controlado'; end if; return NEW; end $$ language plpgsql; create trigger mw_release_fail before insert on audit_logs for each row execute function mw_release_fail();");
   try{
    const r=await edit(f,o,'/:id/release',{released_at:release,odometer_km:120,release_note:'Prueba de rollback'});assert.equal(r.statusCode,500);
    const header=await one('select * from maintenance where id=$1',[o.id]);assert.equal(header.released_at,null);assert.equal(header.work_order_version,o.work_order_version);
    assert.equal((await one('select count(*)::int n from maintenance where previous_work_order_id=$1',[o.id])).n,0);
    const truck=await one('select status,km from trucks where id=$1',[f.truck.id]);assert.equal(truck.status,'Mantención');assert.equal(Number(truck.km),100);
    assert.equal((await one('select count(*)::int n from maintenance_meter_readings where maintenance_id=$1',[o.id])).n,1);
   }finally{await pg.exec('drop trigger mw_release_fail on audit_logs; drop function mw_release_fail();');}
  });
  await t.test('checklist pendiente exige hallazgo vinculado y verificado; liberar resuelve sólo esa alerta',async()=>{
   const f=await fixture(),trip=await one("insert into trips(company_id,truck_id,trip_number,origin,destination,status) values($1,$2,$3,'A','B','Completado') returning id",[f.cid,f.truck.id,'CHECK-MW-'+serial]);
   const c=await one("insert into vehicle_checklists(truck_id,trip_id,status) values($1,$2,'Rechazado') returning id",[f.truck.id,trip.id]);
   const a=await one("insert into alerts(company_id,source_type,source_id,condition_code,resolved) values($1,'checklist',$2,'checklist_rejected',false) returning id",[f.cid,c.id]);
   let o=await prepare(f,await create(f));const releaseBody={released_at:release,odometer_km:100,release_note:'Frenos probados'};
   assert.equal((await edit(f,o,'/:id/release',releaseBody)).statusCode,409);
   let r=await edit(f,o,'/:id/findings',{description:'Frenos',severity:'minor',source_alert_id:a.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));o=r.payload;
   assert.equal(o.findings[0].severity,'critical');const findingId=o.findings[0].id;
   for(const state of ['fixed','verified']){r=await edit(f,o,'/:id/findings/:findingId',{state,remedy:'Reparación y prueba de frenos'},'patch',{findingId});assert.equal(r.statusCode,200);o=r.payload;}
   r=await edit(f,o,'/:id/release',releaseBody);assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   const alert=await one('select * from alerts where id=$1',[a.id]);assert.equal(alert.resolved,true);assert.equal(String(alert.resolved_by),String(f.actor.id));assert.match(alert.resolution_note,/OT #/);
  });
 }finally{await pg.close();}
});
