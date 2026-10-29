'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {embedded,harness}=require('./helpers/acceptance');
const BASE='/api/operations/trips/:id/itinerary/saved-routes';
test('recorridos guardados: catálogo empresarial independiente del servicio',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Recorridos QA A'),b=await h.company('Recorridos QA B');
  const trip=await h.one("insert into trips(company_id,trip_number,origin,destination) values($1,'SAVED-ROUTE-QA','Origen original','Destino original') returning *",[a.id]);
  const point=async(cid,name,lat=-36)=>h.one("insert into operational_locations(company_id,name,lat,lng,source) values($1,$2,$3,-73,'synthetic-test') returning id",[cid,name,lat]);
  const p=await point(a.id,'Aserradero sintético'),q=await point(a.id,'Bodega sintética'),other=await point(b.id,'Ubicación ajena');
  const run=(method,body={},token=a.admin.token,query={})=>h.run(token,method,BASE,{body,params:{id:trip.id},query});
  const data={origin_location_id:p.id,destination_location_id:q.id};let saved;
  await t.test('guardar puntos propios no asigna recursos, inicia viaje ni inventa distancia',async()=>{
   const r=await run('post',data);assert.equal(r.statusCode,201,JSON.stringify(r.payload));saved=r.payload;
   const row=await h.one('select * from routes where id=$1',[saved.id]);assert.equal(row.company_id,a.id);assert.equal(row.truck_id,null);assert.equal(row.truck,null);assert.equal(row.distance_km,null);assert.equal(row.progress,0);assert.equal(row.status,'Planificada');
   assert.deepEqual(await h.one('select * from trips where id=$1',[trip.id]),trip);
   assert.equal((await h.one('select count(*)::int n from trip_itinerary_revisions where trip_id=$1',[trip.id])).n,0);
   const event=await h.one("select user_id,after_data from audit_logs where entity='route' and entity_id=$1",[String(saved.id)]);assert.equal(Number(event.user_id),a.admin.id);assert.equal(event.after_data.purpose,'saved_endpoints');
  });
  await t.test('reintento reutiliza el par sin duplicar ni editar el registro existente',async()=>{
   const r=await run('post',data);assert.equal(r.statusCode,200);assert.equal(r.payload.reused,true);assert.equal(r.payload.id,saved.id);
   assert.equal((await h.one('select count(*)::int n from routes where company_id=$1',[a.id])).n,1);
  });
  await t.test('referencias históricas y rutas sin coordenadas se conservan y no se presentan como utilizables',async()=>{
   const legacy=await h.one("insert into routes(company_id,origin,destination,progress,status) values($1,'Punto histórico','Destino histórico',65,'En curso') returning id",[a.id]);
   await pool.query('update trips set route_id=$1 where id=$2',[legacy.id,trip.id]);
   await h.one("insert into routes(company_id,origin,destination) values($1,'SECRETO B','DESTINO B') returning id",[b.id]);
   const r=await run('get');assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.total,2);assert.equal(r.payload.rows.find(x=>x.id===legacy.id).can_use,false);assert.equal(r.payload.rows.find(x=>x.id===saved.id).can_use,true);
   assert.doesNotMatch(JSON.stringify(r.payload),/SECRETO|truck|progress|status/);
   assert.equal((await h.one('select route_id from trips where id=$1',[trip.id])).route_id,legacy.id);
  });
  await t.test('API directa no cruza empresas ni acepta datos de ejecución en el catálogo',async()=>{
   assert.equal((await run('post',{...data,destination_location_id:other.id})).statusCode,400);
   assert.equal((await run('get',{},b.admin.token)).statusCode,404);
   assert.equal((await run('post',{...data,truck_id:1})).statusCode,400);
   assert.equal((await run('post',{...data,company_id:b.id})).statusCode,400);
   assert.equal((await run('post',{...data,origin_location_id:[]})).statusCode,400);
   assert.equal((await run('get',{},a.admin.token,{page:'-1'})).statusCode,400);
   const viewer=await h.account(a.id,'viewer','Consulta QA','33333333-3');assert.equal((await run('get',{},viewer.token)).statusCode,403);
  });
  await t.test('paginación y búsqueda no mezclan recorridos ni convierten comodines en SQL',async()=>{
   for(let i=0;i<26;i++)await pool.query('insert into routes(company_id,origin,destination) values($1,$2,$3)',[a.id,'Escala de recorrido '+i,'Destino']);
   const first=await run('get',{},a.admin.token,{q:'Escala de recorrido',page:'1'}),last=await run('get',{},a.admin.token,{q:'Escala de recorrido',page:'2'});
   assert.equal(first.payload.total,26);assert.equal(first.payload.rows.length,25);assert.equal(last.payload.rows.length,1);assert.equal(new Set([...first.payload.rows,...last.payload.rows].map(r=>r.id)).size,26);
   assert.equal((await run('get',{},a.admin.token,{q:"%' OR 1=1 --"})).payload.total,0);
  });
  await t.test('fallo de auditoría revierte el nuevo recorrido',async()=>{
   const next=await point(a.id,'Otro destino');
   await pool.query("create function saved_route_audit_fail() returns trigger as $$ begin if NEW.entity='route' then raise exception 'synthetic rollback'; end if; return NEW; end $$ language plpgsql;");
   await pool.query('create trigger saved_route_audit_fail before insert on audit_logs for each row execute function saved_route_audit_fail();');
   try{assert.equal((await run('post',{...data,destination_location_id:next.id})).statusCode,500);assert.equal((await h.one('select count(*)::int n from routes where destination_location_id=$1',[next.id])).n,0);}
   finally{await pool.query('drop trigger saved_route_audit_fail on audit_logs');await pool.query('drop function saved_route_audit_fail();');}
  });
 }finally{await runtime.close();}
});
