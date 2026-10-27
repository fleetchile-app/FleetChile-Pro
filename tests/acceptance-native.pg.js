'use strict';
// Deliberately separate from npm test: absence of PostgreSQL must not look like a pass.
const test=require('node:test'),assert=require('node:assert/strict');
const {nativePostgres}=require('./helpers/native-postgres'),{harness}=require('./helpers/acceptance');
test('PL43 PostgreSQL real: conexiones distintas, reservas, versiones y rollback concurrentes',{timeout:180000},async t=>{
 const runtime=await nativePostgres();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Concurrencia sintética A'),b=await h.company('Concurrencia sintética B');
  const run=(method,url,body={},params={},token=a.admin.token)=>h.run(token,method,url,{body,params});
  const create=async(url,body)=>{const r=await run('post',url,body);assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;};
  const client=await create('/api/company/clients',{name:'Cliente sintético',rut:'33333333-3'});
  const driverRole=await h.one("select id from roles where code='driver'");
  const person=(await create('/api/company/people',{name:'Conductor sintético',rut:'12345678-5',birth_date:'1990-01-01',create_account:true,email:'driver-concurrency@acceptance.invalid',password:h.password,role_id:Number(driverRole.id),contract:{type:'indefinite',start_date:'2000-01-01'},license:{classes:['A5'],printed_expiry:'2099-12-31'}})).person;
  assert.equal((await run('post','/api/fleet/drivers',{user_id:Number(person.user_id)})).statusCode,201);
  const truck=await create('/api/fleet/vehicles',{patente:'RACE01',tipo:'Camión',brand:'Sintética',model:'Sintético',capacity_t:10,circulation_expiry:'2099-12-31',soap_expiry:'2099-12-31',inspection_expiry:'2099-12-31'});
  const date=new Date(Date.now()+86400000),end=new Date(date.getTime()+3600000),trip=()=>create('/api/trips',{client_id:Number(client.id),origin:'O sintético',destination:'D sintético',planned_departure:date.toISOString(),planned_arrival:end.toISOString()});
  await t.test('comprueba backends independientes, no sesiones simuladas de PGlite',async()=>{
   const c1=await pool.connect(),c2=await pool.connect();try{const [a,b]=await Promise.all([c1.query('select pg_backend_pid() id'),c2.query('select pg_backend_pid() id')]);assert.notEqual(a.rows[0].id,b.rows[0].id);}finally{c1.release();c2.release();}
  });
  let winner;
  await t.test('dos operadores compiten por vehículo/conductor: exactamente una asignación confirma',async()=>{
   const trips=await Promise.all([trip(),trip()]),body={resource_version:0,composition_id:null,truck_id:Number(truck.id),driver_id:Number(person.driver_id),client_id:Number(client.id)},results=await Promise.all(trips.map(v=>run('patch','/api/operations/trips/:id/resources',body,{id:v.id})));
   assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409],JSON.stringify(results));winner=results.find(r=>r.statusCode===200).payload.trip;
   const loser=trips.find(v=>String(v.id)!==String(winner.id));assert.equal((await h.one('select truck_id from trips where id=$1',[loser.id])).truck_id,null);assert.equal((await h.one('select count(*)::int n from trip_resource_revisions where trip_id=$1',[winner.id])).n,2);
  });
  await t.test('dos pantallas antiguas no sobrescriben la asignación ni duplican revisiones',async()=>{
   const body={resource_version:winner.resource_version,composition_id:null,truck_id:Number(truck.id),driver_id:Number(person.driver_id),client_id:Number(client.id),reason:'Revisión concurrente sintética'},results=await Promise.all([run('patch','/api/operations/trips/:id/resources',body,{id:winner.id}),run('patch','/api/operations/trips/:id/resources',body,{id:winner.id},a.approver.token)]);
   assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409],JSON.stringify(results));assert.equal(Number((await h.one('select resource_version from trips where id=$1',[winner.id])).resource_version),Number(winner.resource_version)+1);
  });
  await t.test('edición concurrente de cliente conserva una sola versión y no filtra otra empresa',async()=>{
   const body={profile_version:Number(client.profile_version),name:'Edición sintética',reason:'Edición concurrente'},results=await Promise.all([run('patch','/api/company/clients/:id',body,{id:client.id}),run('patch','/api/company/clients/:id',body,{id:client.id},a.approver.token)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409],JSON.stringify(results));
   assert.equal((await run('patch','/api/company/clients/:id',body,{id:client.id},b.admin.token)).statusCode,404);
  });
  await t.test('fallo de auditoría no confirma reserva ni historial parcial',async()=>{
   await pool.query("update trips set status='Cancelado' where company_id=$1",[a.id]);
   const candidate=await trip();await pool.query("CREATE FUNCTION acceptance_fail_audit() RETURNS trigger AS $$ BEGIN IF NEW.action='assign_resources' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER acceptance_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION acceptance_fail_audit();");
   try{const r=await run('patch','/api/operations/trips/:id/resources',{resource_version:0,composition_id:null,truck_id:Number(truck.id),driver_id:Number(person.driver_id),client_id:Number(client.id)},{id:candidate.id});assert.ok(r.statusCode>=400);assert.equal((await h.one('select resource_version from trips where id=$1',[candidate.id])).resource_version,0);assert.equal((await h.one('select count(*)::int n from trip_resource_revisions where trip_id=$1',[candidate.id])).n,0);}finally{await pool.query('DROP TRIGGER acceptance_fail_audit ON audit_logs');}
  });
 }finally{await runtime.close();}
});
