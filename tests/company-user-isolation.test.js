const test=require('node:test');
const assert=require('node:assert/strict');
const {registerAuthRoutes}=require('../auth');

const result=rows=>({rows,rowCount:rows.length});
const personnelSnapshot={company_id:10,policy:{enforced:false,time_zone:'America/Santiago'},regularization_eligible:true,person:null,membership:{active:true,role_code:'company_admin'},account_active:true,contracts:[],conditions:[],licenses:[]};
const company=(extra={})=>({id:1,company_id:99,role_code:'viewer',legacy_permissions:[],
  memberships:[{id:11,company_id:10,role_code:'company_admin',active:true,permissions:['company.users.manage']}],platform_memberships:[],personnel_state:personnelSnapshot,...extra});
const platform=()=>company({memberships:[],platform_memberships:[{id:8,active:true,role_code:'platform_superadmin',permissions:['platform.users.manage']}]});
const legacy=()=>company({memberships:[],company_id:10,role_code:'admin'});

// Only database results are mocked. Authentication, identity resolution, guards,
// route handlers, password hashing and audit code all run from production.
function harness(actor=company(),steps=[]){
  const calls=[],failures=[];let released=0,connected=0;
  const query=async(sql,values=[])=>{
    calls.push({sql,values});
    try{
      if(sql.startsWith('select s.user_id from user_sessions'))return result([{user_id:1}]);
      if(sql.includes('po.owner_type ownership_role')&&values[0]===1)return result(actor?[actor]:[]);
      if(sql.startsWith('update user_sessions set last_seen_at'))return result([]);
      const step=steps.shift();assert.ok(step,`Unexpected SQL: ${sql}`);
      assert.match(sql,step.sql);if(step.values)assert.deepEqual(values,step.values);
      if(step.check)step.check(sql,values);
      if(step.error)throw step.error;
      return result(step.rows||[]);
    }catch(error){failures.push(error);throw error;}
  };
  const pool={query,async connect(){connected++;return {query,release(){released++;}}}};
  const routes=[];const app={};
  for(const method of ['get','post','patch','delete','put'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
  registerAuthRoutes(app,pool);
  return {calls,get connected(){return connected;},get released(){return released;},
    async invoke(method,path,body={},options={}){
      const route=routes.find(r=>r.method===method&&r.path===path);assert.ok(route);
      const req={body,params:{id:'42'},query:{},ip:'127.0.0.1',get:name=>name==='authorization'?'Bearer test-session':'',...options};
      const res={statusCode:200,status(code){this.statusCode=code;return this;},json(payload){this.payload=payload;return this;},sendStatus(code){this.statusCode=code;return this;}};
      const dispatch=async index=>{let continuation;await route.handlers[index](req,res,()=>{assert.equal(continuation,undefined);continuation=dispatch(index+1);return continuation;});if(continuation)await continuation;};
      await dispatch(0);
      assert.deepEqual(failures,[],'SQL expectations failed inside a caught route error');
      assert.equal(steps.length,0,'Unexecuted database expectations');
      return res;
    }};
}
const begin=()=>({sql:/^BEGIN$/}),rollback=()=>({sql:/^ROLLBACK$/}),commit=()=>({sql:/^COMMIT$/});
const audit=companyId=>({sql:/^insert into audit_logs/,check:(sql,v)=>assert.equal(v[0],companyId)});
const target=rows=>({sql:/^select u.id,/,values:['42',10],rows,check:sql=>{
  assert.match(sql,/own.user_id=u.id and own.company_id=\$2/);
  assert.doesNotMatch(sql,/own.active=true/); // inactive own membership remains administrable
  assert.match(sql,/u.company_id=\$2 and not exists/);
  assert.match(sql,/other.active=true and other.company_id<>\$2/);
  assert.match(sql,/platform_memberships pm where pm.user_id=u.id and pm.active=true/);
  assert.match(sql,/for update of u$/);
}});
const own={id:42,shared_company:false,active_platform:false};
const companyExists=()=>({sql:/^select id from companies/,values:[10],rows:[{id:10}]});
const role=(code='manager')=>({sql:/^select id,code,name from roles/,values:[5],rows:[{id:5,code}]});

test('GET company binds membership lateral to A including inactive, excludes active platform and unsafe legacy fallback',async()=>{
  const rows=[{id:42,company_id:10,company_name:'Empresa A',role_id:5,role_code:'manager',role_name:'Gestor A',modern_membership_id:71,modern_company_id:10,modern_membership_active:false}];
  const h=harness(company(),[{sql:/^select u.id,u.name/,values:[false,10],rows,check:sql=>{
    assert.match(sql,/um.id modern_membership_id/);
    assert.match(sql,/where um.user_id=u.id and um.company_id=\$2 order by/);
    assert.match(sql,/and pm.active is null/);
    assert.match(sql,/other.active=true and other.company_id<>\$2/);
    const projection=sql.slice(0,sql.indexOf('from users u'));
    assert.match(projection,/coalesce\(um.company_id,u.company_id\) company_id/);
    assert.match(projection,/coalesce\(um.role_id,u.role_id\) role_id/);
    for(const [legacy,own,alias] of [['r.code','um.role_code','role_code'],['r.name','um.role_name','role_name'],['c.legal_name','um.company_name','company_name']]){
      assert.ok(projection.includes(`case when um.id is null then ${legacy} else ${own} end ${alias}`));
    }
    assert.match(sql,/select um.id,um.company_id,um.role_id,um.active/);
  }}]);
  const res=await h.invoke('get','/api/users',{}, {query:{company_id:20}});
  assert.equal(res.statusCode,200);assert.deepEqual(res.payload,rows);
  assert.equal(res.payload[0].company_id,10);assert.equal(res.payload[0].company_name,'Empresa A');assert.equal(res.payload[0].role_code,'manager');
});
for(const [name,actor,values] of [['platform',platform,[true,null]],['legacy',legacy,[false,10]]])test(`GET ${name} preserves active latest membership selection`,async()=>{
  const h=harness(actor(),[{sql:/^select u.id,u.name/,values,check:sql=>{
    assert.match(sql,/where um.user_id=u.id and um.active=true order by/);
    assert.doesNotMatch(sql,/and pm.active is null/);
    assert.match(sql,/u.company_id,u.driver_id,u.role_id,r.code role_code,r.name role_name,c.legal_name company_name/);
    assert.doesNotMatch(sql,/coalesce\(um.company_id,u.company_id\)/);
    assert.doesNotMatch(sql,/modern_membership_id/);
  }}]);assert.equal((await h.invoke('get','/api/users')).statusCode,200);
});
for(const [name,actor,status] of [
  ['unauthenticated',null,401],['without permission',company({memberships:[{id:11,company_id:10,role_code:'viewer',permissions:[]}]}),403],
  ['ambiguous memberships',company({memberships:[{id:11,company_id:10},{id:12,company_id:20}]}),403]
])for(const [method,path,body] of [['get','/api/users',{}],['post','/api/users/:id/memberships',{role_id:5}],['patch','/api/users/:id',{name:'Nuevo'}]])test(`${method} ${name} is blocked by actual middleware`,async()=>{
  const h=harness(actor);assert.equal((await h.invoke(method,path,body)).statusCode,status);assert.equal(h.connected,0);
});

for(const [name,rows,status] of [['exclusive B',[],404],['unknown user',[],404],['active platform',[{...own,active_platform:true}],403]])test(`POST membership rejects ${name} before INSERT`,async()=>{
  const h=harness(company(),[begin(),target(rows),rollback()]);
  assert.equal((await h.invoke('post','/api/users/:id/memberships',{role_id:5,company_id:20})).statusCode,status);
  assert.equal(h.calls.some(c=>c.sql.startsWith('insert into')),false);assert.equal(h.released,1);
});
test('POST own legacy target binds A despite malicious company_id, validates company role and audits',async()=>{
  const h=harness(company(),[begin(),target([own]),companyExists(),role(),
    {sql:/^insert into user_memberships/,values:['42',10,5,true],rows:[{id:71,user_id:42,company_id:10,role_id:5,active:true}]},audit(10),commit()]);
  const res=await h.invoke('post','/api/users/:id/memberships',{role_id:5,company_id:20});
  assert.equal(res.statusCode,201);assert.equal(res.payload.company_id,10);assert.equal(h.released,1);
});
test('POST company cannot assign platform role',async()=>{
  const h=harness(company(),[begin(),target([own]),companyExists(),role('platform_superadmin'),rollback()]);
  assert.equal((await h.invoke('post','/api/users/:id/memberships',{role_id:5})).statusCode,400);
  assert.equal(h.calls.some(c=>c.sql.startsWith('insert into')),false);
});
for(const [name,actor] of [['platform',platform],['legacy',legacy]])test(`POST ${name} preserves linking flow without company target restriction`,async()=>{
  const h=harness(actor(),[begin(),companyExists(),role(),
    {sql:/^insert into user_memberships/,values:['42',10,5,true],rows:[{id:71,company_id:10}]},audit(10),commit()]);
  assert.equal((await h.invoke('post','/api/users/:id/memberships',{role_id:5,company_id:10})).statusCode,201);
});
for(const body of [{active:false},{active:true},{role_id:5},{name:'Nuevo',active:false}])test(`PATCH company refuses global state ${JSON.stringify(body)}`,async()=>{
  const h=harness();const res=await h.invoke('patch','/api/users/:id',body);
  assert.equal(res.statusCode,403);assert.match(res.payload.error,/PATCH \/api\/user-memberships\/:id/);assert.equal(h.connected,0);
});
for(const flags of [{shared_company:true},{active_platform:true}])for(const body of [{name:'Nuevo'},{phone:'123'},{password:'new-password-123'}])test(`PATCH shared identity blocks ${JSON.stringify(flags)} ${Object.keys(body)}`,async()=>{
  const h=harness(company(),[begin(),target([{...own,...flags}]),rollback()]);
  assert.equal((await h.invoke('patch','/api/users/:id',body)).statusCode,403);
  assert.equal(h.calls.some(c=>c.sql.startsWith('update users set')),false);assert.equal(h.released,1);
});
test('PATCH exclusive B rejected before UPDATE',async()=>{
  const h=harness(company(),[begin(),target([]),rollback()]);
  assert.equal((await h.invoke('patch','/api/users/:id',{name:'Nuevo'})).statusCode,404);
});
const view=rows=>({sql:/^select u.id,u.name,u.email,u.phone,u.active/,values:[42],rows});
const responseView=()=>({sql:/po.owner_type ownership_role/,values:[42],rows:[{id:42,company_id:99,memberships:[{id:71,company_id:10,role_code:'manager',permissions:[]}]}]});
test('PATCH private own identity works with legacy company mismatch and audits A',async()=>{
  const before={id:42,name:'Anterior',company_id:99},after={...before,name:'Nuevo',phone:'123'};
  const h=harness(company(),[begin(),target([own]),view([before]),
    {sql:/^update users set name=\$1,phone=\$2,password_hash=\$3,updated_at=now\(\) where id=\$4 returning id$/,rows:[{id:42}],check:(sql,v)=>{
      assert.deepEqual([v[0],v[1],v[3]],['Nuevo','123','42']);assert.match(v[2],/^scrypt\$/);assert.notEqual(v[2],'new-password-123');
    }},view([after]),responseView(),audit(10),commit()]);
  const res=await h.invoke('patch','/api/users/:id',{name:'Nuevo',phone:'123',password:'new-password-123',company_id:20});
  assert.equal(res.statusCode,200);assert.equal(res.payload.id,42);
  assert.equal(h.released,1);
});
for(const [name,actor,cid] of [['platform',platform,null],['legacy',legacy,10]])test(`PATCH ${name} retains global active and role mutation flow`,async()=>{
  const user={id:42,company_id:20};
  const h=harness(actor(),[begin(),{sql:/^select id from users where id=\$1 and \(\$2=true or company_id=\$3\) for update$/,values:['42',true,cid],rows:[{id:42}]},
    ...(name==='platform'?[{sql:/^select 1 from company_people where user_id=\$1 limit 1 for update$/,values:['42'],rows:[]}]:[]),view([user]),
    {sql:/^select id,code from roles/,values:[5],rows:[{id:5,code:'manager'}]},
    {sql:/^update users set role_id=\$1,active=\$2/,values:[5,false,'42',true,cid],rows:[{id:42}]},view([user]),responseView(),audit(20),commit()]);
  assert.equal((await h.invoke('patch','/api/users/:id',{role_id:5,active:false})).statusCode,200);
});
test('PATCH global platform cannot change role of registered personnel through global identity',async()=>{
  const h=harness(platform(),[begin(),{sql:/^select id from users where id=\$1/,values:['42',true,null],rows:[{id:42}]},
    {sql:/^select 1 from company_people where user_id=\$1 limit 1 for update$/,values:['42'],rows:[{'?column?':1}]},rollback()]);
  const r=await h.invoke('patch','/api/users/:id',{role_id:5});assert.equal(r.statusCode,409);assert.equal(r.payload.code,'PERSONNEL_ROUTE_REQUIRED');
  assert.equal(h.calls.some(c=>c.sql.startsWith('update users set')),false);assert.equal(h.released,1);
});
const selfCheck=userId=>({sql:/^select user_id from user_memberships where id=\$1$/,values:['42'],rows:[{user_id:userId}]});
const lockMembership=companyId=>({sql:/^select .*from user_memberships .*where um\.id=\$1 for update$/,values:['42'],rows:[{id:42,user_id:2,company_id:companyId,role_id:4,active:false,has_personnel_profile:false}]});
test('PATCH membership self guard executes before transaction',async()=>{
  const h=harness(company(),[selfCheck(1)]);assert.equal((await h.invoke('patch','/api/user-memberships/:id',{active:true})).statusCode,403);assert.equal(h.connected,0);
});
test('PATCH membership foreign company guard remains enforced',async()=>{
  const h=harness(company(),[selfCheck(2),begin(),lockMembership(20),rollback()]);assert.equal((await h.invoke('patch','/api/user-memberships/:id',{active:true})).statusCode,403);
});
test('PATCH own membership reactivates and changes company role with audit',async()=>{
  const h=harness(company(),[selfCheck(2),begin(),lockMembership(10),role(),
    {sql:/^update user_memberships set role_id=\$1,active=\$2/,values:[5,true,'42'],rows:[{id:42,company_id:10,role_id:5,active:true}]},audit(10),commit()]);
  const res=await h.invoke('patch','/api/user-memberships/:id',{role_id:5,active:true});assert.equal(res.statusCode,200);assert.equal(res.payload.active,true);
});
test('PATCH membership still refuses platform role',async()=>{
  const h=harness(company(),[selfCheck(2),begin(),lockMembership(10),role('platform_superadmin'),rollback()]);assert.equal((await h.invoke('patch','/api/user-memberships/:id',{role_id:5})).statusCode,400);
});
