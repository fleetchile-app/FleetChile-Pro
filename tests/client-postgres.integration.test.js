// Optional, isolated PostgreSQL/WASM only. Never reads DATABASE_URL.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {MIGRATION_FILES}=require('../startup');
const {registerClientRoutes}=require('../client-api');
const BASE='/api/company/clients';
const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
test('clientes PostgreSQL aislado: edición, ámbito, documentos y migración',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite(),objects=new Map();
 const query=async(sql,values=[])=>{const r=await db.query(sql,values);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const pool={query,connect:async()=>({query,release(){}})};
 try{
  await db.exec(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/002_core_platform.sql'),'utf8'));
  let legacy;
  for(const file of MIGRATION_FILES){if(file==='031_client_profiles.sql')legacy=(await query("insert into clients(company_id,name,address) select id,'Cliente previo','Dirección histórica' from companies order by id limit 1 returning id")).rows[0];await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));}
  await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/031_client_profiles.sql'),'utf8'));
  const a=(await query("insert into companies(legal_name) values('Cliente Empresa A') returning id")).rows[0].id,b=(await query("insert into companies(legal_name) values('Cliente Empresa B') returning id")).rows[0].id;
  const role=(await query("select id from roles where code='company_admin'")).rows[0].id;
  const user=(await query("insert into users(company_id,role_id,name,email) values($1,$2,'Operador real','client-operator@example.invalid') returning id",[a,role])).rows[0].id;
  const worker=(await query("insert into company_people(company_id,name,job_title) values($1,'Trabajadora','Comercial') returning id",[a])).rows[0].id;
  const foreign=(await query("insert into company_people(company_id,name) values($1,'Otro trabajador') returning id",[b])).rows[0].id;
  const driverId=(await query("insert into drivers(company_id,name) values($1,'Conductor') returning id",[a])).rows[0].id;
  const driver=(await query("insert into company_people(company_id,name,driver_id) values($1,'Conductor',$2) returning id",[a,driverId])).rows[0].id;
  const communes=(await query('select id from geo_communes order by id limit 1')).rows;
  const actor={id:user,name:'Operador real',actor_type:'company',scope:'company',company_id:a,membership_id:'1',permissions:['clients.manage']};
  const routes=[],app={};for(const method of ['get','post','patch'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
  registerClientRoutes(app,pool,{storageFactory:()=>({async put({key,body}){objects.set(key,Buffer.from(body));},async delete(key){objects.delete(key);},async get(key){assert.ok(objects.has(key));return {Body:Readable.from([objects.get(key)])};}})});
  async function run(method,path,{params={},body={},query:filters={},user=actor}={}){
   const r=routes.find(r=>r.method===method&&r.path===path);assert.ok(r,path);const req={user,body,params:{id:created?.id,...params},query:filters,ip:'127.0.0.1'};
   const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},set(k,v){this.headers[k]=v;},send(v){this.payload=v;}};
   const next=async n=>{let pending;await r.handlers[n](req,res,()=>{pending=next(n+1);return pending;});if(pending)await pending;};await next(0);return res;
  }
  let created;
  await t.test('migración conserva cliente previo sin inventar RUT; opciones no filtran conductores ni otra empresa',async()=>{
   assert.ok(legacy,'Existe la empresa demo del esquema');const row=(await query('select * from clients where id=$1',[legacy.id])).rows[0];assert.equal(row.name,'Cliente previo');assert.equal(row.rut,null);assert.equal(row.identity_type,null);assert.equal(row.address,'Dirección histórica');assert.match(row.client_code,/^CLI-LEGACY-/);
   const r=await run('get',BASE+'/options');assert.equal(r.statusCode,200);assert.equal(r.payload.consent_is_blocking,false);assert.ok(r.payload.workers.some(p=>String(p.id)===String(worker)));assert.equal(r.payload.workers.some(p=>[String(driver),String(foreign)].includes(String(p.id))),false);assert.ok(r.payload.communes.length>0);
  });
  await t.test('alta atómica genera código, normaliza RUT, deriva geografía y no exige respaldo',async()=>{
   const r=await run('post',BASE,{body:{name:'Maderas del Sur',rut:'12.345.678-5',assigned_person_id:worker,commune_id:communes[0].id,street:'Calle prueba',street_number:'123',segment:'wholesale',relationship:'recurring'}});
   assert.equal(r.statusCode,201,JSON.stringify(r.payload));created=r.payload;assert.match(created.client_code,/^CLI-\d+$/);assert.equal(created.rut,'12345678-5');assert.equal(created.address,'Calle prueba 123');assert.ok(created.commune);assert.ok(created.region);
   const d=await run('get',BASE+'/:id');assert.equal(d.payload.client.privacy_status,'pending');assert.equal(d.payload.documents.length,0);assert.equal(d.payload.events[0].actor_name,'Operador real');
  });
  await t.test('duplicados y responsables inválidos no insertan; código/RUT se aíslan por empresa',async()=>{
   for(const patch of [{rut:'12345678-5'},{rut:'11111111-1',client_code:created.client_code},{rut:'11111111-1',assigned_person_id:foreign},{rut:'11111111-1',assigned_person_id:driver}]){
    const r=await run('post',BASE,{body:{name:'Otro',...patch}});assert.equal(r.statusCode,patch.assigned_person_id?400:409,JSON.stringify(r.payload));
   }
   const other=await run('post',BASE,{user:{...actor,company_id:b},body:{name:'Otro cliente legítimo',rut:'12345678-5',client_code:created.client_code}});assert.equal(other.statusCode,201,JSON.stringify(other.payload));
   assert.equal((await run('get',BASE+'/:id',{user:{...actor,company_id:b}})).statusCode,404);
  });
  await t.test('edición con versión conserva identidad y audita antes/después; stale evita pérdida de datos',async()=>{
   const r=await run('patch',BASE+'/:id',{body:{name:'Maderas del Sur SpA',profile_version:1,reason:'Cambio de nombre',street:null,street_number:null,commune_id:null}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.id,created.id);assert.equal(r.payload.profile_version,2);assert.equal(r.payload.address,null);assert.equal(r.payload.commune,null);
   assert.equal((await run('patch',BASE+'/:id',{body:{name:'No debe ganar',profile_version:1,reason:'Edición antigua'}})).statusCode,409);
   await assert.rejects(query("update client_profile_events set actor_name='alterado' where client_id=$1",[created.id]),/inmutable/);
   const d=await run('get',BASE+'/:id');assert.equal(d.payload.events[0].before_data.name,'Maderas del Sur');assert.equal(d.payload.events[0].after_data.name,'Maderas del Sur SpA');
  });
  await t.test('lista SQL filtra, cuenta y pagina sin perder total en página vacía',async()=>{
   const all=await run('get',BASE,{query:{q:'Maderas',page:1,page_size:1,sort:'recent'}});assert.equal(all.statusCode,200,JSON.stringify(all.payload));assert.equal(all.payload.total,1);assert.equal(all.payload.rows.length,1);
   const empty=await run('get',BASE,{query:{q:'Maderas',page:2,page_size:1}});assert.equal(empty.payload.rows.length,0);assert.equal(empty.payload.total,1);
   assert.equal((await run('get',BASE,{query:{q:'%_'}})).payload.total,0);
  });
  await t.test('código autogenerado evita una coincidencia con un código manual existente',async()=>{
   const next=(await query("select 'CLI-'||lpad((last_value+1)::text,8,'0') code from client_code_seq")).rows[0].code;
   await query("insert into clients(company_id,name,client_code) values($1,'Código manual reservado',$2)",[a,next]);
   const r=await run('post',BASE,{body:{name:'Código automático sin colisión',rut:'33333333-3'}});assert.equal(r.statusCode,201,JSON.stringify(r.payload));assert.notEqual(r.payload.client_code,next);
  });
  await t.test('servicios reales incluyen cargas compartidas, excluyen otra empresa y no inventan última fecha',async()=>{
   await query("insert into trips(company_id,client_id,trip_number,origin,destination,status,actual_arrival) values($1,$2,'TEST-CLIENT-1','Concepción','Santiago','Completado','2026-10-20T12:00:00Z')",[a,created.id]);
   const shared=(await query("insert into trips(company_id,trip_number,origin,destination,status) values($1,'TEST-CLIENT-2','Concepción','Santiago','Planificado') returning id",[a])).rows[0].id;
   await query("insert into trip_loads(trip_id,client_id,cargo) values($1,$2,'Madera')",[shared,created.id]);
   await query("insert into trips(company_id,client_id,trip_number,origin,destination,status) values($1,$2,'FOREIGN-CLIENT','Otra','Otra','Completado')",[b,created.id]);
   const r=await run('get',BASE+'/:id/services');assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.total,2);assert.ok(r.payload.last_completed_service);assert.equal(r.payload.rows.some(t=>t.trip_number==='FOREIGN-CLIENT'),false);
  });
  await t.test('plantilla y firmado privados: un vigente por tipo, versiones, revocación no bloqueante',async()=>{
   const document={filename:'compromiso.pdf',content:pdf.toString('base64'),reason:'Recepción',expected_current_id:null};
   const template=await run('post',BASE+'/:id/documents',{body:{...document,kind:'template'}});assert.equal(template.statusCode,201,JSON.stringify(template.payload));
   const signed=await run('post',BASE+'/:id/documents',{body:{...document,kind:'signed',signer_name:'Representante',signer_capacity:'Apoderado',signed_on:'2020-01-01'}});assert.equal(signed.statusCode,201,JSON.stringify(signed.payload));assert.equal('storage_key' in signed.payload,false);
   assert.equal((await run('post',BASE+'/:id/documents',{body:{...document,kind:'signed',signer_name:'Representante',signed_on:'2020-01-01'}})).statusCode,409);
   const replacement=await run('post',BASE+'/:id/documents',{body:{...document,kind:'signed',expected_current_id:signed.payload.id,signer_name:'Representante',signed_on:'2020-01-01'}});assert.equal(replacement.statusCode,201,JSON.stringify(replacement.payload));
   const d=await run('get',BASE+'/:id');assert.equal(d.payload.documents.filter(d=>d.current&&d.kind==='signed').length,1);assert.equal(d.payload.documents.length,3);assert.equal(d.payload.client.privacy_status,'recorded');
   const revoke=await run('post',BASE+'/:id/privacy/revoke',{body:{reason:'Comunicación del cliente'}});assert.equal(revoke.statusCode,200);assert.equal(revoke.payload.consent_is_blocking,false);
   const after=await run('get',BASE+'/:id');assert.equal(after.payload.client.active,true);assert.equal(after.payload.client.privacy_status,'revoked');assert.equal((await run('get',BASE+'/:id/services')).payload.total,2);
   const download=await run('get',BASE+'/:id/documents/:documentId/download',{params:{documentId:signed.payload.id}});assert.equal(download.statusCode,200);assert.deepEqual(download.payload,pdf);assert.match(download.headers['Content-Disposition'],/^attachment/);
   assert.equal((await run('get',BASE+'/:id/documents/:documentId/download',{user:{...actor,company_id:b},params:{documentId:signed.payload.id}})).statusCode,404);
  });
  await t.test('fallo de auditoría revierte alta de cliente',async()=>{
   await db.exec("create function fail_client_event() returns trigger as $$ begin raise exception 'audit unavailable'; end $$ language plpgsql; create trigger fail_client_event before insert on client_profile_events for each row execute function fail_client_event();");
   const r=await run('post',BASE,{body:{name:'Rollback',rut:'22222222-2'}});assert.equal(r.statusCode,500);assert.equal((await query("select count(*)::int n from clients where company_id=$1 and name='Rollback'",[a])).rows[0].n,0);
  });
 }finally{await db.close();}
});
