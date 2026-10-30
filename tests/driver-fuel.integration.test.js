'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {embedded,harness}=require('./helpers/acceptance');
test('combustible móvil: identidad real, foto privada, reintento, rectificación y aislamiento',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Fuel móvil QA'),other=await h.company('Fuel ajeno QA');
  const call=(token,method,url,body={},params={})=>h.run(token,method,url,{body,params});
  const role=await h.one("select id from roles where code='driver'");
  const personResponse=await call(a.admin.token,'post','/api/company/people',{name:'Conductor fuel QA',rut:'12345678-5',birth_date:'1990-01-01',create_account:true,email:'fuel-driver@acceptance.invalid',password:h.password,role_id:Number(role.id),contract:{type:'indefinite',start_date:'2000-01-01'},license:{classes:['A5'],printed_expiry:'2099-12-31'}});
  assert.equal(personResponse.statusCode,201,JSON.stringify(personResponse.payload));const person=personResponse.payload.person;
  const driver=await call(a.admin.token,'post','/api/fleet/drivers',{user_id:Number(person.user_id)});assert.equal(driver.statusCode,201,JSON.stringify(driver.payload));
  const token=await h.session(person.user_id),truck=await h.one("insert into trucks(company_id,patente,tipo) values($1,'MOBFUEL','Camión') returning id",[a.id]);
  const trip=await h.one("insert into trips(company_id,trip_number,truck_id,driver_id,origin,destination,status) values($1,'MOBILE-FUEL',$2,$3,'Origen QA','Destino QA','Asignado') returning *",[a.id,truck.id,driver.payload.driver_id]);
  const png=await require('sharp')({create:{width:32,height:32,channels:3,background:'#173b5d'}}).png().toBuffer();
  const body={client_key:'mobile-fuel-key-001',version:0,resource_version:trip.resource_version,date:new Date().toISOString().slice(0,10),liters:50,odometer_km:1000,total_clp:65000,payment_method:'agreement',photo:'data:image/png;base64,'+png.toString('base64')};
  const route='/api/driver/trips/:id/fuel',params={id:trip.id};let fuel;
  await t.test('foto obligatoria en todo medio de pago, sin permisos económicos generales',async()=>{
   for(const payment_method of ['cash','debit','credit','agreement','internal']){const r=await call(token,'post',route,{...body,payment_method,photo:null},params);assert.equal(r.statusCode,400,JSON.stringify(r.payload));}
   assert.equal((await call(a.admin.token,'post',route,body,params)).statusCode,403);
   assert.equal((await call(other.admin.token,'post',route,body,params)).statusCode,403);
   assert.equal((await call(token,'post',route,{...body,resource_version:999},params)).statusCode,409);
   const r=await call(token,'post',route,body,params);assert.equal(r.statusCode,201,JSON.stringify(r.payload));fuel=r.payload;
   assert.equal(Number(fuel.total_clp),65000);assert.equal(fuel.photo_received,true);assert.equal(h.objects.size,1);
   const row=await h.one('select * from fuel where id=$1',[fuel.fuel_id]);assert.equal(String(row.truck_id),String(truck.id));assert.equal(Number(row.liters),50);
   const cost=await h.one('select v.* from trip_cost_items i join trip_cost_versions v on v.id=i.current_version_id where i.id=$1',[fuel.cost_item_id]);assert.equal(cost.status,'reconciled');assert.equal(Number(cost.amount_clp),65000);
   const file=await h.one('select * from financial_support_entries where id=$1',[fuel.attachment_id]);assert.equal(String(file.created_by),String(person.user_id));assert.deepEqual([...h.objects.values()][0],png);
   const list=await call(a.admin.token,'get','/api/fleet/fuel');assert.ok(list.payload.some(r=>String(r.id)===String(fuel.fuel_id)&&r.attachment_count===1&&r.trips.length===1));
   assert.equal((await call(token,'get','/api/fleet/fuel')).statusCode,403);
  });
  await t.test('fallo después de subir foto revierte combustible/costo y compensa el objeto privado',async()=>{
   const connect=pool.connect;
   pool.connect=async()=>{const db=await connect();return {...db,query:async(sql,args)=>{if(sql.startsWith('insert into audit_logs')&&args?.[2]==='driver_fuel')throw Error('Fallo de auditoría sintético');return db.query(sql,args);}};};
   try{const r=await call(token,'post',route,{...body,client_key:'mobile-fuel-rollback'},params);assert.equal(r.statusCode,503);assert.equal(h.objects.size,1);assert.equal(Number((await h.one('select count(*) n from fuel where company_id=$1',[a.id])).n),1);assert.equal(Number((await h.one('select count(*) n from trip_cost_items where trip_id=$1',[trip.id])).n),1);}finally{pool.connect=connect;}
  });
  await t.test('mismo envío incluso tras cierre no duplica; datos distintos y nuevo envío cerrado se rechazan',async()=>{
   await pool.query("update trips set status='Completado' where id=$1",[trip.id]);
   const replay=await call(token,'post',route,body,params);assert.equal(replay.statusCode,200,JSON.stringify(replay.payload));assert.equal(String(replay.payload.fuel_id),String(fuel.fuel_id));assert.equal(h.objects.size,1);
   assert.equal((await call(token,'post',route,{...body,total_clp:1},params)).statusCode,409);
   assert.equal((await call(token,'post',route,{...body,client_key:'mobile-fuel-key-002'},params)).statusCode,409);
   const receipts=await call(token,'get',route,{},params);assert.equal(receipts.payload.rows.length,1);assert.doesNotMatch(JSON.stringify(receipts.payload),/storage_key|companies\//);
  });
  await t.test('rectificación autorizada conserva original y fotografía sin duplicar litros ni resultado',async()=>{
   const correction='/api/fleet/fuel/:id/corrections',p={id:fuel.fuel_id},b={...body,photo:undefined,total_clp:60000,liters:48,odometer_km:1005,reason:'Corregir digitación del conductor',version:0};
   assert.equal((await call(token,'post',correction,b,p)).statusCode,403);
   assert.equal((await call(other.admin.token,'post',correction,b,p)).statusCode,409);
   assert.equal((await call(a.admin.token,'post',correction,{...b,version:999},p)).statusCode,409);
   await pool.query("update trip_finance_control set state='closed' where trip_id=$1",[trip.id]);assert.equal((await call(a.admin.token,'post',correction,b,p)).statusCode,409);
   await pool.query("update trip_finance_control set state='open' where trip_id=$1",[trip.id]);
   const connect=pool.connect;pool.connect=async()=>{const db=await connect();return {...db,query:async(sql,args)=>{if(sql.startsWith('insert into audit_logs')&&args?.[2]==='correct')throw Error('Fallo de auditoría sintético');return db.query(sql,args);}};};
   try{assert.equal((await call(a.admin.token,'post',correction,b,p)).statusCode,503);assert.equal((await h.one('select status from trip_cost_items where id=$1',[fuel.cost_item_id])).status,'active');assert.equal(Number((await h.one('select count(*) n from fuel where company_id=$1',[a.id])).n),1);}finally{pool.connect=connect;}
   const r=await call(a.admin.token,'post',correction,b,p);assert.equal(r.statusCode,201,JSON.stringify(r.payload));
   assert.equal(Number((await h.one('select total_clp from fuel where id=$1',[fuel.fuel_id])).total_clp),65000);
   assert.equal((await h.one('select status from trip_cost_items where id=$1',[fuel.cost_item_id])).status,'voided');
   const total=await h.one("select sum(v.amount_clp) n from trip_cost_items i join trip_cost_versions v on v.id=i.current_version_id where i.trip_id=$1 and i.status<>'voided' and v.status='reconciled'",[trip.id]);assert.equal(Number(total.n),60000);
   const list=await call(a.admin.token,'get','/api/fleet/fuel');assert.equal(list.payload.length,1);assert.equal(Number(list.payload[0].liters),48);assert.equal(list.payload[0].attachment_count,1);assert.equal(String(list.payload[0].correction.created_by),String(a.admin.id));
   assert.equal((await call(a.admin.token,'post',correction,b,p)).statusCode,409);assert.equal(h.objects.size,1);
   const again=await call(a.admin.token,'post',correction,{...b,total_clp:59000,reason:'Segunda corrección autorizada'}, {id:r.payload.id});assert.equal(again.statusCode,201,JSON.stringify(again.payload));
   const second=await call(a.admin.token,'get','/api/fleet/fuel');assert.equal(second.payload.length,1);assert.equal(second.payload[0].attachment_count,1);
   assert.equal((await call(token,'post',route,body,params)).statusCode,200);
   const sourceList=await call(a.admin.token,'get','/api/economics/sources');assert.equal(sourceList.payload.rows.length,1);
   // Startup executes versioned SQL again. Preserve the extended support view.
   const fs=require('node:fs'),path=require('node:path');
   for(const name of ['047_fuel_support_links.sql','049_driver_fuel.sql','050_fuel_corrections.sql','050_fuel_corrections.sql'])await runtime.execute(fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8'));
   const restarted=await call(a.admin.token,'get','/api/fleet/fuel');assert.equal(restarted.payload.length,1);assert.equal(restarted.payload[0].attachment_count,1);
  });
 }finally{await runtime.close();}
});
