// Optional isolated PostgreSQL/WASM integration. No DATABASE_URL or external DB.
// FLEETCHILE_TEST_PGLITE points to an independently installed @electric-sql/pglite.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {MIGRATION_FILES}=require('../startup');
const {loadEligibility,enforcePersonnelAccess}=require('../personnel-access');
const {userView,resolveActorContext,registerAuthRoutes}=require('../auth');
const {registerPersonnelRoutes}=require('../personnel-api');
const {reconcilePersonnelNotifications}=require('../personnel-monitor');
const {registerOperationsRoutes}=require('../operations-api');

test('PostgreSQL aislado: migración, tenants, auditoría, bloqueo y retorno reales',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE);
 const db=new PGlite();
 const query=async(sql,values=[])=>{const r=await db.query(sql,values);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const pool={query,connect:async()=>({query,release(){}})};
 try{
  await db.exec(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/002_core_platform.sql'),'utf8'));
  let previousCompany,previousUser;
  for(const file of MIGRATION_FILES){
   if(file==='030_personnel_access.sql'){
    previousCompany=(await query("insert into companies(legal_name) values('Empresa anterior al corte') returning id")).rows[0].id;
    previousUser=(await query("insert into users(company_id,role_id,name,email) select $1,id,'Usuario anterior','previous@example.invalid' from roles where code='viewer' returning id",[previousCompany])).rows[0].id;
    await query("insert into user_memberships(company_id,user_id,role_id) select $1,$2,id from roles where code='viewer'",[previousCompany,previousUser]);
   }
   await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
  }
  // Rerunning the additive migration preserves existing policies and records.
  await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/030_personnel_access.sql'),'utf8'));
  const a=(await query("insert into companies(legal_name) values('Empresa prueba A') returning id")).rows[0].id;
  const b=(await query("insert into companies(legal_name) values('Empresa prueba B') returning id")).rows[0].id;
  const role=(await query("select id from roles where code='company_admin'")).rows[0].id;
  const driverRole=(await query("select id from roles where code='driver'")).rows[0].id;
  const admin=(await query("insert into users(company_id,role_id,name,email) values($1,$2,'Admin prueba','admin@example.invalid') returning id",[a,role])).rows[0].id;
  const membership=(await query('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3) returning id',[a,admin,role])).rows[0].id;
  const actor={id:admin,name:'Admin prueba',actor_type:'company',scope:'company',company_id:a,membership_id:membership,permissions:['company.people.read','company.people.manage','company.licenses.manage','company.users.manage']};
  const routes=[];const app={};for(const method of ['get','post','patch','put'])app[method]=(route,...handlers)=>routes.push({method,route,handlers});
  registerPersonnelRoutes(app,pool,{resolveActorContext,hashPassword:async()=> 'isolated-test-hash',reauthenticateUser:async()=>true});
  async function request(method,route,{body={},params={},query:filters={},user=actor}={}){
   const match=routes.find(r=>r.method===method&&r.route===route);assert.ok(match,route);
   const req={user,body,params,query:filters,ip:'127.0.0.1',get:()=>''};
   const res={statusCode:200,status(n){this.statusCode=n;return this;},json(payload){this.payload=payload;return this;}};
   const next=async index=>{let pending;await match.handlers[index](req,res,()=>{pending=next(index+1);return pending;});if(pending)await pending;};await next(0);return res;
  }
  await t.test('registro real de rutas exige autenticación incluso con usuario inyectado',async()=>{
   const registry=[];const realApp={};for(const method of ['get','post','patch','put','delete'])realApp[method]=(route,...handlers)=>registry.push({method,route,handlers});
   registerAuthRoutes(realApp,pool);
   const route=registry.find(r=>r.method==='get'&&r.route==='/api/company/people');assert.ok(route);
   const res={status(n){this.code=n;return this;},json(value){this.payload=value;return this;}};
   await route.handlers[0]({user:actor,get:()=>''},res,()=>{throw Error('No debe saltarse autenticación');});
   assert.equal(res.code,401);
  });
  await t.test('ruta instalada autentica y permite lectura empresarial sin filtrar el snapshot privado',async()=>{
   const person=(await query("insert into company_people(company_id,user_id,membership_id,name,rut,birth_date,created_by) values($1,$2,$3,'Admin prueba','11111111-1','1990-01-01',$2) returning id",[a,admin,membership])).rows[0].id;
   await query("insert into person_contracts(company_id,person_id,type,start_date,created_by) values($1,$2,'indefinite','2020-01-01',$3)",[a,person,admin]);
   await query("insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",[admin,crypto.createHash('sha256').update('isolated-session').digest('hex')]);
   const registry=[];const realApp={};for(const method of ['get','post','patch','put','delete'])realApp[method]=(route,...handlers)=>registry.push({method,route,handlers});
   registerAuthRoutes(realApp,pool);const route=registry.find(r=>r.method==='get'&&r.route==='/api/company/people');
   const req={get:name=>name==='authorization'?'Bearer isolated-session':'',query:{page_size:25}};
   const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.payload=value;return this;}};
   const next=async index=>{let pending;await route.handlers[index](req,res,()=>{pending=next(index+1);return pending;});if(pending)await pending;};await next(0);
   assert.equal(res.statusCode,200,JSON.stringify(res.payload));assert.equal(res.payload.rows.length,1);
   assert.ok(req.user.personnel_state);assert.equal(JSON.stringify(req.user).includes('personnel_state'),false);
  });
  await t.test('solo cuentas anteriores al corte pueden regularizarse sin ficha',async()=>{
   const user=await userView(pool,previousUser);assert.equal(user.personnel_state.regularization_eligible,true);
   assert.equal((await enforcePersonnelAccess(pool,{user})).allowed,true);
   const newcomer=(await query("insert into users(company_id,role_id,name,email) select $1,id,'Alta sin contrato','newcomer@example.invalid' from roles where code='viewer' returning id",[previousCompany])).rows[0].id;
   await query("insert into user_memberships(company_id,user_id,role_id,created_at) select $1,$2,r.id,pp.regularization_before+interval '1 second' from roles r cross join company_personnel_policies pp where r.code='viewer' and pp.company_id=$1",[previousCompany,newcomer]);
   assert.equal((await loadEligibility(pool,{companyId:previousCompany,userId:newcomer})).allowed,false);
   assert.equal((await enforcePersonnelAccess(pool,{user:await userView(pool,newcomer)})).allowed,false);
  });
  await t.test('nueva empresa exige control; cuenta conductor se crea atómicamente',async()=>{
   assert.equal((await query('select enforced from company_personnel_policies where company_id=$1',[a])).rows[0].enforced,true);
   const result=await request('post','/api/company/people',{body:{name:'Conductor prueba',rut:'12345678-5',birth_date:'1990-01-01',job_title:'Conductor',create_account:true,email:'driver@example.invalid',password:'test-password-only',role_id:driverRole,contract:{type:'indefinite',start_date:'2020-01-01'},license:{classes:['A5'],printed_expiry:'2099-12-31'}}});
   assert.equal(result.statusCode,201,JSON.stringify(result.payload));
   actor.person_id=result.payload.person.id;actor.driver_user_id=result.payload.person.user_id;
   assert.equal((await loadEligibility(pool,{companyId:a,personId:actor.person_id})).allowed,true);
  });
  await t.test('SQL rechaza relaciones de otra empresa e historial mutable',async()=>{
   await assert.rejects(query('insert into person_contracts(company_id,person_id,type,start_date) values($1,$2,\'indefinite\',\'2020-01-01\')',[b,actor.person_id]),e=>e.code==='23503');
   await assert.rejects(query('update person_events set actor_name=\'Alterado\' where person_id=$1',[actor.person_id]),/inmutable/);
   const cross=await request('get','/api/company/people/:id',{params:{id:actor.person_id},user:{...actor,company_id:b}});
   assert.equal(cross.statusCode,404);
  });
  await t.test('retorno inclusivo, notificación deduplicada y bloqueo adicional',async()=>{
   await query("insert into person_conditions(company_id,person_id,type,start_date,end_date,created_by) values($1,$2,'vacation','2026-10-20','2026-10-22',$3)",[a,actor.person_id,admin]);
   const access=now=>loadEligibility(pool,{companyId:a,personId:actor.person_id,now:new Date(now)});
   assert.equal((await access('2026-10-23T02:00:00Z')).allowed,false);
   assert.equal((await access('2026-10-23T12:00:00Z')).allowed,true);
   assert.equal((await reconcilePersonnelNotifications(pool,{now:new Date('2026-10-23T12:00:00Z')})).created,1);
   assert.equal((await reconcilePersonnelNotifications(pool,{now:new Date('2026-10-23T12:00:00Z')})).created,0);
   await query('update person_driver_licenses set effective_expiry=\'2024-01-01\',printed_expiry=\'2024-01-01\' where person_id=$1',[actor.person_id]);
   assert.ok((await access('2026-10-23T12:00:00Z')).reasons.includes('DRIVER_LICENSE_EXPIRED'));
  });
  await t.test('snapshot privado y membership inactiva no recupera permisos legacy',async()=>{
   await query('update user_memberships set active=false where user_id=$1',[actor.driver_user_id]);
   const user=await userView(pool,actor.driver_user_id);
   assert.ok(user.personnel_state);assert.equal('personnel_state' in JSON.parse(JSON.stringify(user)),false);
   const result=await enforcePersonnelAccess(pool,{user});
   assert.equal(result.allowed,false);assert.ok(result.reasons.includes('MEMBERSHIP_DISABLED'));
  });
  await t.test('GPS revalida bajo bloqueo aunque la solicitud traiga un snapshot previo habilitado',async()=>{
   await query('update user_memberships set active=true where user_id=$1',[actor.driver_user_id]);
   await query('update person_conditions set cancelled_at=now(),cancelled_by=$2 where person_id=$1',[actor.person_id,admin]);
   await query("update person_driver_licenses set effective_expiry='2099-12-31',printed_expiry='2099-12-31' where person_id=$1",[actor.person_id]);
   const user=await userView(pool,actor.driver_user_id);
   assert.equal((await enforcePersonnelAccess(pool,{user})).allowed,true);
   await query("insert into person_conditions(company_id,person_id,type,start_date,end_date,created_by) values($1,$2,'suspended','2020-01-01','2099-12-31',$3)",[a,actor.person_id,admin]);
   const registry=[];const operations={};for(const method of ['get','post','patch'])operations[method]=(route,...handlers)=>registry.push({method,route,handlers});
   registerOperationsRoutes(operations,pool);
   const route=registry.find(r=>r.method==='post'&&r.route==='/api/driver/trips/:id/positions');
   const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.payload=value;return this;},sendStatus(n){this.statusCode=n;return this;}};
   await route.handlers[0]({user,params:{id:'1'},body:{lat:-36.8,lng:-73.05}},res);
   assert.equal(res.statusCode,403,JSON.stringify(res.payload));assert.equal(res.payload.code,'PERSONNEL_ACCESS_BLOCKED');
  });
  await t.test('borrador se habilita sobre la misma ficha sin duplicar el RUT',async()=>{
   const draft=await request('post','/api/company/people',{body:{name:'Ficha borrador',rut:'22222222-2',birth_date:'1990-01-01',create_account:false,contract:{type:'indefinite',start_date:'2020-01-01'}}});
   assert.equal(draft.statusCode,201,JSON.stringify(draft.payload));assert.equal(draft.payload.person.user_id,null);
   const activated=await request('post','/api/company/people/:id/account',{params:{id:draft.payload.person.id},body:{email:'draft@example.invalid',password:'test-password-only',role_id:role,reason:'Habilitación de ficha declarada'}});
   assert.equal(activated.statusCode,201,JSON.stringify(activated.payload));assert.equal(activated.payload.person.id,draft.payload.person.id);
   assert.equal(activated.payload.access.allowed,true);
   assert.equal((await query("select count(*)::int n from company_people where company_id=$1 and rut='22222222-2'",[a])).rows[0].n,1);
  });
  await t.test('fallo de auditoría revierte alta y no deja cuenta o contrato huérfano',async()=>{
   await db.exec("CREATE FUNCTION fail_person_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit rejected'; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_person_audit BEFORE INSERT ON person_events FOR EACH ROW EXECUTE FUNCTION fail_person_audit();");
   const result=await request('post','/api/company/people',{body:{name:'Rollback prueba',rut:'33333333-3',birth_date:'1990-01-01',create_account:true,email:'rollback@example.invalid',password:'test-password-only',role_id:role,contract:{type:'indefinite',start_date:'2020-01-01'}}});
   assert.equal(result.statusCode,500);
   assert.equal((await query("select count(*)::int n from users where email='rollback@example.invalid'")).rows[0].n,0);
   await db.exec('DROP TRIGGER fail_person_audit ON person_events; DROP FUNCTION fail_person_audit();');
  });
 }finally{await db.close();}
});
