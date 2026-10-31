'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {embedded,harness}=require('./helpers/acceptance');
const {recordPredepartureFixture}=require('./helpers/predeparture-fixture');

test('tracking: esquema real, Bearer real, aislamiento, fases y reintentos',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();
 try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Tracking QA'),other=await h.company('Tracking otro QA');
  // Startup replays migrations on every boot: both applications must succeed.
  const migration=fs.readFileSync(path.join(__dirname,'../migrations/053_driver_tracking.sql'),'utf8');
  await runtime.execute(migration);await runtime.execute(migration);
  const u=await h.account(a.id,'driver','Tracking conductor','12345678-5');
  const driver=await h.one("insert into drivers(company_id,name,status) values($1,'Tracking conductor','Activo') returning id",[a.id]);
  await pool.query('update users set driver_id=$2 where id=$1',[u.id,driver.id]);
  await pool.query('update company_people set driver_id=$2 where user_id=$1',[u.id,driver.id]);
  const person=await h.one('select id from company_people where user_id=$1',[u.id]);
  await pool.query("insert into person_driver_licenses(company_id,person_id,classes,printed_expiry,effective_expiry) values($1,$2,ARRAY['A5'],'2099-12-31','2099-12-31')",[a.id,person.id]);
  const truck=await h.one("insert into trucks(company_id,patente,tipo) values($1,'TRACKQA','Camión') returning id",[a.id]);
  async function makeTrip(number,status='En carga'){
   return h.one('insert into trips(company_id,trip_number,truck_id,driver_id,origin,destination,status) values($1,$2,$3,$4,\'QA origen\',\'QA destino\',$5) returning *',[a.id,number,truck.id,driver.id,status]);
  }
  const trip=await makeTrip('TRACK-1'),base='/api/driver/trips/:id/tracking';
  const call=(suffix='',body={},token=u.token,method='post',query={})=>h.run(token,method,base+suffix,{body,params:{id:trip.id},query});
  let context;
  const point=(state='active')=>({client_position_id:crypto.randomUUID(),captured_at:new Date().toISOString(),state,lat:-33,lng:-70,accuracy_m:8,speed_kmh:0});
  const batch=p=>({tracking_session_id:context.tracking_session_id,resource_version:context.resource_version,positions:p});
  await t.test('auth, aceptación y checklist obligatorios; ID estable y sin token plaintext',async()=>{
   assert.equal((await call('',{},null)).statusCode,401);
   assert.equal((await call('',{},a.admin.token)).statusCode,403);
   assert.equal((await call('',{},other.admin.token)).statusCode,403);
   assert.equal((await call()).payload.code,'TRIP_ACCEPTANCE_REQUIRED');
   await recordPredepartureFixture(pool,trip.id);
   const response=await call();assert.equal(response.statusCode,200,JSON.stringify(response.payload));context=response.payload;
   assert.equal(context.state,'active');assert.equal(context.interval_seconds,30);
   assert.equal((await call()).payload.tracking_session_id,context.tracking_session_id);
   const stored=await h.one('select * from driver_tracking_sessions where id=$1',[context.tracking_session_id]);
   assert.equal(stored.token_hash,crypto.createHash('sha256').update(u.token).digest('hex'));
   assert.ok(!JSON.stringify(stored).includes(u.token));
   assert.equal((await call('/context',{},u.token,'get')).payload.tracking_session_id,context.tracking_session_id);
  });
  await t.test('batch atómico, máximo 50, 24h, UUID y duplicados sin doble telemetry',async()=>{
   const p=point(),b=batch([p,p]);
   let r=await call('/positions',b);assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.deepEqual(r.payload.accepted_ids,[p.client_position_id]);
   assert.equal((await call('/positions',b)).statusCode,200);
   const count=()=>h.one('select count(*) n from telemetry where truck_id=$1',[truck.id]);
   assert.equal(Number((await count()).n),1);
   r=await call('/positions',batch([point(),{...p,lat:1}]));assert.equal(r.statusCode,409);assert.equal(Number((await count()).n),1);
   for(const positions of [[],Array.from({length:51},()=>point()),[{...point(),captured_at:new Date(Date.now()-86400001).toISOString()}],[{...point(),lat:'-33'}],[{...point(),client_position_id:'bad'}]])assert.equal((await call('/positions',batch(positions))).statusCode,400);
   assert.equal((await call('/positions',{...batch([point()]),resource_version:99})).statusCode,409);
   const another=await h.session(u.id);assert.equal((await call('/positions',batch([point()]),another)).statusCode,404);
  });
  await t.test('stop propio revoca; start crea UUID nuevo sin reciclar cola y conserva recibos previos',async()=>{
   const old=context,p=point();assert.equal((await call('/positions',batch([p]))).statusCode,200);
   assert.equal((await call('/stop',{tracking_session_id:old.tracking_session_id},a.admin.token)).statusCode,403);
   assert.equal((await call('/stop',{tracking_session_id:old.tracking_session_id})).payload.state,'closed');
   const restarted=await call();assert.equal(restarted.statusCode,200,JSON.stringify(restarted.payload));context=restarted.payload;
   assert.notEqual(context.tracking_session_id,old.tracking_session_id);
   assert.equal((await call()).payload.tracking_session_id,context.tracking_session_id);
   const oldBatch={tracking_session_id:old.tracking_session_id,resource_version:old.resource_version,positions:[point()]};
   assert.equal((await call('/positions',oldBatch)).statusCode,409);
   const duplicate=await call('/positions',{...oldBatch,positions:[p]});assert.equal(duplicate.statusCode,200);assert.deepEqual(duplicate.payload.accepted_ids,[p.client_position_id]);
   assert.equal(Number((await h.one('select count(*) n from driver_tracking_positions where tracking_session_id=$1',[old.tracking_session_id])).n),2);
  });
  let outing;
  await t.test('Completado conserva waiting; GPS de espera sin trip_id; fase offline previa jamás se reasocia',async()=>{
   const baseLocation=await h.one("insert into operational_locations(company_id,name,lat,lng,source) values($1,'QA base',-33,-70,'manual') returning id",[a.id]);
   outing=await h.one('insert into operational_outings(company_id,truck_id,driver_id,base_location_id,created_by) values($1,$2,$3,$4,$5) returning *',[a.id,truck.id,driver.id,baseLocation.id,u.id]);
   await pool.query('insert into operational_outing_services(company_id,outing_id,trip_id,sequence) values($1,$2,$3,1)',[a.id,outing.id,trip.id]);
   const offline=point();await pool.query("update trips set status='Completado' where id=$1",[trip.id]);
   const r=await call('/context',{},u.token,'get');assert.equal(r.statusCode,200,JSON.stringify(r.payload));context=r.payload;assert.equal(context.state,'waiting');assert.equal(String(context.outing_id),String(outing.id));
   assert.equal((await call('/positions',batch([offline]))).payload.code,'POSITION_PHASE_REVIEW');
   const p=point('waiting'),response=await call('/positions',batch([p]));assert.equal(response.statusCode,200,JSON.stringify(response.payload));
   const telemetry=await h.one('select t.* from telemetry t join driver_tracking_positions p on p.telemetry_id=t.id where p.client_position_id=$1',[p.client_position_id]);
   assert.equal(telemetry.trip_id,null);assert.equal(String(telemetry.outing_id),String(outing.id));
  });
  await t.test('retorno permanece activo hasta closed_at; closed devuelve contexto 200 y no acepta nuevos puntos',async()=>{
   await pool.query("update operational_outings set status='returning',version=version+1 where id=$1",[outing.id]);
   context=(await call('/context',{},u.token,'get')).payload;assert.equal(context.state,'returning');
   assert.equal((await call('/positions',batch([point('returning')]))).statusCode,200);
   await pool.query("update operational_outings set status='arrived_base',closed_at=now(),version=version+1 where id=$1",[outing.id]);
   const r=await call('/context',{},u.token,'get',{tracking_session_id:context.tracking_session_id});assert.equal(r.statusCode,200);assert.equal(r.payload.state,'closed');
   assert.equal((await call('/positions',batch([point('returning')]))).statusCode,409);
  });
  await t.test('reemplazo de recursos cierra con revisión; nueva aceptación permite UUID distinto',async()=>{
   const changed=await makeTrip('TRACK-REPLACE');await recordPredepartureFixture(pool,changed.id);
   const run=(suffix='',body={},method='post')=>h.run(u.token,method,base+suffix,{body,params:{id:changed.id}});
   const first=(await run()).payload;assert.ok(first.tracking_session_id);
   await pool.query('update trips set resource_version=resource_version+1 where id=$1',[changed.id]);
   const closed=await run('/context',{},'get');assert.equal(closed.statusCode,200);assert.equal(closed.payload.state,'closed');assert.equal(closed.payload.review_required,true);
   assert.equal((await run()).payload.code,'TRIP_ACCEPTANCE_REQUIRED');
   await recordPredepartureFixture(pool,changed.id);
   const next=await run();assert.equal(next.statusCode,200,JSON.stringify(next.payload));assert.notEqual(next.payload.tracking_session_id,first.tracking_session_id);assert.equal(next.payload.resource_version,first.resource_version+1);
   assert.equal((await run('/positions',{tracking_session_id:first.tracking_session_id,resource_version:first.resource_version,positions:[point()]})).statusCode,409);
  });
  await t.test('snapshot sin GPS no habilita seguimiento ni guarda sesión al fallar',async()=>{
   const denied=await h.one("insert into trips(company_id,trip_number,truck_id,driver_id,origin,destination,status,commercial_modules) values($1,'TRACK-NOGPS',$2,$3,'QA','QA','Descargando','[]') returning *",[a.id,truck.id,driver.id]);
   await recordPredepartureFixture(pool,denied.id);
   const r=await h.run(u.token,'post',base,{params:{id:denied.id}});assert.equal(r.statusCode,403,JSON.stringify(r.payload));
   assert.equal(Number((await h.one('select count(*) n from driver_tracking_sessions where trip_id=$1',[denied.id])).n),0);
  });
  await t.test('membership y sesión revocadas se revalidan con middleware real',async()=>{
   await pool.query('update user_memberships set active=false where user_id=$1',[u.id]);
   assert.ok([401,403].includes((await call('/context',{},u.token,'get')).statusCode));
   await pool.query('update user_memberships set active=true where user_id=$1',[u.id]);
   await pool.query('delete from user_sessions where user_id=$1',[u.id]);
   assert.equal((await call('/context',{},u.token,'get')).statusCode,401);
  });
 }finally{await runtime.close();}
});
