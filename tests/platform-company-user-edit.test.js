const test=require('node:test');
const assert=require('node:assert/strict');
const {registerAuthRoutes}=require('../auth');

const platform=(extra={})=>({id:1,name:'Plataforma servidor',company_id:null,legacy_permissions:[],memberships:[],
 platform_memberships:[{id:99,active:true,role_code:'platform_superadmin',permissions:['platform.users.manage']}],ownership_active:false,...extra});
const target={id:'42',name:'Cuenta anterior',email:'old@example.test',phone:'123',role_code:'viewer',shared_company:false,platform_identity:false,ownership_identity:false};
const step=(sql,values,rows=[],extra={})=>({sql,values,rows,...extra});
const begin=()=>step(/^BEGIN$/,[]),commit=()=>step(/^COMMIT$/,[]),rollback=()=>step(/^ROLLBACK$/,[]);
const locks=(row=target)=>[
 begin(),step(/^select id from companies where id=\$1 and active=true for no key update$/,[10],[{id:10}]),
 step(/^select id from user_memberships where company_id=\$1 and user_id=\$2 for update$/,[10,'42'],[{id:71}]),
 step(/^select id from company_people where company_id=\$1 and user_id=\$2 for update$/,[10,'42'],[{id:70}]),
 step(/^select u.id,u.name,u.email,u.phone,r.code role_code/,['42',10],row?[row]:[],{check:sql=>{
  assert.match(sql,/own.user_id=u.id and own.company_id=\$2/);
  assert.match(sql,/u.company_id=\$2 and not exists/);
  assert.match(sql,/other.company_id<>\$2 and other.active=true/);
  assert.match(sql,/platform_memberships pm where pm.user_id=u.id\)/);
  assert.match(sql,/platform_owners po where po.user_id=u.id\)/);
  assert.match(sql,/for update of u$/);
 }})
];
function harness(steps=[],{user=platform(),context='10',authenticated=true}={}){
 const calls=[],errors=[],routes=[];let releases=0,connects=0;
 const db={async query(sql,values=[]){
  calls.push({sql,values});
  if(sql.startsWith('select s.user_id from user_sessions'))return {rows:authenticated?[{user_id:1}]:[],rowCount:authenticated?1:0};
  if(sql.includes('po.owner_type ownership_role'))return {rows:[user],rowCount:1};
  if(sql.startsWith('update user_sessions set last_seen_at'))return {rows:[],rowCount:0};
  if(sql==='select id from companies where id=$1 and active=true'){
   assert.deepEqual(values,[Number(context)]);return {rows:[{id:Number(context)}],rowCount:1};
  }
  const expected=steps.shift();
  try{assert.ok(expected,`Unexpected SQL: ${sql}`);assert.match(sql,expected.sql);if(expected.values)assert.deepEqual(values,expected.values);expected.check?.(sql,values);}catch(e){errors.push(e);throw e;}
  if(expected.error)throw expected.error;
  return {rows:expected.rows,rowCount:expected.rows.length};
 },release(){releases++;}};
 const pool={query:db.query,async connect(){connects++;return db;}};
 const app={};for(const method of ['get','post','patch','put','delete'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});registerAuthRoutes(app,pool);
 return {calls,get releases(){return releases;},get connects(){return connects;},async invoke(body={},method='patch',path='/api/users/:id'){
  const route=routes.find(r=>r.method===method&&r.path===path);assert.ok(route);
  const req={params:{id:'42'},query:{},body,ip:'127.0.0.1',get:name=>name==='authorization'?'Bearer platform-session':name==='x-company-context'?context:''};
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.payload=value;return this;},sendStatus(code){this.statusCode=code;return this;}};
  const dispatch=async i=>{let next;await route.handlers[i](req,res,()=>{next=dispatch(i+1);return next;});if(next)await next;};await dispatch(0);
  assert.deepEqual(errors,[]);assert.equal(steps.length,0,'Expected SQL not executed');return {req,res};
 }};
}
const audit=(extra={})=>step(/^insert into audit_logs/,undefined,[],{...extra,check:(sql,v)=>{
 assert.deepEqual(v.slice(0,5),[10,1,'platform_company_user_update','user','42']);
 assert.deepEqual(v[5],{id:'42',name:target.name,email:target.email,phone:target.phone});
 assert.equal(v[6].actor_type,'platform');assert.equal(v[6].actor_name,'Plataforma servidor');assert.equal(v[6].context_company_id,10);assert.equal(v[6].reason,'Corrección solicitada');
 assert.equal('password_hash' in v[6],false);assert.equal('role_id' in v[6],false);assert.equal(JSON.stringify(v).includes('SecretPassword123'),false);
 }});

