'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {embedded,harness}=require('./helpers/acceptance');
const Engine=require('../company-purge-engine');
test('eliminación empresarial aislada: alcance, identidades, auditoría y rollback',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Eliminar QA'),b=await h.company('Conservar QA');
  const platform=await h.account(null,'platform_superadmin','Root QA');
  const truck=await h.one("insert into trucks(company_id,patente,tipo) values($1,'PURGE1','Camión') returning id",[a.id]);
  const trip=await h.one("insert into trips(company_id,trip_number,truck_id,origin,destination) values($1,'PURGE1',$2,'O','D') returning id",[a.id,truck.id]);
  await pool.query("insert into trip_loads(trip_id,cargo) values($1,'Carga QA')",[trip.id]);
  const before=await h.one('select count(*)::int n from companies');
  await pool.query('BEGIN');let plan;
  try{plan=await Engine.plan(pool,a.id,{lock:true});await Engine.erase(pool,a.id,plan);assert.equal((await pool.query('select 1 from companies where id=$1',[a.id])).rows.length,0);await pool.query('ROLLBACK');}catch(e){await pool.query('ROLLBACK');throw e;}
  assert.equal((await h.one('select count(*)::int n from companies')).n,before.n);
  await pool.query('BEGIN');try{plan=await Engine.plan(pool,a.id,{lock:true});await Engine.erase(pool,a.id,plan);await pool.query('COMMIT');}catch(e){await pool.query('ROLLBACK');throw e;}
  assert.ok(await h.one('select id from companies where id=$1',[b.id]));assert.ok(await h.one('select id from users where id=$1 and active=true',[platform.id]));assert.ok(await h.one('select id from users where id=$1 and active=true',[b.admin.id]));
  assert.ok(await h.one('select id from users where id=$1 and active=false and company_id is null and password_hash is null',[a.admin.id]));
  assert.equal((await pool.query('select 1 from trips where id=$1',[trip.id])).rows.length,0);
  await t.test('API: contraseña, frase, sesión, consumo único, ámbito global y limpieza privada',async()=>{
   const base='/api/admin/company-purge',target=await h.company('API borrar QA'),p={id:target.id};
   const call=(token,method,path,body={},params=p,headers={})=>h.run(token,method,path,{body,params,headers});
   assert.equal((await call(b.admin.token,'get',base)).statusCode,403);
   const support=await h.account(null,'platform_support','Soporte QA');assert.equal((await call(support.token,'get',base)).statusCode,403);
   assert.equal((await call(platform.token,'get',base,{},p,{'x-company-context':String(b.id)})).statusCode,403);
   const get=()=>call(platform.token,'post',base+'/:id/challenge');
   const first=await get();assert.equal(first.statusCode,200,JSON.stringify(first.payload));assert.equal(first.payload.phrase.split(' ').length,5);
   const payload={challenge_id:first.payload.challenge_id,phrase:first.payload.phrase,password:'incorrecta',reason:'Datos ficticios de prueba'};
   assert.equal((await call(platform.token,'post',base+'/:id/execute',payload)).statusCode,403);
   assert.equal((await call(platform.token,'post',base+'/:id/execute',{...payload,password:h.password})).statusCode,409);assert.ok(await h.one('select id from companies where id=$1',[target.id]));
   const second=(await get()).payload,otherSession=await h.session(platform.id),valid={...payload,challenge_id:second.challenge_id,phrase:second.phrase,password:h.password};
   assert.notEqual(second.phrase,first.payload.phrase);
   assert.equal((await call(otherSession,'post',base+'/:id/execute',valid)).statusCode,409);
   const fuel=await h.one("insert into fuel(company_id,date,truck,liters,price_clp,total_clp) values($1,current_date,'QA',1,1000,1000) returning id",[target.id]);
   const key=`companies/${target.id}/financial-support/qa-private`;
   await pool.query("insert into financial_support_entries(company_id,fuel_id,storage_key,mime_type,size,sha256,created_by) values($1,$2,$3,'image/png',3,$4,$5)",[target.id,fuel.id,key,'a'.repeat(64),target.admin.id]);h.objects.set(key,Buffer.from('abc'));
   await pool.query('BEGIN');try{await pool.query('create table purge_foreign_fixture(id integer primary key,company_id bigint references companies(id),fuel_id integer references fuel(id))');await pool.query('insert into purge_foreign_fixture values(1,$1,$2)',[b.id,fuel.id]);await assert.rejects(Engine.plan(pool,target.id,{lock:true}),/otra empresa/);}finally{await pool.query('ROLLBACK');}
   const connect=pool.connect;pool.connect=async()=>{const db=await connect();return {...db,query:async(sql,args)=>{if(sql.startsWith('insert into audit_logs')&&args?.[2]==='company_purge')throw Error('Fallo de auditoría sintético');return db.query(sql,args);}};};
   try{assert.equal((await call(platform.token,'post',base+'/:id/execute',valid)).statusCode,503);assert.ok(await h.one('select id from companies where id=$1',[target.id]));assert.ok(await h.one('select id from users where id=$1 and active=true',[target.admin.id]));assert.equal((await pool.query('select 1 from platform_company_purge_jobs where target_company_id=$1',[target.id])).rows.length,0);}finally{pool.connect=connect;}
   const expired=(await get()).payload;await pool.query("update platform_company_purge_challenges set expires_at=now()-interval '1 second' where id=$1",[expired.challenge_id]);assert.equal((await call(platform.token,'post',base+'/:id/execute',{...valid,challenge_id:expired.challenge_id,phrase:expired.phrase})).statusCode,409);
   const stale=(await get()).payload;await pool.query("update companies set legal_name='Nombre cambiado QA' where id=$1",[target.id]);assert.equal((await call(platform.token,'post',base+'/:id/execute',{...valid,challenge_id:stale.challenge_id,phrase:stale.phrase})).statusCode,409);
   const sharedRole=await h.one("select id from roles where code='company_admin'");await pool.query('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3)',[b.id,target.approver.id,sharedRole.id]);
   await pool.query('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3)',[target.id,platform.id,sharedRole.id]);
   const fresh=(await get()).payload;
   const r=await call(platform.token,'post',base+'/:id/execute',{...valid,challenge_id:fresh.challenge_id,phrase:fresh.phrase});assert.equal(r.statusCode,202,JSON.stringify(r.payload));assert.equal(r.payload.database_deleted,true);assert.equal(h.objects.size,1);
   assert.ok(await h.one('select id from users where id=$1 and active=true and name<>\'Cuenta eliminada\'',[target.approver.id]));
   assert.ok(await h.one('select id from users where id=$1 and active=true and password_hash is not null',[platform.id]));
   assert.equal((await pool.query('select 1 from companies where id=$1',[target.id])).rows.length,0);assert.ok(await h.one("select id from audit_logs where action='company_purge' and company_id is null"));
   const remove=h.storage.delete;h.storage.delete=async()=>{throw Error('Fallo S3 sintético');};
   assert.equal((await call(platform.token,'post',base+'/jobs/:jobId/cleanup',{}, {jobId:r.payload.job_id})).statusCode,503);assert.equal((await h.one('select status from platform_company_purge_jobs where id=$1',[r.payload.job_id])).status,'files_pending');
   h.storage.delete=remove;
   const cleanup=await call(platform.token,'post',base+'/jobs/:jobId/cleanup',{}, {jobId:r.payload.job_id});assert.equal(cleanup.statusCode,200,JSON.stringify(cleanup.payload));assert.equal(cleanup.payload.status,'complete');assert.equal(h.objects.size,0);
   const safe=(await pool.query("select t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='financial_support_entries' and t.tgname='financial_support_immutable'")).rows[0];assert.equal(safe.tgenabled,'O');
  });
 }finally{await runtime.close();}
});
