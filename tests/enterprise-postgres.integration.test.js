'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup'),{registerEnterpriseRoutes}=require('../enterprise-api'),{registerImportRoutes}=require('../import-api'),{userView,authMiddleware}=require('../auth'),S=require('../support-access');
test('PL37/39/40 SQL aislado: perfiles, soporte, importación y auditoría',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0}},pool={query,connect:async()=>({query,release(){}})},one=async(sql,args)=>(await query(sql,args)).rows[0],source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 try{
  await db.exec(source('schema.sql'));await db.exec(source('migrations/002_core_platform.sql'));for(const f of MIGRATION_FILES)await db.exec(source('migrations/'+f));await db.exec(source('migrations/040_enterprise_administration.sql'));
  const a=await one("insert into companies(legal_name) values('Empresa A') returning id"),b=await one("insert into companies(legal_name) values('Empresa B') returning id");
  const adminRole=await one("select id from roles where code='company_admin'"),opsRole=await one("select id from roles where code='operations'"),supRole=await one("select id from roles where code='platform_support'");
  const user=async(name,role,cid=null)=>one('insert into users(company_id,role_id,name,email,active) values($1,$2,$3,$4,true) returning id',[cid,role,name,name+'@enterprise.invalid']);
  const adminUser=await user('admin-a',adminRole.id,a.id),operator=await user('ops-a',opsRole.id,a.id),supportUser=await user('support',supRole.id);
  await query('insert into user_memberships(user_id,company_id,role_id) values($1,$2,$3)',[adminUser.id,a.id,adminRole.id]);
  const member=await one('insert into user_memberships(user_id,company_id,role_id) values($1,$2,$3) returning id',[operator.id,a.id,opsRole.id]);
  await query('insert into platform_memberships(user_id,role_id) values($1,$2)',[supportUser.id,supRole.id]);
  const admin={id:adminUser.id,name:'Admin A',actor_type:'company',scope:'company',company_id:a.id,permissions:['company.users.manage','clients.manage','fleet.manage','company.people.manage']},platform={id:adminUser.id,name:'Platform fixture',actor_type:'platform',scope:'platform',platform_membership_id:99,permissions:['platform.users.manage','platform.companies.manage']},support={id:supportUser.id,name:'Support fixture',actor_type:'platform',scope:'platform',platform_membership_id:1,role_code:'platform_support',permissions:['platform.context.switch'],active_company_context:a.id};
  const routes=[],app={};for(const method of ['get','post','put','patch','delete'])app[method]=(url,...handlers)=>routes.push({method,url,handlers});registerEnterpriseRoutes(app,pool);registerImportRoutes(app,pool);
  async function run(method,url,{who=admin,body={},params={},query:q={}}={}){
   const req={method:method.toUpperCase(),originalUrl:url,user:{...who},body,params,query:q,ip:'127.0.0.1'},res={statusCode:200,headers:{},status(n){this.statusCode=n;return this},json(v){this.payload=v;return this},set(k,v){this.headers[k]=v;return this},send(v){this.payload=v;return this}};
   const r=routes.find(r=>r.method===method&&r.url===url);assert.ok(r,url);
   if(S.restricted(req.user))try{await S.authorizeSupport(pool,req)}catch(e){res.status(e.status||503).json({error:e.message});return res;}
   async function next(i){if(i>=r.handlers.length)return;let pending;await r.handlers[i](req,res,()=>pending=next(i+1));if(pending)await pending;}await next(0);return res;
  }
  let profile;
  await t.test('perfil limitado no cruza empresas ni otorga permisos globales; auth conserva rol base',async()=>{
   const body={name:'Coordinador de viajes',base_role_id:opsRole.id,permissions:['dashboard.read','trips.manage'],active:true,expected_version:0,reason:'Separar tareas operacionales'};
   let r=await run('post','/api/company/access/profiles',{body:{...body,permissions:['platform.users.manage']}});assert.equal(r.statusCode,400);
   r=await run('post','/api/company/access/profiles',{body});assert.equal(r.statusCode,200,JSON.stringify(r.payload));profile=r.payload;
   let list=await run('get','/api/company/access/memberships');const m=list.payload.rows.find(m=>m.id===member.id);
   r=await run('put','/api/company/access/memberships/:id',{params:{id:member.id},body:{profile_id:profile.id,expected_stamp:m.stamp,reason:'Asignación de coordinador'}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   let u=await userView(pool,operator.id);assert.equal(u.role_code,'operations');assert.deepEqual(u.permissions,['dashboard.read','trips.manage']);assert.equal(u.memberships[0].role_name,'Coordinador de viajes');
   r=await run('post','/api/company/access/profiles',{body:{...body,id:profile.id,expected_version:1,permissions:['dashboard.read']}});assert.equal(r.statusCode,200);u=await userView(pool,operator.id);assert.deepEqual(u.permissions,['dashboard.read']);
   r=await run('post','/api/company/access/profiles',{body:{...body,id:profile.id,expected_version:1}});assert.equal(r.statusCode,409);
   r=await run('post','/api/company/access/profiles',{who:{...admin,company_id:b.id},body:{...body,id:profile.id,expected_version:2}});assert.equal(r.statusCode,404);
   await assert.rejects(()=>query("update company_access_profiles set permissions='[\"platform.users.manage\"]' where id=$1",[profile.id]),/no amplía/);
   await db.exec("CREATE FUNCTION fail_access_profile_audit() RETURNS trigger AS $$ BEGIN IF NEW.kind='access_profile' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_access_profile_audit BEFORE INSERT ON enterprise_events FOR EACH ROW EXECUTE FUNCTION fail_access_profile_audit();");
   r=await run('post','/api/company/access/profiles',{body:{...body,id:profile.id,expected_version:2,name:'No guardar'}});assert.equal(r.statusCode,500);assert.equal((await one('select version from company_access_profiles where id=$1',[profile.id])).version,2);
   await db.exec('DROP TRIGGER fail_access_profile_audit ON enterprise_events');
  });
  await t.test('soporte exige autorización y caso; restringe funciones y revocación efectiva',async()=>{
   let r=await run('get','/api/company/access',{who:support});assert.equal(r.statusCode,403);
   r=await run('post','/api/support/grants',{who:platform,body:{company_id:a.id,user_id:supportUser.id,scopes:['profiles'],expires_at:new Date(Date.now()+86400000).toISOString(),reason:'Solicitud del cliente autorizada'}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));const grant=r.payload;
   r=await run('post','/api/support/cases',{who:support,body:{company_id:b.id,reason:'Caso fuera de empresa'}});assert.equal(r.statusCode,403);
   r=await run('post','/api/support/cases',{who:support,body:{company_id:a.id,reason:'Revisar perfiles de empresa'}});assert.equal(r.statusCode,200);
   r=await run('get','/api/company/access',{who:support});assert.equal(r.statusCode,200);
   r=await run('post','/api/company/imports/preview',{who:support,body:{kind:'people',csv:'name;rut\nAna;12345678-5'}});assert.equal(r.statusCode,403);
   await assert.rejects(()=>S.authorizeSupport(pool,{user:support,method:'POST',originalUrl:'/api/admin/owners',body:{}}),e=>e.status===403);
   r=await run('post','/api/support/grants/:id/revoke',{who:platform,params:{id:grant.id},body:{reason:'Finalizar autorización de soporte'}});assert.equal(r.statusCode,200);
   r=await run('get','/api/company/access',{who:support});assert.equal(r.statusCode,403);
   assert.ok((await one("select count(*)::int n from audit_logs where user_id=$1 and action='support_attempt'",[supportUser.id])).n>0);
  });
  await t.test('desactivar perfil no restaura el rol base, cambiarlo limpia el perfil con integridad',async()=>{
   let r=await run('post','/api/company/access/profiles',{body:{id:profile.id,name:'Coordinador de viajes',base_role_id:opsRole.id,permissions:['dashboard.read'],active:false,expected_version:2,reason:'Suspender temporalmente el perfil'}});assert.equal(r.statusCode,200);
   assert.deepEqual((await userView(pool,operator.id)).permissions,[]);
   const viewer=await one("select id from roles where code='viewer'");
   await query('update user_memberships set role_id=$1 where id=$2',[viewer.id,member.id]);assert.equal((await one('select access_profile_id from user_memberships where id=$1',[member.id])).access_profile_id,null);
   assert.ok((await userView(pool,operator.id)).permissions.includes('reports.read'));
   await assert.rejects(()=>query('update user_memberships set access_profile_id=$1 where id=$2',[profile.id,member.id]),/Perfil no disponible/);
  });
  await t.test('middleware de sesión real aplica los límites de soporte y su vencimiento',async()=>{
   const g=await run('post','/api/support/grants',{who:platform,body:{company_id:a.id,user_id:supportUser.id,scopes:['branding'],expires_at:new Date(Date.now()+86400000).toISOString(),reason:'Caso de identidad empresarial'}});assert.equal(g.statusCode,200);
   const c=await run('post','/api/support/cases',{who:support,body:{company_id:a.id,reason:'Atender identidad autorizada'}});assert.equal(c.statusCode,200);
   const raw='isolated-support-session',hash=require('node:crypto').createHash('sha256').update(raw).digest('hex');await query("insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",[supportUser.id,hash]);
   async function check(path){const req={originalUrl:path,method:'GET',ip:'127.0.0.1',get:name=>name==='authorization'?'Bearer '+raw:name==='x-company-context'?String(a.id):''},res={statusCode:200,status(s){this.statusCode=s;return this},json(v){this.payload=v;return this}};let next=false;await authMiddleware(pool,req,res,()=>{next=true});return {req,res,next}}
   let r=await check('/api/company/branding');assert.equal(r.next,true);assert.deepEqual(r.req.user.permissions,['platform.context.switch']);assert.deepEqual(r.req.supportAccess.scopes,['branding']);
   r=await check('/api/company/people');assert.equal(r.res.statusCode,403);assert.equal(r.next,false);
   r=await check('/api/companies');assert.equal(r.res.statusCode,403);
   await query("update company_support_cases set expires_at=now()-interval '1 second' where id=$1",[c.payload.id]);
   r=await check('/api/company/branding');assert.equal(r.res.statusCode,403);assert.equal(r.next,false);
  });
  await t.test('importación valida filas, referencias y duplicados sin crear cuentas o licencias',async()=>{
   let r=await run('post','/api/company/imports/preview',{body:{kind:'clients',csv:'name;rut\nCliente inválido;1-2'}});assert.equal(r.statusCode,200);assert.equal(r.payload.can_commit,false);
   r=await run('post','/api/company/imports/preview',{body:{kind:'people',csv:'name;rut;job_title\nAna Pérez;12345678-5;Bodega'}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.can_commit,true);const batch=r.payload.id;
   let commit=await run('post','/api/company/imports/:id/commit',{params:{id:batch},body:{reason:'Alta de datos iniciales',confirmed:true}});assert.equal(commit.statusCode,200,JSON.stringify(commit.payload));assert.equal(commit.payload.count,1);
   const person=await one('select * from company_people where id=$1',[commit.payload.record_ids[0]]);assert.equal(person.user_id,null);assert.equal(person.membership_id,null);assert.equal(person.driver_id,null);
   commit=await run('post','/api/company/imports/:id/commit',{params:{id:batch},body:{reason:'Reintento por conexión',confirmed:true}});assert.equal(commit.payload.replayed,true);
   r=await run('post','/api/company/imports/preview',{body:{kind:'people',csv:'name;rut\nAna;12345678-5'}});assert.equal(r.payload.can_commit,false);
   r=await run('post','/api/company/imports/preview',{body:{kind:'vehicles',csv:'patente;brand;model;tipo\nTEST040;Marca;Modelo;Camión'}});assert.equal(r.payload.can_commit,true,JSON.stringify(r.payload));
   commit=await run('post','/api/company/imports/:id/commit',{params:{id:r.payload.id},body:{reason:'Alta inicial de inventario',confirmed:true}});assert.equal(commit.statusCode,200,JSON.stringify(commit.payload));
   const truck=await one('select * from trucks where id=$1',[commit.payload.record_ids[0]]);assert.equal(truck.capacidad_t,null);assert.equal((await one('select count(*)::int n from commercial_equipment_seats where truck_id=$1',[truck.id])).n,0);
  });
  await t.test('confirmación revalida y no admite lotes ajenos ni escrituras parciales',async()=>{
   let r=await run('post','/api/company/imports/preview',{body:{kind:'clients',csv:'name;rut;assigned_person_rut\nCliente ejemplo;11111111-1;12345678-5'}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.can_commit,true,JSON.stringify(r.payload));const batch=r.payload.id;
   r=await run('post','/api/company/imports/:id/commit',{who:{...admin,company_id:b.id},params:{id:batch},body:{reason:'Intento desde otra empresa',confirmed:true}});assert.equal(r.statusCode,404);
   await db.exec("CREATE FUNCTION fail_enterprise_import() RETURNS trigger AS $$ BEGIN IF NEW.kind='import_commit' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_enterprise_import BEFORE INSERT ON enterprise_events FOR EACH ROW EXECUTE FUNCTION fail_enterprise_import();");
   r=await run('post','/api/company/imports/:id/commit',{params:{id:batch},body:{reason:'Prueba de integridad transaccional',confirmed:true}});assert.equal(r.statusCode,500);assert.equal((await one('select count(*)::int n from clients where company_id=$1',[a.id])).n,0);assert.equal((await one('select committed_at from company_import_batches where id=$1',[batch])).committed_at,null);
   await db.exec('DROP TRIGGER fail_enterprise_import ON enterprise_events');
   r=await run('post','/api/company/imports/:id/commit',{params:{id:batch},body:{reason:'Importación cliente confirmada',confirmed:true}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
  });
  await t.test('un duplicado introducido después de previsualizar bloquea todo el lote',async()=>{
   const csv='nombre;rut\nPersona nueva;22222222-2\nPersona de prueba;33333333-3';
   let r=await run('post','/api/company/imports/preview',{body:{kind:'people',csv}});assert.equal(r.payload.can_commit,true,JSON.stringify(r.payload));const batch=r.payload.id;
   await query("insert into company_people(company_id,name,rut,created_by,updated_by) values($1,'Persona concurrente','33333333-3',$2,$2)",[a.id,adminUser.id]);
   r=await run('post','/api/company/imports/:id/commit',{params:{id:batch},body:{reason:'Confirmar lote tras cambio',confirmed:true}});assert.equal(r.statusCode,409);assert.equal((await one("select count(*)::int n from company_people where company_id=$1 and rut='22222222-2'",[a.id])).n,0);
  });
 }finally{await db.close()}
});
