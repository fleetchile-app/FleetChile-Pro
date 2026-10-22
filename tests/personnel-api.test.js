const test=require('node:test');
const assert=require('node:assert/strict');
const {registerPersonnelRoutes,createBootstrapExemption}=require('../personnel-api');
const domain=require('../personnel-domain');
const BASE='/api/company/people';
const permissions=['company.people.read','company.people.manage','company.licenses.manage','company.users.manage'];
const actor={id:'1',name:'Actor servidor',actor_type:'company',scope:'company',company_id:'10',membership_id:'11',permissions};
const policy={company_id:'10',enforced:false,time_zone:'America/Santiago',regularization_before:'2026-10-22T12:00:00.000Z'};
const p={id:'70',company_id:'10',user_id:'42',membership_id:'71',driver_id:'8',name:'Persona',rut:'12345678-5',birth_date:'1990-01-01',job_title:'Conductor',role_id:'5',role_code:'driver',account_active:true,membership_active:true,membership_created_at:'2026-10-21T12:00:00.000Z',account_created_at:'2026-10-21T12:00:00.000Z',regularization_eligible:true};
const sql=(pattern,values,rows=[],extra={})=>({pattern,values,rows,...extra});
const begin=()=>sql(/^BEGIN$/,[]),commit=()=>sql(/^COMMIT$/,[]),rollback=()=>sql(/^ROLLBACK$/,[]);
const company=()=>sql(/^select id,user_limit,active from companies where id=\$1 for update$/,['10'],[{id:'10',user_limit:20,active:true}]);
const pol=()=>sql(/^select company_id,enforced,time_zone/,['10'],[policy]);
const membershipLock=()=>sql(/^select um.id from user_memberships um join company_people/,['10','70'],[{id:'71'}]);
const person=(row=p,lock=true)=>sql(/^select p\.\*/,['10','70'],row?[row]:[],{check:q=>lock?assert.match(q,/for update of p$/):assert.doesNotMatch(q,/for update/)});
const event=(action,why=null)=>sql(/^insert into person_events/,undefined,[],{check:(q,v)=>{
 assert.deepEqual(v.slice(0,5),['10','70','1','Actor servidor',action]);assert.equal(v[7],why);
}});
const audit=action=>sql(/^insert into audit_logs/,undefined,[],{check:(q,v)=>{
 assert.deepEqual(v.slice(0,5),['10','1',action,'company_person','70']);
 assert.equal(v[6].person_id,'70');assert.equal('rut' in v[6],false);assert.equal('conditions' in v[6],false);
}});
const txPerson=(row=p)=>[begin(),company(),membershipLock(),person(row)];
function harness(steps=[],user=actor,{reauth=true}={}){
 const calls=[],failures=[],routes=[];let releases=0,connects=0;
 const db={async query(q,v=[]){
  calls.push({q,v});const step=steps.shift();
  try{assert.ok(step,`Unexpected query: ${q}`);assert.match(q,step.pattern);if(step.values)assert.deepEqual(v,step.values);step.check?.(q,v);}
  catch(e){failures.push(e);throw e;}
  if(step.error)throw step.error;
  return {rows:step.rows||[],rowCount:(step.rows||[]).length};
 },release(){releases++;}};
 const pool={query:db.query,async connect(){connects++;return db;}};
 const app={};for(const method of ['get','post','patch','put'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
 const reauthCalls=[];
 registerPersonnelRoutes(app,pool,{resolveActorContext:req=>req.user,requirePermission:()=>{throw Error('Do not inherit a bypass');},isPlatformOwner:()=>true,
  hashPassword:async value=>'HASH:'+value,reauthenticateUser:async(db,uid,password)=>{reauthCalls.push({db,uid,password});return reauth;}});
 return {calls,db,pool,reauthCalls,get releases(){return releases;},get connects(){return connects;},async run(method,path,{body={},params={},query={}}={}){
  const route=routes.find(r=>r.method===method&&r.path===path);assert.ok(route,`Missing route ${method} ${path}`);
  const req={user,body,params:{id:'70',conditionId:'80',contractId:'90',notificationId:'100',membershipId:'71',...params},query,ip:'127.0.0.1'};
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.payload=value;return this;}};
  const run=async index=>{let continuation;await route.handlers[index](req,res,()=>{continuation=run(index+1);return continuation;});if(continuation)await continuation;};await run(0);
  assert.deepEqual(failures,[],'Query assertion caught by route');assert.equal(steps.length,0,'Expected query not reached');return res;
 }};
}
const histories=(contracts=[],conditions=[],licenses=[],events=false)=>[
 sql(/^select \* from person_contracts/,['10','70'],contracts),sql(/^select \* from person_conditions/,['10','70'],conditions),sql(/^select \* from person_driver_licenses/,['10','70'],licenses),
 ...(events?[sql(/^select \* from person_events/,['10','70'],[])]:[])
];

