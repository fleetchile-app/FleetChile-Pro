const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {registerAuthRoutes,userView}=require('../auth');

const companyActor={id:1,company_id:10,role_code:'company_admin',memberships:[{id:1,company_id:10,role_code:'company_admin',permissions:['company.users.manage']}],personnel_state:{company_id:10,policy:{enforced:false,time_zone:'America/Santiago'},regularization_eligible:true,person:null,membership:{active:true,role_code:'company_admin'},account_active:true,contracts:[],conditions:[],licenses:[]}};
const target={id:42,name:'Cuenta conductor',email:'conductor@example.test',company_id:10,driver_id:null,role_code:'driver',memberships:[{id:2,company_id:10,role_code:'driver',permissions:[]}]};
function poolFor(options={}){
  const calls=[];
  const user={...target,...options.target};
  const rawActor=options.actor||companyActor;
  const actor=rawActor.scope==='platform'||rawActor.platform_memberships?.length||rawActor.personnel_state?rawActor:{...rawActor,personnel_state:{company_id:rawActor.company_id,policy:{enforced:false,time_zone:'America/Santiago'},regularization_eligible:true,person:null,membership:{active:true,role_code:rawActor.role_code||null},account_active:true,contracts:[],conditions:[],licenses:[]}};
  let releases=0;
  const db={async query(sql,values=[]){
    calls.push({sql,values});
    if(options.fail&&sql.startsWith(options.fail))throw Object.assign(new Error('Fallo simulado'),{code:options.code});
    let rows=[];
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows,rowCount:0};
    if(sql.includes('from user_sessions'))rows=[{user_id:1}];
    else if(sql.startsWith('update user_sessions'))rows=[];
    else if(sql.startsWith('select u.id from users u')){
      if(!options.missing&&(values[1]||String(user.company_id)===String(values[2])||user.memberships?.some(m=>String(m.company_id)===String(values[2]))))rows=[{id:42}];
    }else if(sql.startsWith('select u.id,u.name,u.email,u.phone,u.company_id,u.driver_id'))rows=[values[0]===1?actor:user];
    else if(sql.startsWith('select d.id,d.name'))rows=[{id:8,name:'Ficha conductor',rut:'RUT prueba',status:'Activo'}];
    else if(sql.startsWith('select id,name,company_id,status from drivers')){
      if(!options.foreignDriver)rows=[{id:8,name:'Ficha conductor',company_id:10,status:options.inactive?'Inactivo':'Activo'}];
    }else if(sql.startsWith('select id from users where driver_id'))rows=options.occupied?[{id:99}]:[];
    else if(sql.startsWith('update users set driver_id')){user.driver_id=values[0];rows=[{id:42}];}
    else if(sql.startsWith('insert into audit_logs'))rows=[];
    else throw new Error('SQL inesperado: '+sql);
    return {rows,rowCount:rows.length};
  },release(){releases++}};
  return {calls,get releases(){return releases},async connect(){if(options.connectFailure)throw Error('Sin conexión');return db},query:db.query};
}
function setup(options={}){
  const routes=[];
  const app={};
  for(const method of ['get','post','patch','put','delete'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
  const pool=poolFor(options);
  registerAuthRoutes(app,pool);
  return {pool,route:method=>routes.find(route=>route.path==='/api/users/:id/driver-assignment'&&route.method===method)};
}
async function invoke(route,{body={driver_id:8},actor=companyActor,full=false,token=true}={}){
  const req={params:{id:'42'},body,user:actor.id===1&&actor===companyActor?{id:1,actor_type:'company',scope:'company',company_id:10,membership_id:1,role_code:'company_admin',permissions:['company.users.manage'],personnel_state:companyActor.personnel_state}:actor,ip:'127.0.0.1',get:key=>key==='authorization'&&token?'Bearer test-token':''};
  const res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this},sendStatus(code){this.statusCode=code;return this}};
  for(const handler of full?route.handlers:[route.handlers.at(-1)]){
    let next=false;
    await handler(req,res,()=>{next=true});
    if(!next)break;
  }
  return res;
}

