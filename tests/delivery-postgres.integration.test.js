'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {MIGRATION_FILES}=require('../startup'),{registerPortabilityRoutes}=require('../portability-api'),{createExportWorker,exportKey}=require('../portability-worker'),{createOperations,registerOperationsStatus}=require('../service-operations');
function unpack(buffer){const tar=zlib.gunzipSync(buffer),files=new Map();let offset=0;while(tar[offset]){const name=tar.subarray(offset,offset+100).toString().replace(/\0.*$/s,''),size=parseInt(tar.subarray(offset+124,offset+136).toString().replace(/\0.*$/s,''),8);offset+=512;files.set(name,tar.subarray(offset,offset+size));offset+=Math.ceil(size/512)*512;}return files;}
test('PL42/44 SQL aislado: portabilidad, integridad, permisos y conservación técnica',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0}},pool={query,connect:async()=>({query,release(){}})},one=async(sql,args)=>(await query(sql,args)).rows[0],source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8'),root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'fleetchile-delivery-test-'));
 const objects=new Map(),deletions=[],store={async put({key,body}){const chunks=[];for await(const c of body)chunks.push(c);objects.set(key,Buffer.concat(chunks));},async get(key){if(!objects.has(key))throw Error('private fixture missing');return {Body:objects.get(key)};},async delete(key){deletions.push(key);objects.delete(key);}},env={S3_BUCKET:'test',S3_REGION:'test',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'test'},logs=[],ops=createOperations(pool,{env,logger:{error:v=>logs.push(v),warn:v=>logs.push(v)}});
 try{
  await db.exec(source('schema.sql'));await db.exec(source('migrations/002_core_platform.sql'));for(const f of MIGRATION_FILES)await db.exec(source('migrations/'+f));await db.exec(source('migrations/041_delivery_operations.sql'));
  const a=await one("insert into companies(legal_name) values('Export A') returning id"),b=await one("insert into companies(legal_name) values('FOREIGN_SECRET_COMPANY') returning id"),role=await one("select id from roles where code='company_admin'");
  const u=await one("insert into users(company_id,role_id,name,email,password_hash) values($1,$2,'Admin','admin@delivery.invalid','DO_NOT_EXPORT_PASSWORD') returning id",[a.id,role.id]);
  await query('insert into user_memberships(user_id,company_id,role_id) values($1,$2,$3)',[u.id,a.id,role.id]);
  await query("insert into clients(company_id,name) values($1,'=HYPERLINK(unsafe)')",[a.id]);await query("insert into clients(company_id,name) values($1,'FOREIGN_CLIENT_MARKER')",[b.id]);
  const who={id:u.id,name:'Admin',actor_type:'company',scope:'company',company_id:a.id,membership_id:1,role_code:'company_admin',permissions:['company.users.manage','company.people.read','economics.export']},platform={...who,actor_type:'platform',scope:'platform',company_id:null,platform_membership_id:1,permissions:['platform.users.manage','platform.companies.manage']};
  const routes=[],app={};for(const method of ['get','post'])app[method]=(url,...handlers)=>routes.push({method,url,handlers});registerPortabilityRoutes(app,pool,{env,storageFactory:()=>store,operations:ops,reauthenticate:async(p,id,password)=>password==='test-correct'});registerOperationsStatus(app,pool,ops);
  async function run(method,url,{user=who,body={},params={}}={}){const req={user,body,params,ip:'127.0.0.1'},res={statusCode:200,status(n){this.statusCode=n;return this},json(v){this.payload=v;return this}};const route=routes.find(r=>r.method===method&&r.url===url);assert.ok(route,url);async function next(i){if(i===route.handlers.length)return;let pending;await route.handlers[i](req,res,()=>pending=next(i+1));if(pending)await pending;}await next(0);return res;}
  const request=()=>({reason:'Portabilidad solicitada por empresa',password:'test-correct',confirmed:true,request_key:crypto.randomUUID()});let job;
  await t.test('requiere administrador completo, contraseña y ámbito; es idempotente',async()=>{
   let r=await run('get','/api/company/exports',{user:{...who,role_code:'operations'}});assert.equal(r.statusCode,403);
   r=await run('get','/api/company/exports',{user:{...who,permissions:[]}});assert.equal(r.statusCode,403);
   r=await run('post','/api/company/exports',{body:{...request(),company_id:b.id}});assert.equal(r.statusCode,400);
   r=await run('post','/api/company/exports',{body:{...request(),password:'wrong'}});assert.equal(r.statusCode,403);
   const body=request();r=await run('post','/api/company/exports',{body});assert.equal(r.statusCode,202,JSON.stringify(r.payload));job=r.payload;
   r=await run('post','/api/company/exports',{body});assert.equal(r.payload.id,job.id);
   r=await run('post','/api/company/exports',{body:request()});assert.equal(r.statusCode,409);
   r=await run('get','/api/company/exports',{user:{...who,company_id:b.id}});assert.deepEqual(r.payload.jobs,[]);
  });
  const worker=createExportWorker(pool,{storageFactory:()=>store,operations:ops,env,tempRoot:root});
  await t.test('genera archivo legible con datos propios, hashes y CSV seguro sin credenciales',async()=>{
   await worker.run();const j=await one('select * from company_export_jobs where id=$1',[job.id]);assert.equal(j.status,'ready',j.error_code);
   const bytes=objects.get(exportKey(j)),files=unpack(bytes),manifest=JSON.parse(files.get('manifest.json'));
   assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),j.sha256);assert.equal(manifest.company_id,a.id);
   for(const f of manifest.datasets)assert.equal(crypto.createHash('sha256').update(files.get(f.file)).digest('hex'),f.sha256);
   const all=[...files.values()].map(b=>b.toString()).join('\n');assert.doesNotMatch(all,/FOREIGN_CLIENT_MARKER|FOREIGN_SECRET_COMPANY|DO_NOT_EXPORT_PASSWORD|password_hash/);
   assert.match(files.get('csv/clients.csv').toString(),/'=HYPERLINK/);assert.equal((await fs.promises.readdir(root)).length,0);
   let r=await run('post','/api/company/exports/:id/download',{params:{id:j.id},body:{password:'wrong'}});assert.equal(r.statusCode,403);
   r=await run('post','/api/company/exports/:id/download',{user:{...who,company_id:b.id},params:{id:j.id},body:{password:'test-correct'}});assert.equal(r.statusCode,404);
  });
  let consent;
  await t.test('adjunto ausente hace fallar todo el paquete sin publicar una copia parcial',async()=>{
   const client=await one('select id from clients where company_id=$1',[a.id]);consent=await one("insert into client_consent_documents(company_id,client_id,kind,storage_key,filename,mime_type,size,sha256,uploaded_by,uploaded_by_name,reason) values($1,$2,'template',$3,'test.pdf','application/pdf',4,$4,$5,'Admin','Prueba de adjunto') returning id",[a.id,client.id,`companies/${a.id}/consents/test`,crypto.createHash('sha256').update('test').digest('hex'),u.id]);
   const r=await run('post','/api/company/exports',{body:request()});await worker.run();const j=await one('select * from company_export_jobs where id=$1',[r.payload.id]);assert.equal(j.status,'failed');assert.equal(j.error_code,'EXPORT_ATTACHMENT_UNAVAILABLE');assert.equal(objects.has(exportKey(j)),false);assert.equal((await fs.promises.readdir(root)).length,0);
  });
  await t.test('hash incorrecto bloquea; adjunto íntegro se incorpora y verifica',async()=>{
   const key=`companies/${a.id}/consents/test`;objects.set(key,Buffer.from('xxxx'));let r=await run('post','/api/company/exports',{body:request()});await worker.run();assert.equal((await one('select error_code from company_export_jobs where id=$1',[r.payload.id])).error_code,'EXPORT_ATTACHMENT_INTEGRITY');
   objects.set(key,Buffer.from('test'));r=await run('post','/api/company/exports',{body:request()});await worker.run();const j=await one('select * from company_export_jobs where id=$1',[r.payload.id]);assert.equal(j.status,'ready',j.error_code);const files=unpack(objects.get(exportKey(j)));assert.equal(files.get(`files/consents/${consent.id}.pdf`).toString(),'test');
  });
  await t.test('fallo de auditoría revierte publicación y compensa el objeto privado',async()=>{
   await db.exec("CREATE FUNCTION fail_delivery_audit() RETURNS trigger AS $$ BEGIN IF NEW.action='export_ready' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_delivery_audit();");
   const r=await run('post','/api/company/exports',{body:request()});await worker.run();const j=await one('select * from company_export_jobs where id=$1',[r.payload.id]);assert.equal(j.status,'failed');assert.equal(objects.has(exportKey(j)),false);assert.equal(j.storage_key,null);await db.exec('DROP TRIGGER fail_delivery_audit ON audit_logs');
  });
  await t.test('vencimiento e interrupción limpian solo copias generadas; preservan evidencia',async()=>{
   const r=await run('post','/api/company/exports',{body:request()});await query("update company_export_jobs set status='running' where id=$1",[r.payload.id]);
   const tmp=await fs.promises.mkdtemp(path.join(root,'fleetchile-export-'));await fs.promises.writeFile(path.join(tmp,'export-job.json'),JSON.stringify({job_id:r.payload.id,company_id:a.id}));
   await query("update company_export_jobs set expires_at=now()-interval '1 day' where status='ready'");await worker.run();assert.equal((await one('select error_code from company_export_jobs where id=$1',[r.payload.id])).error_code,'EXPORT_INTERRUPTED');assert.equal((await fs.promises.readdir(root)).length,0);assert.ok(objects.has(`companies/${a.id}/consents/test`));assert.ok(deletions.every(k=>k.includes('/exports/')));
  });
  await t.test('monitoreo agrega repeticiones, diferencia revisar de resolver y limita purga',async()=>{
   await ops.record('http','HTTP_5XX');await ops.record('http','HTTP_5XX');const incident=await one("select * from service_incidents where source='http'");assert.equal(Number(incident.occurrences),2);
   let r=await run('get','/api/admin/service-status');assert.equal(r.statusCode,403);
   r=await run('post','/api/admin/service-incidents/:id/acknowledge',{user:platform,params:{id:incident.id},body:{reason:'Investigación del incidente'}});assert.equal(r.statusCode,200);assert.equal((await one('select resolved_at from service_incidents where id=$1',[incident.id])).resolved_at,null);
   await ops.recover('http','HTTP_5XX');await query("update service_incidents set last_at=now()-interval '100 days' where source='http'");await ops.record('database','KEEP_ACTIVE');await query("update service_incidents set last_at=now()-interval '100 days' where code='KEEP_ACTIVE'");await ops.check();assert.equal((await one("select count(*)::int n from service_incidents where source='http'")).n,0);assert.equal((await one("select count(*)::int n from service_incidents where code='KEEP_ACTIVE'")).n,1);assert.equal((await one('select count(*)::int n from client_consent_documents')).n,1);
   r=await run('get','/api/admin/service-status',{user:platform});assert.equal(r.statusCode,200);assert.doesNotMatch(JSON.stringify(r.payload),/test-correct|DO_NOT_EXPORT_PASSWORD|S3_SECRET_ACCESS_KEY/);
  });
 }finally{await db.close();const real=await fs.promises.realpath(root);assert.equal(path.dirname(real),await fs.promises.realpath(os.tmpdir()));assert.ok(path.basename(real).startsWith('fleetchile-delivery-test-'));await fs.promises.rm(real,{recursive:true,force:true});}
});
module.exports={unpack};
