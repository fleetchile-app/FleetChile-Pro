'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup');
const {registerCompanyBrandingRoutes}=require('../company-branding-api');
const {registerDriverProfileRoutes}=require('../driver-profile-api');
test('identidad y documentos: aislamiento, permisos, concurrencia, auditoría e inmutabilidad PostgreSQL', {skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite();
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},pool={query,connect:async()=>({query,release(){}})};
 const one=async(sql,args)=>(await query(sql,args)).rows[0],source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 try{
  await db.exec(source('schema.sql'));await db.exec(source('migrations/002_core_platform.sql'));for(const file of MIGRATION_FILES)await db.exec(source('migrations/'+file));
  await db.exec(source('migrations/039_company_branding.sql'));
  const a=await one("insert into companies(legal_name,rut) values('Empresa A','RUT A') returning id"),b=await one("insert into companies(legal_name) values('Empresa B') returning id");
  const role=await one("select id from roles where code='company_admin'");
  const user=await one("insert into users(company_id,role_id,name,email) values($1,$2,'Administración','branding@example.invalid') returning id",[a.id,role.id]);
  const driver=await one("insert into drivers(company_id,name) values($1,'María Muñoz') returning id",[a.id]);
  const actor={id:user.id,actor_type:'company',scope:'company',company_id:a.id,permissions:['company.users.manage','drivers.manage']};
  const routes=[],app={};for(const method of ['get','put','post','patch','delete'])app[method]=(url,...handlers)=>routes.push({method,url,handlers});
  registerCompanyBrandingRoutes(app,pool);registerDriverProfileRoutes(app,pool);
  async function run(method,url,{who=actor,body={},params={},query:q={}}={}){const req={user:who,body,params,query:q,ip:'127.0.0.1'},res={statusCode:200,headers:{},status(n){this.statusCode=n;return this},json(v){this.payload=v;return this},send(v){this.payload=v;return this},sendStatus(n){this.statusCode=n;return this},set(k,v){this.headers[k]=v;return this}};const route=routes.find(r=>r.method===method&&r.url===url);assert.ok(route,url);async function next(i){if(i>=route.handlers.length)return;let promise;await route.handlers[i](req,res,()=>promise=next(i+1));if(promise)await promise;}await next(0);return res;}
  const body={expected_version:0,display_name:'Transporte A',palette:'forest',contact_name:'Operaciones',contact_email:'a@example.invalid',contact_phone:'123',reason:'Alta identidad corporativa'};
  const fixtureLogo=await require('sharp')({create:{width:240,height:80,channels:3,background:'#23634c'}}).png().toBuffer();body.logo='data:image/png;base64,'+fixtureLogo.toString('base64');
  await t.test('solo contexto autorizado; consulta no sigue body/query y edición requiere permiso',async()=>{
   let r=await run('get','/api/company/branding',{query:{company_id:b.id}});assert.equal(r.payload.company_id,a.id);assert.equal(r.payload.legal_name,'Empresa A');
   r=await run('put','/api/company/branding',{who:{...actor,permissions:[]},body});assert.equal(r.statusCode,403);
   r=await run('get','/api/company/branding',{who:{...actor,scope:'platform',company_id:null}});assert.equal(r.statusCode,403);
   r=await run('put','/api/company/branding',{body:{...body,company_id:b.id}});assert.equal(r.statusCode,400);
   r=await run('put','/api/company/branding',{body});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.version,1);
   r=await run('put','/api/company/branding',{body});assert.equal(r.statusCode,409);
   assert.equal((await one('select legal_name from companies where id=$1',[a.id])).legal_name,'Empresa A');
   assert.equal((await one('select count(*)::int n from company_branding_revisions where company_id=$1',[b.id])).n,0);
  });
  await t.test('un fallo de auditoría revierte también la identidad',async()=>{
   await db.exec("CREATE FUNCTION branding_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.entity='company_branding' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER branding_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION branding_audit_fail();");
   const r=await run('put','/api/company/branding',{body:{...body,expected_version:1,display_name:'No guardar'}});assert.equal(r.statusCode,500);
   await db.exec('DROP TRIGGER branding_audit_fail ON audit_logs');assert.equal((await run('get','/api/company/branding')).payload.version,1);
  });
  await t.test('plataforma necesita empresa contextualizada y permiso explícito de gestión empresarial',async()=>{
   const platform={id:user.id,actor_type:'platform',scope:'platform',platform_membership_id:99,active_company_context:a.id,permissions:['platform.companies.manage']};
   let r=await run('get','/api/company/branding',{who:platform});assert.equal(r.statusCode,200);assert.equal(r.payload.company_id,a.id);
   r=await run('put','/api/company/branding',{who:{...platform,permissions:['platform.users.manage']},body:{...body,expected_version:1}});assert.equal(r.statusCode,403);
   r=await run('get','/api/company/branding/history',{who:platform});assert.equal(r.statusCode,200);assert.equal(r.payload.rows[0].version,1);
  });
  let original,docId;
  await t.test('emisión A4 archiva identidad del propietario y permite recuperar PDF original',async()=>{
   let r=await run('get','/api/fleet/drivers/:id/pdf',{params:{id:driver.id}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));original=r.payload;docId=r.headers['X-Document-Id'];
   assert.match(original.toString('latin1'),/Transporte A/);assert.match(original.toString('latin1'),/María Muñoz/);assert.match(original.toString('latin1'),/595.28 841.89/);assert.match(original.toString('latin1'),/\/DCTDecode/);assert.match(original.toString('latin1'),/\/Logo Do/);
   r=await run('put','/api/company/branding',{body:{...body,expected_version:1,display_name:'Identidad posterior',logo:null}});assert.equal(r.statusCode,200);assert.equal(r.payload.logo_url,null);
   r=await run('get','/api/fleet/drivers/:id/documents/:documentId',{params:{id:driver.id,documentId:docId}});assert.equal(r.statusCode,200);assert.deepEqual(r.payload,original);
   r=await run('get','/api/fleet/drivers/:id/documents/:documentId',{who:{...actor,company_id:b.id},params:{id:driver.id,documentId:docId}});assert.equal(r.statusCode,404);
   r=await run('get','/api/fleet/drivers/:id/pdf',{who:{...actor,company_id:b.id},params:{id:driver.id}});assert.equal(r.statusCode,404);
   r=await run('get','/api/fleet/drivers/:id/documents',{params:{id:driver.id}});assert.equal(r.payload.rows.length,1);
   await assert.rejects(()=>query('delete from company_issued_documents where id=$1',[docId]),/inmutable/);
   await assert.rejects(()=>query("update company_branding_revisions set display_name='x' where company_id=$1",[a.id]),/inmutable/);
  });
  await t.test('restablecer crea revisión nueva sin borrar documentos ni datos legales',async()=>{
   const r=await run('put','/api/company/branding',{body:{expected_version:2,reason:'Restablecer identidad',reset:true}});assert.equal(r.statusCode,200);assert.equal(r.payload.version,3);assert.equal(r.payload.display_name,'Empresa A');assert.equal(r.payload.palette,'ocean');assert.equal(r.payload.logo_url,null);
   const history=await run('get','/api/company/branding/history');assert.equal(history.payload.rows.length,3);assert.equal((await one('select count(*)::int n from company_issued_documents')).n,1);
  });
  await t.test('si falla la auditoría de emisión no queda un documento parcial',async()=>{
   await db.exec("CREATE FUNCTION branding_document_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.entity='driver_profile_pdf' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER branding_document_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION branding_document_audit_fail();");
   const r=await run('get','/api/fleet/drivers/:id/pdf',{params:{id:driver.id}});assert.equal(r.statusCode,500);assert.equal((await one('select count(*)::int n from company_issued_documents')).n,1);
   await db.exec('DROP TRIGGER branding_document_audit_fail ON audit_logs');
  });
 }finally{await db.close()}
});