test('asociación registra usuario y conductor de la misma empresa con auditoría antes de COMMIT',async()=>{
  const {pool,route}=setup();
  const res=await invoke(route('patch'));
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.user.driver_id,8);
  const update=pool.calls.find(call=>call.sql.startsWith('update users set driver_id'));
  assert.deepEqual(update.values,[8,42]);
  const audit=pool.calls.find(call=>call.sql.startsWith('insert into audit_logs'));
  assert.deepEqual(audit.values.slice(0,5),[10,1,'driver_assignment','user','42']);
  assert.equal(audit.values[5].driver_id,null);
  assert.equal(audit.values[6].driver_id,8);
  assert.equal(JSON.stringify(res.payload).includes('password'),false);
  assert.equal(pool.calls.at(-1).sql,'COMMIT');
  assert.equal(pool.releases,1);
  // La próxima lectura de sesión ya proyecta la asociación guardada.
  assert.equal((await userView(pool,42)).driver_id,8);
});

test('consulta ofrece fichas disponibles de la empresa y excluye asociaciones ajenas en SQL',async()=>{
  const {pool,route}=setup();
  const res=await invoke(route('get'));
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.user.id,42);
  const query=pool.calls.find(call=>call.sql.startsWith('select d.id,d.name'));
  assert.match(query.sql,/d.company_id=\$1/);
  assert.match(query.sql,/not exists\(select 1 from users u where u.driver_id=d.id and u.id<>\$3\)/);
  assert.deepEqual(query.values,[10,null,42]);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update users')),false);
});

for(const method of ['get','patch']){
  test(`${method} asociación exige autenticación y permiso existente de gestión de usuarios`,async()=>{
    const noAuth=setup();
    assert.equal((await invoke(noAuth.route(method),{full:true,token:false})).statusCode,401);
    const denied=setup({actor:{id:1,company_id:10,role_code:'viewer',memberships:[{id:1,company_id:10,role_code:'viewer',permissions:[]}]}});
    assert.equal((await invoke(denied.route(method),{full:true})).statusCode,403);
    assert.equal(denied.pool.calls.some(call=>call.sql==='BEGIN'),false);
    const allowed=setup();
    assert.equal((await invoke(allowed.route(method),{full:true})).statusCode,200);
  });
}

for(const [name,options,status] of [
  ['usuario inexistente',{missing:true},404],
  ['usuario de otra empresa',{target:{company_id:20,memberships:[{company_id:20,role_code:'driver'}]}},404],
  ['conductor de otra empresa',{foreignDriver:true},404],
  ['conductor inactivo',{inactive:true},409],
  ['conductor ya ocupado',{occupied:true},409],
  ['usuario ya vinculado a otra ficha',{target:{driver_id:9}},409],
  ['usuario sin rol conductor',{target:{memberships:[{company_id:10,role_code:'viewer'}]}},409],
  ['usuario de múltiples memberships',{target:{memberships:[{company_id:10,role_code:'driver'},{company_id:20,role_code:'driver'}]}},404],
  ['usuario de plataforma',{target:{platform_memberships:[{id:3,role_code:'platform_superadmin',permissions:[]}]}},404],
  ['empresa original inconsistente',{target:{company_id:20}},409]
])test(`asociación rechaza ${name}`,async()=>{
  const {pool,route}=setup(options);
  const res=await invoke(route('patch'));
  assert.equal(res.statusCode,status);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update users set driver_id')),false);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  assert.equal(pool.releases,1);
});

test('plataforma global puede asociar y plataforma contextualizada conserva el aislamiento',async()=>{
  const platform={id:1,actor_type:'platform',scope:'platform',platform_membership_id:1,role_code:'platform_superadmin',permissions:['platform.users.manage']};
  const global=setup();
  assert.equal((await invoke(global.route('patch'),{actor:platform})).statusCode,200);
  const scoped=setup();
  assert.equal((await invoke(scoped.route('patch'),{actor:{...platform,active_company_context:20}})).statusCode,404);
});

test('repetir la misma asociación no duplica auditoría ni actualiza de nuevo',async()=>{
  const {pool,route}=setup({target:{driver_id:8}});
  assert.equal((await invoke(route('patch'))).statusCode,200);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update users set driver_id')),false);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
});

for(const value of [null,0,-1,1.2,'8',{},undefined])test(`driver_id inválido: ${String(value)}`,async()=>{
  const {pool,route}=setup();
  assert.equal((await invoke(route('patch'),{body:{driver_id:value}})).statusCode,400);
  assert.equal(pool.calls.length,0);
});

for(const fail of ['update users set driver_id','insert into audit_logs'])test(`asociación revierte si falla ${fail}`,async()=>{
  const {pool,route}=setup({fail});
  assert.equal((await invoke(route('patch'))).statusCode,500);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.releases,1);
});

