'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {embedded,harness}=require('./helpers/acceptance');
function rut(n){const body=String(n);let sum=0,m=2;for(const d of [...body].reverse()){sum+=Number(d)*m;m=m===7?2:m+1;}const dv=11-sum%11;return body+'-'+(dv===11?'0':dv===10?'K':dv);}

test('cierre ampliado: sesiones reales, perfiles propios, más de 100 fichas y retornos',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Escala sintética A'),b=await h.company('Escala sintética B');
  const call=(token,method,url,body={},params={},query={})=>h.run(token,method,url,{body,params,query});
  const admin=(method,url,body={},params={},query={})=>call(a.admin.token,method,url,body,params,query);
  const before=JSON.stringify((await pool.query('select * from role_permissions order by role_id,permission_id')).rows);
  let operator,profile,driver;
  await t.test('matriz de roles empresariales reales coincide con los permisos persistidos y no amplía la plataforma',async()=>{
   const rows=(await pool.query("select id,code from roles where code in ('company_admin','manager','operations','administrative','maintenance','viewer') order by id")).rows;
   assert.equal(rows.length,6);
   for(const [i,role] of rows.entries()){
    const user=await h.account(a.id,role.code,'Rol sintético '+role.code,rut(14000000+i));if(role.code==='operations')operator=user;
    const permissions=(await pool.query('select p.code from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=$1',[role.id])).rows.map(p=>p.code);
    for(const [url,permission] of [['/api/company/clients','clients.manage'],['/api/trips','trips.manage'],['/api/fleet/fuel','fuel.manage'],['/api/fleet/drivers','drivers.manage']]){
     const r=await call(user.token,'get',url);assert.equal(r.statusCode,permissions.includes(permission)?200:403,role.code+' '+url+': '+JSON.stringify(r.payload));
    }
    assert.equal((await call(user.token,'get','/api/platform/commercial/plans')).statusCode,403,role.code+' no debe administrar plataforma');
   }
  });
  await t.test('perfil propio asignado reduce acceso en la siguiente petición de la misma sesión',async()=>{
   const role=await h.one("select id from roles where code='operations'");
   let r=await admin('post','/api/company/access/profiles',{name:'Sólo viajes sintéticos',base_role_id:Number(role.id),permissions:['trips.manage'],active:true,expected_version:0,reason:'Separación sintética de funciones'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));profile=r.payload;
   const members=await admin('get','/api/company/access/memberships'),member=members.payload.rows.find(m=>String(m.user_id)===String(operator.id));assert.ok(member);
   r=await admin('put','/api/company/access/memberships/:id',{profile_id:Number(profile.id),expected_stamp:member.stamp,reason:'Aplicar perfil limitado'},{id:member.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   assert.equal((await call(operator.token,'get','/api/trips')).statusCode,200);assert.equal((await call(operator.token,'get','/api/company/clients')).statusCode,403);
   r=await call(b.admin.token,'post','/api/company/access/profiles',{id:Number(profile.id),expected_version:1,name:'Intento ajeno',base_role_id:Number(role.id),permissions:[],active:true,reason:'No permitido'});assert.equal(r.statusCode,404);
   r=await admin('post','/api/company/access/profiles',{id:Number(profile.id),expected_version:1,name:profile.name,base_role_id:Number(role.id),permissions:['trips.manage'],active:false,reason:'Desactivar perfil propio'});assert.equal(r.statusCode,200);
   assert.equal((await call(operator.token,'get','/api/trips')).statusCode,403);assert.equal(JSON.stringify((await pool.query('select * from role_permissions order by role_id,permission_id')).rows),before);
  });
  await t.test('105 personas: alta trazable, páginas completas sin duplicados y filtros acotados por empresa',async()=>{
   for(let i=0;i<105;i++){
    const r=await admin('post','/api/company/people',{name:'ListadoQA-'+String(i).padStart(3,'0'),rut:rut(16000000+i),birth_date:'1990-01-01',job_title:i%2?'Administración':'Operaciones',create_account:false});
    assert.equal(r.statusCode,201,JSON.stringify(r.payload));
   }
   const ids=[];
   for(let page=1;page<=5;page++){
    const r=await admin('get','/api/company/people',{}, {},{q:'ListadoQA-',page:String(page),page_size:'25',sort:'name',direction:'asc'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.total,105);assert.equal(r.payload.rows.length,page===5?5:25);ids.push(...r.payload.rows.map(p=>p.id));
   }
   assert.equal(new Set(ids).size,105);
   const foreign=await call(b.admin.token,'get','/api/company/people',{}, {},{q:'ListadoQA-'});assert.equal(foreign.payload.total,0);
   const events=await h.one("select count(*)::int n from person_events where company_id=$1 and actor_user_id=$2 and action='create'",[a.id,a.admin.id]);assert.ok(events.n>=105);
  });
  await t.test('soporte con sesión real exige empresa, caso, alcance y vigencia en cada petición',async()=>{
   const platform=await h.account(null,'platform_superadmin','Plataforma QA'),support=await h.account(null,'platform_support','Soporte QA');
   let r=await call(platform.token,'post','/api/support/grants',{company_id:a.id,user_id:support.id,scopes:['profiles'],expires_at:new Date(Date.now()+86400000).toISOString(),reason:'Soporte autorizado sintético'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));const grant=r.payload;
   const scoped=(url,cid=a.id)=>h.run(support.token,'get',url,{headers:{'x-company-context':String(cid)}});
   assert.equal((await scoped('/api/company/access')).statusCode,403);
   r=await call(support.token,'post','/api/support/cases',{company_id:a.id,reason:'Revisión sintética de perfiles'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   assert.equal((await scoped('/api/company/access')).statusCode,200);assert.equal((await scoped('/api/company/people')).statusCode,403);assert.equal((await scoped('/api/company/access',b.id)).statusCode,403);
   await pool.query("update company_support_grants set created_at=now()-interval '1 day',expires_at=now()-interval '1 second' where id=$1",[grant.id]);
   assert.equal((await scoped('/api/company/access')).statusCode,403);
   assert.equal(JSON.stringify((await pool.query('select * from role_permissions order by role_id,permission_id')).rows),before);
  });
  await t.test('licencia vencida bloquea conductor; fin de permiso retorna solo si no quedan otros bloqueos y notifica una vez',async()=>{
   const role=await h.one("select id from roles where code='driver'");
   let r=await admin('post','/api/company/people',{name:'Conductor temporal sintético',rut:rut(18000000),birth_date:'1990-01-01',create_account:true,email:'return@acceptance.invalid',password:h.password,role_id:Number(role.id),contract:{type:'indefinite',start_date:'2000-01-01'},license:{classes:['A5'],printed_expiry:'2099-12-31'}});assert.equal(r.statusCode,201,JSON.stringify(r.payload));driver=r.payload.person;
   const token=await h.session(driver.user_id),personId=driver.id;
   assert.equal((await call(token,'get','/api/company/clients')).statusCode,403);
   const own=await h.one("insert into trips(company_id,driver_id,trip_number,origin,destination) values($1,$2,'ROLE-OWN','O','D') returning id",[a.id,driver.driver_id]);
   const other=await h.one("insert into trips(company_id,trip_number,origin,destination) values($1,'ROLE-OTHER','O','D') returning id",[a.id]);
   assert.equal((await call(token,'get','/api/operations/trips/:id/pod',{}, {id:own.id})).statusCode,200);
   assert.equal((await call(token,'get','/api/operations/trips/:id/pod',{}, {id:other.id})).statusCode,404);
   const permit=await admin('post','/api/company/people/:id/conditions',{type:'permission',start_date:'2000-01-01',end_date:'2000-01-02',reason:'Permiso histórico sintético'},{id:personId});assert.equal(permit.statusCode,200);
   const {reconcilePersonnelNotifications}=require('../personnel-monitor');await reconcilePersonnelNotifications(pool);
   assert.equal((await call(token,'get','/api/driver/trips')).statusCode,200);
   r=await admin('post','/api/company/people/:id/licenses',{classes:['A5'],printed_expiry:'2020-01-01'},{id:personId});assert.equal(r.statusCode,200);
   assert.equal((await call(token,'get','/api/driver/trips')).statusCode,403);
   await admin('post','/api/company/people/:id/conditions',{type:'vacation',start_date:'2001-01-01',end_date:'2001-01-02',reason:'Fin de vacaciones con licencia vencida'},{id:personId});
   await reconcilePersonnelNotifications(pool);
   const rows=(await pool.query("select message from personnel_notifications where company_id=$1 and person_id=$2 and kind='condition-ended' order by id",[a.id,personId])).rows;assert.equal(rows.length,2);assert.match(rows[0].message,/habilitado/);assert.match(rows[1].message,/otros bloqueos/);
   await reconcilePersonnelNotifications(pool);assert.equal((await h.one("select count(*)::int n from personnel_notifications where company_id=$1 and person_id=$2 and kind='condition-ended'",[a.id,personId])).n,2);
   await admin('post','/api/company/people/:id/licenses',{classes:['A5'],printed_expiry:'2099-12-31'},{id:personId});assert.equal((await call(token,'get','/api/driver/trips')).statusCode,200);
  });
 }finally{await runtime.close();}
});