for(const [label,user,status] of [['anonymous',null,401],['wrong company context',{...actor,scope:'platform',company_id:null},403],['unresolved',{...actor,actor_type:'unresolved'},403],['no privilege',{...actor,permissions:[]},403],['owner without company permission',{...actor,actor_type:'platform',permissions:['platform.users.manage'],ownership_role:'primary'},403]])test(`actual route middleware rejects ${label}`,async()=>{
 const h=harness([],user);assert.equal((await h.run('get',BASE)).statusCode,status);assert.equal(h.connects,0);
});
for(const path of [BASE+'/:id/access',BASE+'/:id/role'])test(`administrative cannot change accounts through ${path}`,async()=>{
 const h=harness([],{...actor,permissions:['company.people.read','company.people.manage']});assert.equal((await h.run(path.endsWith('role')?'put':'patch',path,{body:{active:true,role_id:5,reason:'Prueba'}})).statusCode,403);
});
test('all scoped lookups bind context company, never a URL supplied company',async()=>{
 const h=harness([person(null,false)]);const res=await h.run('get',BASE+'/:id',{query:{company_id:'20'}});assert.equal(res.statusCode,404);
});
for(const field of ['contract_exempt','exemption_by','company_id','user_id','driver_id'])test(`local creation refuses injected ${field}`,async()=>{
 const h=harness();assert.equal((await h.run('post',BASE,{body:{name:'Persona',[field]:'20'}})).statusCode,400);assert.equal(h.connects,0);
});
test('missing company policy is a configuration error, not regularization permission',async()=>{
 const h=harness([sql(/^select company_id,enforced,time_zone/,['10'],[])]);
 assert.equal((await h.run('get',BASE+'/policy')).statusCode,409);
});
test('operations gets license-only SQL projection and serialized output, driver_id filter is scoped',async()=>{
 const row={...p,contracts:[],conditions:[],licenses:[{id:3,classes:['A4'],printed_expiry:'2099-01-01',effective_expiry:'2099-01-01',current:true}]};
 const h=harness([pol(),sql(/^select p.id,coalesce/,['10'],[row],{check:q=>{
  assert.match(q,/where r.code='driver'/);assert.match(q,/null::text email/);assert.match(q,/null::date birth_date/);
  assert.match(q,/null::text rut/);assert.match(q,/coalesce\(p.driver_id,u.driver_id\) and d.company_id=\$1/);
  assert.doesNotMatch(q,/from person_conditions c/);
 }})],{...actor,permissions:['company.licenses.manage']});
 const res=await h.run('get',BASE,{query:{driver_id:'8'}});assert.equal(res.statusCode,200);assert.equal(res.payload.total,1);
 const serialized=JSON.stringify(res.payload);for(const field of ['birth_date','rut','email','conditions','contracts','events','contract_exempt'])assert.equal(serialized.includes('"'+field+'"'),false,field);
 assert.equal(res.payload.rows[0].driver_id,'8');
});
test('operations cannot use health filters even when it has license permission',async()=>{
 const h=harness([],{...actor,permissions:['company.licenses.manage']});assert.equal((await h.run('get',BASE,{query:{condition:'medical_leave'}})).statusCode,403);
});
test('detail evaluates PostgreSQL Date contract, condition and license fields correctly',async()=>{
 const today=domain.companyDate(),[y,m,d]=today.split('-').map(Number);
 const contracts=[{type:'indefinite',start_date:new Date(2000,0,1),end_date:null}],licenses=[{classes:['B'],effective_expiry:new Date(y,m-1,d),current:true}];
 const h=harness([person({...p,birth_date:new Date(1990,0,1)},false),...histories(contracts,[],licenses,true),pol(),sql(/^select id,code,name from roles/,[],[])]);
 const res=await h.run('get',BASE+'/:id');assert.equal(res.statusCode,200);assert.equal(res.payload.access.allowed,true);
 assert.equal(res.payload.person.birth_date,'1990-01-01');assert.equal(res.payload.licenses[0].effective_expiry,today);
});
test('civil PostgreSQL DATE boundary remains correct in Pacific Auckland',()=>{
 const child=require('node:child_process').spawnSync(process.execPath,['--test','--test-name-pattern=^detail evaluates PostgreSQL Date',__filename],{env:{...process.env,TZ:'Pacific/Auckland'},encoding:'utf8'});
 assert.equal(child.status,0,child.stdout+child.stderr);
});
test('license-only detail omits all personal and employment metadata',async()=>{
 const h=harness([person(p,false),sql(/^select id,classes,issued_date/,['10','70'],[])],{...actor,permissions:['company.licenses.manage']});
 const res=await h.run('get',BASE+'/:id');assert.deepEqual(Object.keys(res.payload.person).sort(),['driver_id','id','name','role_code']);assert.equal('events' in res.payload,false);
});
test('declaration creates a draft without synthesizing account or contract',async()=>{
 const h=harness([begin(),company(),pol(),sql(/^insert into company_people/,['10',null,null,null,'Borrador',null,null,'','1'],[{id:'70',name:'Borrador',user_id:null}]),event('create'),audit('create'),commit()]);
 const res=await h.run('post',BASE,{body:{name:'Borrador'}});assert.equal(res.statusCode,201);assert.equal(h.releases,1);assert.equal(h.calls.some(c=>/insert into users|insert into person_contracts/.test(c.q)),false);
});
test('duplicate email rolls back without attaching the existing identity',async()=>{
 const h=harness([begin(),company(),pol(),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'viewer'}]),sql(/^select id from users where lower/,['taken@example.test'],[{id:'200'}]),rollback()]);
 const res=await h.run('post',BASE,{body:{name:p.name,rut:p.rut,birth_date:p.birth_date,create_account:true,email:'taken@example.test',password:'Password1234',role_id:'5'}});
 assert.equal(res.statusCode,409);assert.equal(h.releases,1);assert.equal(h.calls.some(c=>c.q.startsWith('insert into users')),false);
});
test('new active driver is atomic across user membership person contract driver license and audit',async()=>{
 const birth='1990-01-01',license={classes:['B'],printed_expiry:'2099-01-01'},newPerson={...p,birth_date:new Date(1990,0,1)};
 const h=harness([begin(),company(),pol(),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'driver'}]),sql(/^select id from users where lower/,['new@example.test'],[]),sql(/^select count\(\*\)::int n/,['10'],[{n:1}]),
  sql(/^insert into users/,undefined,[{id:'42'}],{check:(q,v)=>{assert.equal(v[0],'10');assert.equal(v[4],'HASH:Password1234');}}),
  sql(/^insert into user_memberships/,['42','10','5'],[{id:'71'}]),sql(/^insert into drivers/,['10',p.name,p.rut],[{id:'8'}]),sql(/^update users set driver_id/,['8','42','10']),
  sql(/^insert into company_people/,['10','42','71','8',p.name,p.rut,birth,'','1'],[newPerson]),
  sql(/^select id from person_contracts/,['10','70','2000-01-01',null]),sql(/^insert into person_contracts/,['10','70','indefinite','2000-01-01',null,null,'1'],[{id:2,type:'indefinite',start_date:new Date(2000,0,1),end_date:null}]),
  sql(/^select id from drivers/,['10','8'],[{id:'8'}]),sql(/^select \* from person_driver_licenses/,['10','70'],[]),sql(/^update person_driver_licenses set current=false/,['10','70']),
  sql(/^insert into person_driver_licenses/,['10','70',['B'],null,'2099-01-01','2099-01-01','1'],[{id:3,classes:['B'],effective_expiry:new Date(2099,0,1),current:true}]),
  sql(/^update drivers set license/,['B','2099-01-01','10','8']),event('create'),audit('create'),commit()]);
 const res=await h.run('post',BASE,{body:{name:p.name,rut:p.rut,birth_date:birth,create_account:true,email:'new@example.test',password:'Password1234',role_id:'5',contract:{type:'indefinite',start_date:'2000-01-01'},license}});
 assert.equal(res.statusCode,201);assert.equal(h.releases,1);
});
test('new active account without contract rolls back all account inserts',async()=>{
 const h=harness([begin(),company(),pol(),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'viewer'}]),sql(/^select id from users where lower/,['new@example.test'],[]),sql(/^select count\(\*\)::int n/,['10'],[{n:1}]),sql(/^insert into users/,undefined,[{id:'42'}]),sql(/^insert into user_memberships/,['42','10','5'],[{id:'71'}]),sql(/^insert into company_people/,undefined,[{...p,role_code:'viewer'}]),rollback()]);
 const res=await h.run('post',BASE,{body:{name:p.name,rut:p.rut,birth_date:p.birth_date,create_account:true,email:'new@example.test',password:'Password1234',role_id:'5'}});assert.equal(res.statusCode,400);assert.equal(h.releases,1);
});
test('a company membership cannot be regularized with the id from B',async()=>{
 const h=harness([begin(),company(),pol(),sql(/^select um.id,um.user_id/,['10','71'],[]),rollback()]);
 assert.equal((await h.run('post',BASE,{body:{name:'Persona',membership_id:'71'}})).statusCode,404);
});
test('condition extension locks scoped rows and records original and new dates with server actor',async()=>{
 const before={id:'80',type:'medical_leave',start_date:new Date(2026,0,1),end_date:new Date(2026,0,5)},after={...before,end_date:'2026-01-10'};
 const h=harness([...txPerson(),sql(/^select \* from person_conditions/,['10','70','80'],[before]),sql(/^update person_conditions set end_date/,['2026-01-10','10','70','80'],[after]),event('condition_extend','Extensión'),audit('condition_extend'),commit()]);
 const res=await h.run('post',BASE+'/:id/conditions/:conditionId/extend',{body:{end_date:'2026-01-10',reason:'Extensión',actor_name:'Cliente falso'}});assert.equal(res.statusCode,200);assert.equal(h.releases,1);
});
test('condition cancellation is scoped to company and person before mutation',async()=>{
 const h=harness([...txPerson(),sql(/^select \* from person_conditions/,['10','70','80'],[]),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/conditions/:conditionId/cancel',{body:{reason:'No corresponde'}})).statusCode,404);
});
test('own suspension is rejected before inserting a condition',async()=>{
 const h=harness(txPerson({...p,user_id:'1'}).concat(rollback()));
 assert.equal((await h.run('post',BASE+'/:id/conditions',{body:{type:'suspended',start_date:'2026-01-01',end_date:'2026-01-02'}})).statusCode,403);
});
test('license renewal serializes on person, retires current and syncs canonical driver in same transaction',async()=>{
 const old={id:2,current:true},next={id:3,current:true,classes:['A4'],effective_expiry:'2026-12-31'};
 const h=harness([...txPerson(),pol(),sql(/^select id from drivers/,['10','8'],[{id:'8'}]),sql(/^select \* from person_driver_licenses/,['10','70'],[old]),sql(/^update person_driver_licenses set current=false/,['10','70']),sql(/^insert into person_driver_licenses/,['10','70',['A4'],null,'2025-01-01','2026-12-31','1'],[next]),sql(/^update drivers set license/,['A4','2026-12-31','10','8']),sql(/^insert into personnel_notifications/,['10','70','license_renewed:3','license_renewed','Se registró una renovación de licencia de conducir.']),event('license_renew'),audit('license_renew'),commit()]);
 assert.equal((await h.run('post',BASE+'/:id/licenses',{body:{classes:['A4'],printed_expiry:'2025-01-01'}})).statusCode,200);
});
test('license driver update failure rolls back canonical renewal and always releases',async()=>{
 const h=harness([...txPerson(),pol(),sql(/^select id from drivers/,['10','8'],[{id:'8'}]),sql(/^select \* from person_driver_licenses/,['10','70'],[]),sql(/^update person_driver_licenses set current=false/,['10','70']),sql(/^insert into person_driver_licenses/,undefined,[{id:3}]),sql(/^update drivers set license/,undefined,[],{error:Error('DB failure')}),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/licenses',{body:{classes:['B'],printed_expiry:'2099-01-01'}})).statusCode,500);assert.equal(h.releases,1);
});
test('access toggle updates membership only, leaving global users and other blockers untouched',async()=>{
 const h=harness([...txPerson(),sql(/^select id,active from user_memberships/,['10','71','42'],[{id:'71',active:false}]),sql(/^update user_memberships set active/, [true,'10','71','42'],[{id:'71',active:true}]),event('membership_access','Reactivar'),audit('membership_access'),commit()]);
 assert.equal((await h.run('patch',BASE+'/:id/access',{body:{active:true,reason:'Reactivar'}})).statusCode,200);assert.equal(h.calls.some(c=>/update users|update person_conditions/.test(c.q)),false);
});
test('activation calls injected reauthentication with correct pool user and password',async()=>{
 const h=harness([],actor,{reauth:false});assert.equal((await h.run('post',BASE+'/policy/activate',{body:{password:'actual'}})).statusCode,401);
 assert.equal(h.reauthCalls[0].db,h.pool);assert.equal(h.reauthCalls[0].uid,'1');assert.equal(h.reauthCalls[0].password,'actual');
});
test('activation cannot ignore missing active membership profiles',async()=>{
 const h=harness([begin(),company(),pol(),sql(/^select p.id,coalesce/,['10'],[{id:null,user_id:'42',membership_id:'71',name:'Pendiente',role_code:'viewer',account_active:true,membership_active:true,contracts:[],conditions:[],licenses:[]}]),sql(/^select u.id,u.name from users u/,['10'],[]),rollback()]);
 assert.equal((await h.run('post',BASE+'/policy/activate',{body:{password:'actual'}})).statusCode,409);assert.equal(h.releases,1);
});
test('changing away from company_admin revokes its stored exemption before commit',async()=>{
 const exempt={...p,role_code:'company_admin',contract_exempt:true,exemption_by:'9',exemption_at:'2026-01-01'};
 const h=harness([...txPerson(exempt),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'viewer'}]),...histories(),pol(),sql(/^update user_memberships set role_id/,['5','10','71','42'],[{id:'71',role_id:'5'}]),sql(/^update company_people set contract_exempt=false/,['Exención revocada por cambio de rol: Cambio','1','10','70'],[{...exempt,contract_exempt:false}]),event('exemption_role_revoke','Cambio'),audit('exemption_role_revoke'),event('membership_role','Cambio'),audit('membership_role'),commit()]);
 assert.equal((await h.run('put',BASE+'/:id/role',{body:{role_id:'5',reason:'Cambio'}})).statusCode,200);
});
test('overlapping contracts return 409 without inserting another contract',async()=>{
 const h=harness([...txPerson(),sql(/^select id from person_contracts/,['10','70','2026-01-01',null],[{id:2}]),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/contracts',{body:{type:'indefinite',start_date:'2026-01-01'}})).statusCode,409);
});
test('contract replacement is atomic and preserves the voided record and reason',async()=>{
 const old={id:'90',type:'fixed',start_date:'2026-01-01',end_date:'2026-02-01'},next={id:'91',type:'indefinite',start_date:'2026-01-01',end_date:null};
 const h=harness([...txPerson(),sql(/^select \* from person_contracts/,['10','70','90'],[old]),sql(/^update person_contracts set voided_at/,['1','10','70','90'],[{...old,voided_at:'now'}]),sql(/^select id from person_contracts/,['10','70','2026-01-01',null],[]),sql(/^insert into person_contracts/,['10','70','indefinite','2026-01-01',null,null,'1'],[next]),event('contract_replace','Rectificación'),audit('contract_replace'),commit()]);
 assert.equal((await h.run('post',BASE+'/:id/contracts/:contractId/replace',{body:{reason:'Rectificación',contract:{type:'indefinite',start_date:'2026-01-01'}}})).statusCode,200);
});
test('notification read cannot mark a notification from another company',async()=>{
 const h=harness([sql(/^insert into personnel_notification_reads/,['10','1','100'],[],{check:q=>assert.match(q,/where company_id=\$1 and id=\$3/)})]);
 assert.equal((await h.run('post',BASE+'/notifications/:notificationId/read')).statusCode,404);
});
test('bootstrap exemption rejects local owner or role name without platform identity before SQL',async()=>{
 await assert.rejects(()=>createBootstrapExemption({query(){throw Error('No SQL');}},{membershipId:'71',actor:{...actor,ownership_role:'primary',permissions:['platform.users.manage']},reason:'Motivo'}),e=>e.status===403);
});
test('platform exemption route rejects a company_admin even with injected platform permission',async()=>{
 const h=harness([],{...actor,permissions:['platform.users.manage']});assert.equal((await h.run('post','/api/platform/personnel/:membershipId/exemption',{body:{exempt:true,reason:'Motivo'}})).statusCode,403);
});
test('bootstrap exemption verifies actual administrator role and records platform server identity',async()=>{
 const platform={...actor,actor_type:'platform',scope:'platform',company_id:null,permissions:['platform.users.manage']};
 const h=harness([sql(/^select um.id,um.company_id,um.user_id/,['71'],[{id:'71',company_id:'10',user_id:'42',name:p.name}],{check:q=>{assert.match(q,/r.code='company_admin'/);assert.match(q,/for update of um/);}}),
  sql(/^select \* from company_people/,['10','71'],[]),sql(/^insert into company_people/,['10','42','71',p.name,'Bootstrap verificado','1'],[{...p,contract_exempt:true}]),event('platform_exemption','Bootstrap verificado'),audit('platform_exemption')]);
 const out=await createBootstrapExemption(h.db,{membershipId:'71',actor:platform,reason:'Bootstrap verificado'});assert.equal(out.contract_exempt,true);
});
test('account creation honors user_limit under locked company without creating a user',async()=>{
 const h=harness([begin(),company(),pol(),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'viewer'}]),sql(/^select id from users where lower/,['new@example.test'],[]),sql(/^select count\(\*\)::int n/,['10'],[{n:20}]),rollback()]);
 const res=await h.run('post',BASE,{body:{name:p.name,rut:p.rut,birth_date:p.birth_date,create_account:true,email:'new@example.test',password:'Password1234',role_id:'5'}});assert.equal(res.statusCode,409);assert.equal(h.calls.some(c=>c.q.startsWith('insert into users')),false);assert.equal(h.releases,1);
});
test('condition event audit failure rolls back insertion and releases the same transaction',async()=>{
 const h=harness([...txPerson(),sql(/^insert into person_conditions/,['10','70','vacation','2026-01-01','2026-01-02','1'],[{id:80}]),event('condition_create'),sql(/^insert into audit_logs/,undefined,[],{error:Error('audit unavailable')}),rollback()]);
 const res=await h.run('post',BASE+'/:id/conditions',{body:{type:'vacation',start_date:'2026-01-01',end_date:'2026-01-02'}});assert.equal(res.statusCode,500);assert.equal(h.releases,1);assert.equal(h.calls.some(c=>c.q==='COMMIT'),false);
});
test('contract replacement rolls back the void when replacement validation fails',async()=>{
 const old={id:'90',type:'fixed',start_date:'2026-01-01',end_date:'2026-02-01'};
 const h=harness([...txPerson(),sql(/^select \* from person_contracts/,['10','70','90'],[old]),sql(/^update person_contracts set voided_at/,['1','10','70','90'],[{...old,voided_at:'now'}]),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/contracts/:contractId/replace',{body:{reason:'Rectificación',contract:{type:'fixed',start_date:'2026-01-02',end_date:'2026-01-01'}}})).statusCode,400);assert.equal(h.releases,1);
});
test('malformed driver filter is rejected before database access even with empty list',async()=>{
 const h=harness();assert.equal((await h.run('get',BASE,{query:{driver_id:'8 OR 1=1'}})).statusCode,400);
});

const pending={...p,id:null,name:'Pendiente',role_code:'viewer',contracts:[],conditions:[],licenses:[]};
async function pendingList(row= pending,polic=policy){
 const h=harness([
  sql(/^select company_id,enforced,time_zone/,['10'],[polic],{check:q=>assert.match(q,/regularization_before/)}),
  sql(/^select p.id,coalesce/,['10'],[row],{check:q=>{
   assert.match(q,/um.created_at membership_created_at,u.created_at account_created_at/);
   assert.match(q,/pp.company_id=\$1 and pp.enforced=false/);
   assert.match(q,/um.created_at<=pp.regularization_before and u.created_at<=pp.regularization_before/);
   assert.match(q,/\) regularization_eligible/);
  }}),sql(/^select count\(\*\)::int n from personnel_notifications/,['10','1'],[{n:0}]),sql(/^select id,code,name from roles/,[],[])
 ]);
 const res=await h.run('get',BASE);assert.equal(res.statusCode,200);return res.payload.rows[0].access;
}
test('missing profile is grandfathered only for account and membership before server cutoff',async()=>{
 const access=await pendingList();assert.equal(access.allowed,true);assert.deepEqual(access.reasons,[]);assert.equal(access.regularization_required,true);assert.equal(access.enforced,false);
});
test('cutoff boundary is inclusive for both account and membership timestamps',async()=>{
 const access=await pendingList({...pending,membership_created_at:new Date(policy.regularization_before),account_created_at:policy.regularization_before});assert.equal(access.allowed,true);
});
for(const [name,change,polic] of [
 ['new membership',{membership_created_at:'2026-10-22T12:00:00.001Z'}],
 ['new account',{account_created_at:'2026-10-22T12:00:00.001Z'}],
 ['absent membership timestamp',{membership_created_at:null}],
 ['absent account timestamp',{account_created_at:undefined}],
 ['invalid membership timestamp',{membership_created_at:'not-a-timestamp'}],
 ['invalid account timestamp',{account_created_at:new Date(NaN)}],
 ['absent cutoff',{}, {...policy,regularization_before:null}],
 ['invalid cutoff',{}, {...policy,regularization_before:'invalid'}],
 ['policy active',{}, {...policy,enforced:true}],
 ['SQL precision rejects later fractional timestamp',{regularization_eligible:false,membership_created_at:'2026-10-22T12:00:00.000001Z'}],
 ['missing authoritative eligibility',{regularization_eligible:undefined}],
 ['truthy eligibility is not authorization',{regularization_eligible:'true'}]
])test(`missing profile fails closed for ${name}`,async()=>{
 const access=await pendingList({...pending,...change},polic||policy);assert.equal(access.allowed,false);assert.ok(access.reasons.includes('PERSON_NOT_REGULARIZED'));assert.equal(access.enforced,true);
});
test('grandfathering does not override membership or global account deactivation',async()=>{
 for(const [key,code] of [['membership_active','MEMBERSHIP_DISABLED'],['account_active','ACCOUNT_DISABLED']]){
  const access=await pendingList({...pending,[key]:false});assert.equal(access.allowed,false);assert.ok(access.reasons.includes(code));
 }
});
test('a real profile cannot use the grandfathering exemption to ignore missing contracts',async()=>{
 const access=await pendingList({...pending,id:'70'});assert.equal(access.allowed,false);assert.ok(access.reasons.includes('CONTRACT_MISSING'));
});

const draft={...p,user_id:null,membership_id:null,driver_id:null,role_code:null,role_id:null,account_active:null,membership_active:null};
const accountBody={email:'new@example.test',password:'Password1234',role_id:'5'};
const accountQueries=(role='viewer')=>[
 sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:role}]),
 sql(/^select id from users where lower/,['new@example.test'],[]),
 sql(/^select count\(\*\)::int n/,['10'],[{n:1}]),
 sql(/^insert into users/,['10','5',p.name,'new@example.test','HASH:Password1234',null],[{id:'42'}]),
 sql(/^insert into user_memberships/,['42','10','5'],[{id:'71'}])
];
const linkDraft=(role='viewer',rows)=>sql(/^update company_people set user_id=\$1,membership_id=\$2/,['42','71',role==='driver'?'8':null,p.name,p.rut,p.birth_date,p.job_title,'1','10','70'],rows??[{...p,driver_id:role==='driver'?'8':null,role_code:role}],{check:q=>assert.match(q,/where company_id=\$9 and id=\$10 and user_id is null and membership_id is null returning \*$/)});
const validContracts=[{id:'90',type:'indefinite',start_date:'2000-01-01',end_date:null}];
for(const [name,permissions] of [['people manager only',['company.people.manage']],['account manager only',['company.users.manage']]])test(`draft account requires both permissions: ${name}`,async()=>{
 const h=harness([],{...actor,permissions});assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,403);assert.equal(h.connects,0);
});
test('draft account cannot select a person in another company',async()=>{
 const h=harness([...txPerson(null),rollback()]);assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,404);
});
test('draft account refuses an already linked person without another user insert',async()=>{
 const h=harness([...txPerson(p),rollback()]);assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,409);
});
test('draft account requires complete person before hashing or creating credentials',async()=>{
 const h=harness([...txPerson({...draft,rut:null}),pol(),rollback()]);assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,400);
});
test('draft account rejects globally existing email and rolls back',async()=>{
 const h=harness([...txPerson(draft),pol(),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'viewer'}]),sql(/^select id from users where lower/,['new@example.test'],[{id:'200'}]),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,409);assert.equal(h.calls.some(c=>c.q.startsWith('insert into users')),false);assert.equal(h.releases,1);
});
test('draft account respects quota under the same locked company row',async()=>{
 const h=harness([...txPerson(draft),pol(),sql(/^select id,code,name from roles where id/,['5'],[{id:'5',code:'viewer'}]),sql(/^select id from users where lower/,['new@example.test'],[]),sql(/^select count\(\*\)::int n/,['10'],[{n:20}]),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,409);assert.equal(h.calls.some(c=>c.q.startsWith('insert into users')),false);
});
test('draft becomes an active account keeping person id and RUT without inserting another person',async()=>{
 const h=harness([...txPerson(draft),pol(),...accountQueries(),linkDraft(),...histories(validContracts),event('account_create'),audit('account_create'),commit()]);
 const res=await h.run('post',BASE+'/:id/account',{body:accountBody});assert.equal(res.statusCode,201);assert.equal(res.payload.person.id,'70');assert.equal(res.payload.person.rut,p.rut);assert.equal(res.payload.access.allowed,true);
 assert.equal(h.calls.some(c=>c.q.startsWith('insert into company_people')),false);assert.equal(h.releases,1);
});
for(const [name,contracts,conditions] of [
 ['no contract',[],[]],['expired contract',[{start_date:'2000-01-01',end_date:'2000-12-31'}],[]],
 ['active condition',validContracts,[{start_date:'2000-01-01',end_date:'2099-01-01',type:'suspended'}]]
])test(`draft account rolls back credentials and linkage for ${name}`,async()=>{
 const h=harness([...txPerson(draft),pol(),...accountQueries(),linkDraft(),...histories(contracts,conditions),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,409);assert.equal(h.calls.some(c=>c.q==='COMMIT'),false);assert.equal(h.releases,1);
});
test('draft driver account provisions driver and canonical license, verifies eligibility then audits',async()=>{
 const licensed={id:3,classes:['B'],printed_expiry:'2099-01-01',effective_expiry:'2099-01-01',current:true};
 const h=harness([...txPerson(draft),pol(),...accountQueries('driver'),
  sql(/^insert into drivers/,['10',p.name,p.rut],[{id:'8'}]),sql(/^update users set driver_id/,['8','42','10']),linkDraft('driver'),
  sql(/^select id from drivers/,['10','8'],[{id:'8'}]),sql(/^select \* from person_driver_licenses/,['10','70'],[]),sql(/^update person_driver_licenses set current=false/,['10','70']),sql(/^insert into person_driver_licenses/,['10','70',['B'],null,'2099-01-01','2099-01-01','1'],[licensed]),sql(/^update drivers set license/,['B','2099-01-01','10','8']),
  ...histories(validContracts,[],[licensed]),event('account_create'),audit('account_create'),commit()]);
 const res=await h.run('post',BASE+'/:id/account',{body:{...accountBody,license:{classes:['B'],printed_expiry:'2099-01-01'}}});assert.equal(res.statusCode,201);assert.equal(res.payload.person.driver_id,'8');assert.equal(res.payload.access.allowed,true);assert.equal(h.releases,1);
});
test('draft driver must not steal another global account association',async()=>{
 const h=harness([...txPerson({...draft,driver_id:'8'}),pol(),...accountQueries('driver'),sql(/^select id from drivers/,['10','8'],[{id:'8'}]),sql(/^select id from users where driver_id/,['8','42'],[{id:'200'}]),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,409);assert.equal(h.calls.some(c=>c.q.startsWith('update users set driver_id')),false);
});
test('draft account audit failure rolls back the new user membership and person link',async()=>{
 const h=harness([...txPerson(draft),pol(),...accountQueries(),linkDraft(),...histories(validContracts),event('account_create'),sql(/^insert into audit_logs/,undefined,[],{error:Error('audit failure')}),rollback()]);
 assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,500);assert.equal(h.releases,1);assert.equal(h.calls.some(c=>c.q==='COMMIT'),false);
});
test('draft account compare-and-set failure is rolled back rather than returning success',async()=>{
 const h=harness([...txPerson(draft),pol(),...accountQueries(),linkDraft('viewer',[]),rollback()]);assert.equal((await h.run('post',BASE+'/:id/account',{body:accountBody})).statusCode,409);
});
