const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {promisify} = require('node:util');
const {authMiddleware,registerAuthRoutes} = require('../auth');
const {registerOperationsRoutes} = require('../operations-api');
const {registerFleetRoutes} = require('../fleet-api');

function fakeApp(){
  const routes=[];
  for(const method of ['get','post','put','patch','delete']){
    routes[method]=(path,...handlers)=>routes.push({method,path,handlers});
  }
  routes.route=(method,path)=>{
    const route=routes.find(x=>x.method===method&&x.path===path);
    assert.ok(route,`Ruta no registrada: ${method.toUpperCase()} ${path}`);
    return route;
  };
  return routes;
}

function response(){
  return {
    statusCode:200,
    payload:undefined,
    status(code){this.statusCode=code;return this},
    json(value){this.payload=value;return this},
    sendStatus(code){this.statusCode=code;this.payload=undefined;return this}
  };
}

async function invoke(route,overrides={}){
  const req={
    user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage','loads.manage','gps.read','fleet.manage']},
    params:{id:'7'},body:{},query:{},
    get(){return ''},
    ...overrides
  };
  const res=response();
  let index=0;
  const next=async()=>{
    const handler=route.handlers[index++];
    if(handler)return handler(req,res,next);
  };
  await next();
  return {req,res};
}

function poolWith(handler){
  const calls=[];
  return {
    calls,
    async query(sql,values=[]){calls.push({sql,values});return handler(sql,values,calls.length)},
    async connect(){return this},
    release(){}
  };
}

function tripPool(resourceCompany=10){
  return poolWith(async(sql,values)=>{
    if(sql.includes('from trips t left join')){
      const allowed=sql.includes('company_id=$2')?Number(values[1])===resourceCompany:true;
      return allowed?{rowCount:1,rows:[{id:7,company_id:resourceCompany,trip_number:'V-7'}]}:{rowCount:0,rows:[]};
    }
    return {rowCount:0,rows:[]};
  });
}

async function passwordHash(password){
  const salt='00112233445566778899aabbccddeeff';
  const key=await promisify(crypto.scrypt)(password,salt,64,{N:16384,r:8,p:1});
  return `scrypt$${salt}$${key.toString('hex')}`;
}

function loginPool(stored,failAt=null){
  const poolCalls=[];const clientCalls=[];let releases=0;let connects=0;
  const client={
    async query(sql,values=[]){
      clientCalls.push({sql,values});
      if(failAt&&sql.startsWith(failAt))throw new Error(`${failAt} failed`);
      if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rowCount:0,rows:[]};
      if(sql.startsWith('insert into user_sessions')||sql.startsWith('update users set last_login_at'))return {rowCount:1,rows:[]};
      if(sql.includes('from users u left join roles'))return failAt==='USER_VIEW_NULL'?{rowCount:0,rows:[]}:{rowCount:1,rows:[{id:5,company_id:10,role_code:'operations',permissions:['trips.manage']}]};
      throw new Error(`Consulta transaccional inesperada: ${sql}`);
    },
    release(){releases++}
  };
  return {
    poolCalls,clientCalls,
    get releases(){return releases},get connects(){return connects},
    async query(sql,values=[]){
      poolCalls.push({sql,values});
      if(sql.startsWith('select id,password_hash from users'))return {rowCount:1,rows:[{id:5,password_hash:stored}]};
      throw new Error(`pool.query inesperado: ${sql}`);
    },
    async connect(){connects++;return client}
  };
}

async function invokeLogin(pool){
  const app=fakeApp();registerAuthRoutes(app,pool);
  return invoke(app.route('post','/api/auth/login'),{
    user:undefined,
    body:{email:'operaciones@example.test',password:'clave-segura-123'},
    ip:'127.0.0.1',
    get:name=>name==='user-agent'?'node-test':''
  });
}

test('authMiddleware rechaza una sesión inexistente',async()=>{
  const pool=poolWith(async()=>{throw new Error('No debe consultar sin token')});
  const req={get:()=>'',user:undefined};
  const res=response();
  let continued=false;
  await authMiddleware(pool,req,res,()=>{continued=true});
  assert.equal(res.statusCode,401);
  assert.equal(continued,false);
});