test('conflicto concurrente de unicidad devuelve 409 y revierte',async()=>{
  const {pool,route}=setup({fail:'update users set driver_id',code:'23505'});
  assert.equal((await invoke(route('patch'))).statusCode,409);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('fallo de conexión se controla sin intentar liberar una conexión inexistente',async()=>{
  const {pool,route}=setup({connectFailure:true});
  assert.equal((await invoke(route('patch'))).statusCode,500);
  assert.equal(pool.releases,0);
});

for(const [name,original,effective,actorCompany] of [
  ['BIGINT como texto y JSON como número','10',10,10],
  ['JSON como texto y BIGINT como número',10,'10',10],
  ['contexto empresarial como texto','10',10,'10']
]){
  for(const method of ['get','patch'])test(`${method} asociación acepta la misma empresa con ${name}`,async()=>{
    const {types}=require('pg');
    const raw=typeof original==='string'?types.getTypeParser(20)(original):original;
    const membership=types.getTypeParser(114)(JSON.stringify({company_id:effective}));
    const {pool,route}=setup({target:{company_id:raw,memberships:[{id:2,company_id:membership.company_id,role_code:'driver',permissions:[]}]}});
    const actor={id:1,actor_type:'company',scope:'company',company_id:actorCompany,membership_id:1,role_code:'company_admin',permissions:['company.users.manage']};
    const result=await invoke(route(method),{actor});
    assert.equal(result.statusCode,200);
    assert.equal(String(result.payload.user.company_id),'10');
    assert.equal(pool.calls.at(-1).sql,'COMMIT');
  });
}

test('empresa original diferente sigue bloqueada con BIGINT real como texto',async()=>{
  const {pool,route}=setup({target:{company_id:'20',memberships:[{id:2,company_id:10,role_code:'driver'}]}});
  assert.equal((await invoke(route('patch'))).statusCode,409);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update users set driver_id')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('identificador numérico no seguro no se equipara a un BIGINT exacto',async()=>{
  const {pool,route}=setup({target:{company_id:'9007199254740993',memberships:[{id:2,company_id:9007199254740992,role_code:'driver'}]}});
  const actor={id:1,actor_type:'platform',scope:'platform',platform_membership_id:1,role_code:'platform_superadmin',permissions:['platform.users.manage']};
  assert.equal((await invoke(route('patch'),{actor})).statusCode,409);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update users set driver_id')),false);
});

test('diálogo de asociación conserva ficha existente y refresca Personas sin reingresar sus datos',async()=>{
  const elements={};
  const requests=[];
  const alerts=[];
  function element(){return {innerHTML:'',dataset:{},setAttribute(){},appendChild(){},classList:{add(){},remove(){}}}}
  const document={getElementById:id=>elements[id]||(elements[id]=element()),createElement:element,querySelectorAll:()=>[]};
  const context={document,alert:message=>alerts.push(message),close(){},FormData:class{constructor(form){return form.data}},fetch:async(url,options={})=>{
    requests.push({url,options});
    let data={};
    if(url==='/api/users/42/driver-assignment')data=options.method?{user:{driver_id:8}}:{user:{id:42,name:'Cuenta & conductor',email:'conductor@example.test',driver_id:null},drivers:[{id:8,name:'Ficha existente',rut:'RUT prueba'}]};
    else if(url==='/api/users')data=[{id:42,name:'Cuenta conductor',modern_role_code:'driver',driver_id:8}];
    else if(url==='/api/company-roles')data=[];
    return {ok:true,json:async()=>data};
  }};
  context.window=context;
  context.adminSurface='company';
  let personnelRefreshes=0;
  context.renderCompanyPeople=async()=>{personnelRefreshes++;};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/admin.js'),'utf8'),context);
  await context.associateUserDriver(42);
  assert.match(elements.form.innerHTML,/Ficha existente/);
  assert.match(elements.form.innerHTML,/Cuenta &amp; conductor/);
  assert.doesNotMatch(elements.form.innerHTML,/name="password"|name="name"|name="rut"/);
  elements.form.data=[['driver_id','8']];
  await elements.form.onsubmit({preventDefault(){},target:elements.form});
  const save=requests.find(request=>request.options.method==='PATCH');
  assert.equal(save.url,'/api/users/42/driver-assignment');
  assert.deepEqual(JSON.parse(save.options.body),{driver_id:8});
  assert.equal(personnelRefreshes,1);
  assert.equal(alerts.length,1);
  assert.match(alerts[0],/Conductor asociado/);
});