test('platform edits corporate name email phone and password through actual authentication/context middleware',async()=>{
 const h=harness([...locks(),step(/^select id from users where lower\(email\)/,['new@example.test','42'],[]),
  step(/^update users set name=\$1,email=\$2,phone=\$3,password_hash=\$4,must_change_password=true/,undefined,[{id:'42',name:'Nuevo',email:'new@example.test',phone:'555'}],{check:(sql,v)=>{
   assert.deepEqual(v.slice(0,3),['Nuevo','new@example.test','555']);assert.match(v[3],/^scrypt\$/);assert.deepEqual(v.slice(4),['42',10]);assert.match(sql,/own.company_id=\$6/);assert.doesNotMatch(sql,/role_id=|active=|ownership/);
  }}),step(/^delete from user_sessions where user_id=\$1$/,['42']),audit(),commit()]);
 const {req,res}=await h.invoke({name:' Nuevo ',email:'NEW@example.test',phone:'555',password:'SecretPassword123',reason:'Corrección solicitada'});
 assert.equal(res.statusCode,200);assert.equal(res.payload.password_changed,true);assert.equal(res.payload.company_id,10);
 assert.equal(req.user.actor_type,'platform');assert.equal(req.user.company_id,null);assert.deepEqual(req.user.permissions,['platform.users.manage']);assert.equal(h.releases,1);
});
test('contextual platform owner can edit company identity without company permission injection',async()=>{
 const owner=platform({platform_memberships:[{id:99,active:true,role_code:'platform_superadmin',permissions:[]}],ownership_role:'primary',ownership_active:true});
 const h=harness([...locks(),step(/^update users set phone=\$1/,['456','42',10],[{id:'42',name:target.name,email:target.email,phone:'456'}]),audit(),commit()],{user:owner});
 const {req,res}=await h.invoke({phone:'456',reason:'Corrección solicitada'});assert.equal(res.statusCode,200);assert.deepEqual(req.user.permissions,[]);
});
for(const [name,user] of [
 ['support',platform()],
 ['owner',platform({platform_memberships:[{id:99,active:true,role_code:'platform_superadmin',permissions:[]}],ownership_role:'primary',ownership_active:true})]
])test(`company-context allows verified native ${name} without injecting company permissions`,async()=>{
 const h=harness([
  step(/^select id,legal_name from companies where id=\$1 and active=true$/,[10],[{id:10,legal_name:'Empresa seleccionada'}]),
  step(/^insert into audit_logs/,undefined,[],{check:(sql,v)=>assert.deepEqual(v.slice(0,5),[10,1,'context_switch','company_context','10'])})
 ],{user,context:''});
 const {req,res}=await h.invoke({company_id:10},'post','/api/auth/company-context');assert.equal(res.statusCode,200);assert.equal(res.payload.company.id,10);
 assert.equal(req.user.actor_type,'platform');assert.equal(req.user.company_id,null);assert.equal(req.user.permissions.some(p=>p.startsWith('company.')),false);
});
test('company-context denies platform actor without context permission, support authority or verified ownership',async()=>{
 const h=harness([],{user:platform({platform_memberships:[{id:99,active:true,role_code:'platform_superadmin',permissions:[]}]}),context:''});
 assert.equal((await h.invoke({company_id:10},'post','/api/auth/company-context')).res.statusCode,403);
});
for(const [name,opts] of [['unauthenticated',{authenticated:false}],['no company',{context:''}],['missing platform user permission',{user:platform({platform_memberships:[{id:99,role_code:'platform_superadmin',permissions:[]}]})}],['inactive owner',{user:platform({platform_memberships:[{id:99,role_code:'platform_superadmin',permissions:[]}],ownership_role:'primary',ownership_active:false})}]])test(`corporate edit denies ${name} before connecting`,async()=>{
 const h=harness([],opts),{res}=await h.invoke({phone:'456',reason:'Corrección solicitada'});assert.ok([401,403].includes(res.statusCode));assert.equal(h.connects,0);
});
for(const key of ['role_id','active','ownership_role','platform_membership_id','company_id','contract_exempt','driver_id','must_change_password'])test(`corporate PATCH rejects protected ${key}`,async()=>{
 const h=harness(),{res}=await h.invoke({name:'Nuevo',reason:'Corrección solicitada',[key]:1});assert.equal(res.statusCode,403);assert.equal(h.connects,0);
});
for(const body of [{email:'new@example.test'},{reason:'Cambio empresarial'},{email:'new@example.test',active:false},{reason:'Cambio empresarial',role_id:5}])test(`scoped identity intent without company context refuses ${Object.keys(body)}`,async()=>{
 const h=harness([],{context:''}),{res}=await h.invoke(body);assert.equal(res.statusCode,403);assert.equal(h.connects,0);
});
for(const body of [{name:'Nuevo'},{name:'Nuevo',reason:''},{email:'not-email',reason:'Motivo'},{password:'short',reason:'Motivo'},{phone:{unexpected:1},reason:'Motivo'}])test(`corporate PATCH validates reason/credentials ${Object.keys(body)}`,async()=>{
 const h=harness(),{res}=await h.invoke(body);assert.equal(res.statusCode,400);assert.equal(h.connects,0);
});
for(const [name,row,status] of [['other company',null,404],['shared account',{...target,shared_company:true},403],['platform identity even inactive',{...target,platform_identity:true},403],['ownership identity even inactive',{...target,ownership_identity:true},403],['legacy administrator',{...target,role_code:'admin'},403]])test(`corporate PATCH refuses ${name} under scoped locks`,async()=>{
 const h=harness([...locks(row),rollback()]),{res}=await h.invoke({phone:'456',reason:'Corrección solicitada'});assert.equal(res.statusCode,status);assert.equal(h.releases,1);assert.equal(h.calls.some(c=>c.sql.startsWith('update users set')),false);
});
test('corporate email collision rolls back without modifying or associating the other identity',async()=>{
 const h=harness([...locks(),step(/^select id from users where lower\(email\)/,['taken@example.test','42'],[{id:'200'}]),rollback()]);
 assert.equal((await h.invoke({email:'taken@example.test',reason:'Corrección solicitada'})).res.statusCode,409);assert.equal(h.releases,1);
});
for(const failure of ['UPDATE','AUDIT','COMMIT'])test(`corporate PATCH rolls back on ${failure} failure and releases`,async()=>{
 const update=step(/^update users set phone=\$1/,['456','42',10],[{id:'42',name:target.name,email:target.email,phone:'456'}],failure==='UPDATE'?{error:Error('failed update')}:{});
 const steps=[...locks(),update];
 if(failure!=='UPDATE')steps.push(audit(failure==='AUDIT'?{error:Error('failed audit')}:{}));
 if(failure==='COMMIT')steps.push(step(/^COMMIT$/,[],[],{error:Error('failed commit')}));steps.push(rollback());
 const h=harness(steps);assert.equal((await h.invoke({phone:'456',reason:'Corrección solicitada'})).res.statusCode,400);assert.equal(h.releases,1);
});
test('Personnel policy flags survive the actual authenticated platform context without widening Auth permissions',async()=>{
 const h=harness([step(/^select company_id,enforced,time_zone/,[10],[{company_id:10,enforced:false,time_zone:'America/Santiago',regularization_before:new Date()}])]);
 const {req,res}=await h.invoke({},'get','/api/company/people/policy');assert.equal(res.statusCode,200);assert.equal(res.payload.platform_support,true);
 for(const flag of ['can_read','can_manage','can_accounts','can_licenses'])assert.equal(res.payload[flag],true);
 assert.equal(res.payload.context_company_id,10);assert.deepEqual(req.user.permissions,['platform.users.manage']);
});