test('authMiddleware acepta una sesión válida y carga permisos',async()=>{
  const pool=poolWith(async(sql)=>{
    if(sql.includes('from user_sessions'))return {rowCount:1,rows:[{user_id:5}]};
    if(sql.includes('from users u'))return {rowCount:1,rows:[{id:5,company_id:10,role_code:'operations',permissions:['trips.manage']}]};
    if(sql.startsWith('update user_sessions'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const req={get:name=>name==='authorization'?'Bearer valid-token':''};
  const res=response();
  let continued=false;
  await authMiddleware(pool,req,res,()=>{continued=true});
  assert.equal(continued,true);
  assert.equal(req.user.company_id,10);
  assert.deepEqual(req.user.permissions,['trips.manage']);
});

test('login válido conserva la creación de sesión y devuelve el usuario',async()=>{
  const stored=await passwordHash('clave-segura-123');
  const pool=loginPool(stored);
  const {res}=await invokeLogin(pool);
  assert.equal(res.statusCode,200);
  assert.equal(typeof res.payload.token,'string');
  assert.equal(res.payload.user.company_id,10);
  assert.deepEqual(pool.clientCalls.map(call=>call.sql==='BEGIN'||call.sql==='COMMIT'?call.sql:call.sql.startsWith('insert into user_sessions')?'SESSION':call.sql.startsWith('update users set last_login_at')?'LAST_LOGIN':'USER_VIEW'),['BEGIN','SESSION','LAST_LOGIN','USER_VIEW','COMMIT']);
  assert.equal(pool.poolCalls.length,1);
  assert.match(pool.poolCalls[0].sql,/^select id,password_hash from users/);
  assert.equal(pool.connects,1);
  assert.equal(pool.releases,1);
});

for(const failure of [
  {name:'INSERT user_sessions',sql:'insert into user_sessions',before:['BEGIN','SESSION','ROLLBACK']},
  {name:'UPDATE last_login_at',sql:'update users set last_login_at',before:['BEGIN','SESSION','LAST_LOGIN','ROLLBACK']},
  {name:'userView',sql:'select u.id,u.name',before:['BEGIN','SESSION','LAST_LOGIN','USER_VIEW','ROLLBACK']},
  {name:'COMMIT',sql:'COMMIT',before:['BEGIN','SESSION','LAST_LOGIN','USER_VIEW','COMMIT','ROLLBACK']}
])test(`login revierte y no entrega token si falla ${failure.name}`,async()=>{
  const pool=loginPool(await passwordHash('clave-segura-123'),failure.sql);
  const {res}=await invokeLogin(pool);
  assert.equal(res.statusCode,500);
  assert.equal(res.payload.token,undefined);
  assert.deepEqual(res.payload,{error:'No se pudo iniciar sesión'});
  assert.deepEqual(pool.clientCalls.map(call=>call.sql==='BEGIN'||call.sql==='COMMIT'||call.sql==='ROLLBACK'?call.sql:call.sql.startsWith('insert into user_sessions')?'SESSION':call.sql.startsWith('update users set last_login_at')?'LAST_LOGIN':'USER_VIEW'),failure.before);
  assert.equal(pool.clientCalls.at(-1).sql,'ROLLBACK');
  assert.equal(pool.poolCalls.length,1);
  assert.equal(pool.connects,1);
  assert.equal(pool.releases,1);
});

test('login revierte y no entrega token si userView no encuentra al usuario',async()=>{
  const pool=loginPool(await passwordHash('clave-segura-123'),'USER_VIEW_NULL');
  const {res}=await invokeLogin(pool);
  assert.equal(res.statusCode,500);
  assert.deepEqual(res.payload,{error:'No se pudo iniciar sesión'});
  assert.equal(res.payload.token,undefined);
  assert.deepEqual(pool.clientCalls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:call.sql.startsWith('insert into user_sessions')?'SESSION':call.sql.startsWith('update users set last_login_at')?'LAST_LOGIN':'USER_VIEW'),['BEGIN','SESSION','LAST_LOGIN','USER_VIEW','ROLLBACK']);
  assert.equal(pool.clientCalls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.connects,1);
  assert.equal(pool.releases,1);
});

test('RBAC permite detalle de viaje con trips.manage y usa company_id en $2',async()=>{
  const app=fakeApp();const pool=tripPool(10);await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,200);
  assert.match(pool.calls[0].sql,/t\.id=\$1 and t\.company_id=\$2/);
  assert.deepEqual(pool.calls[0].values,['7',10]);
});

test('RBAC rechaza detalle de viaje sin trips.manage antes de consultar BD',async()=>{
  const app=fakeApp();const pool=tripPool(10);await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'),{user:{id:6,role_code:'viewer',company_id:10,permissions:['dashboard.read']}});
  assert.equal(res.statusCode,403);
  assert.equal(pool.calls.length,0);
});

test('company scope permite Empresa A -> viaje A',async()=>{
  const app=fakeApp();const pool=tripPool(10);await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.company_id,10);
});

test('company scope oculta viaje B a usuario de Empresa A',async()=>{
  const app=fakeApp();const pool=tripPool(20);await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,404);
});

test('administrador conserva acceso transversal sin parámetro company_id',async()=>{
  const app=fakeApp();const pool=tripPool(20);await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'),{user:{id:1,role_code:'admin',company_id:null,permissions:[]}});
  assert.equal(res.statusCode,200);
  assert.match(pool.calls[0].sql,/t\.id=\$1 and true/);
  assert.deepEqual(pool.calls[0].values,['7']);
});

test('lookups operacionales con ID reservan $1 y company_id usa $2',async()=>{
  const cases=[
    ['patch','/api/operations/trips/:id/assign',{body:{truck_id:1},permission:'trips.manage'}],
    ['post','/api/operations/trips/:id/events',{body:{event_type:'Control'},permission:'trips.manage'}],
    ['post','/api/operations/trips/:id/checklist',{body:{truck_id:1},permission:'trips.manage'}],
    ['post','/api/operations/trips/:id/loads',{body:{cargo:'Carga'},permission:'loads.manage'}]
  ];
  for(const [method,path,config] of cases){
    const app=fakeApp();
    const pool=poolWith(async(sql)=>sql.includes('from trips t')?{rowCount:0,rows:[]}:{rowCount:0,rows:[]});
    await registerOperationsRoutes(app,pool);
    const user={id:5,role_code:'operations',company_id:10,permissions:[config.permission]};
    const {res}=await invoke(app.route(method,path),{body:config.body,user});
    assert.equal(res.statusCode,404,path);
    const lookup=pool.calls.find(call=>call.sql.includes('from trips t'));
    assert.match(lookup.sql,/\bid=\$1 and t\.company_id=\$2/,path);
    assert.deepEqual(lookup.values,['7',10],path);
  }
});

test('posiciones y track de camión usan $2 para company_id',async()=>{
  for(const path of ['/api/fleet/trucks/:id/positions','/api/fleet/trucks/:id/track']){
    const app=fakeApp();const pool=poolWith(async()=>({rowCount:0,rows:[]}));await registerFleetRoutes(app,pool);
    const {res}=await invoke(app.route('get',path));
    assert.equal(res.statusCode,200,path);
    assert.match(pool.calls[0].sql,/te\.truck_id=\$1 and t\.company_id=\$2/,path);
    assert.deepEqual(pool.calls[0].values,[7,10],path);
  }
});

test('resolución de alerta aplica RBAC y company_id en $2',async()=>{
  const app=fakeApp();
  const pool=poolWith(async(sql,values)=>Number(values[1])===10?{rowCount:1,rows:[{id:7,company_id:10,resolved:true}]}:{rowCount:0,rows:[]});
  await registerFleetRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/fleet/alerts/:id/resolve'));
  assert.equal(res.statusCode,200);
  assert.match(pool.calls[0].sql,/id=\$1 and a\.company_id=\$2/);
  assert.deepEqual(pool.calls[0].values,['7',10]);
});

test('resolución de alerta de otra empresa devuelve 404',async()=>{
  const app=fakeApp();const pool=poolWith(async()=>({rowCount:0,rows:[]}));await registerFleetRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/fleet/alerts/:id/resolve'));
  assert.equal(res.statusCode,404);
});
