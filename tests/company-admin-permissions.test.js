const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {userView,resolveEffectiveMembership,resolveActorContext,requirePermission,
  requireScopedPermission,requirePlatformPermission,authMiddleware,isPlatformOwner,
  registerAuthRoutes}=require('../auth');
const {registerCoreRoutes}=require('../core-api');
const {registerFleetRoutes}=require('../fleet-api');
const {registerAdminRoutes}=require('../admin-api');

// Contract tests with simulated PostgreSQL results, not migration execution or DB integration.
const migration=fs.readFileSync(path.join(__dirname,'../migrations/029_company_admin_permissions.sql'),'utf8');
const sql=migration.replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
const list=sql.match(/\bp\.code\s+IN\s*\(([^)]+)\)/i);
assert.ok(list,'029 debe declarar una lista IN explícita de permisos');
const permissionCodes=[...list[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
const expectedCodes=[
  'company.users.manage','audit.read','dashboard.read','fleet.manage','drivers.manage',
  'clients.manage','trips.manage','loads.manage','gps.read','maintenance.manage',
  'fuel.manage','documents.manage','reports.read','economics.read','economics.manage',
  'economics.approve','economics.close','economics.export'
];

function result(rows=[]){return {rows,rowCount:rows.length};}
function rawIdentity({companyId=10,legacyCompany=20,legacyRole='admin',codes=permissionCodes}={}){
  return {id:71,name:'Administrador de empresa',company_id:legacyCompany,
    role_code:legacyRole,role_name:'Administrador legacy',legacy_permissions:['platform.users.manage'],
    memberships:[{id:701,company_id:companyId,role_code:'company_admin',active:true,permissions:[...codes]}],
    platform_memberships:[],ownership_role:null,ownership_active:false,
    personnel_state:{company_id:companyId,policy:{enforced:false,time_zone:'America/Santiago'},regularization_eligible:true,person:null,
      membership:{active:true,role_code:'company_admin'},account_active:true,contracts:[],conditions:[],licenses:[]}};
}
function identityPool(raw=rawIdentity()){
  const calls=[];
  return {calls,async query(statement,values=[]){
    calls.push({sql:statement,values});
    assert.match(statement,/from users u/);
    assert.match(statement,/p\.scope='company'/);
    assert.deepEqual(values,[raw.id]);
    return result([structuredClone(raw)]);
  }};
}
async function actor(options){const pool=identityPool(rawIdentity(options));return userView(pool,71);}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this;},
  json(value){this.payload=value;return this;},sendStatus(code){this.statusCode=code;return this;}};}
function app(){
  const routes=[];
  for(const method of ['get','post','put','patch','delete'])routes[method]=(route,...handlers)=>routes.push({method,path:route,handlers});
  routes.route=(method,route)=>{const found=routes.find(item=>item.method===method&&item.path===route);
    assert.ok(found,`Ruta real no registrada: ${method} ${route}`);return found;};
  return routes;
}
async function invoke(route,user,overrides={}){
  const req={user,path:route.path,params:{},query:{},body:{},ip:'127.0.0.1',get(){return '';},...overrides};
  const res=response();
  // Await every real middleware, including authMiddleware's non-awaited next().
  for(const handler of route.handlers){let advanced=false;await handler(req,res,()=>{advanced=true;});if(!advanced)break;}
  return res;
}
async function guard(middleware,user){let allowed=false;const res=response();
  await middleware({user},res,()=>{allowed=true;});return {allowed,res};}

test('029 contiene exactamente los 18 permisos previstos, sin comodines ni permisos de plataforma',()=>{
  assert.equal(permissionCodes.length,18);assert.equal(new Set(permissionCodes).size,18);
  assert.deepEqual([...permissionCodes].sort(),[...expectedCodes].sort());
  assert.doesNotMatch(list[1].replace(/'[^']*'/g,''),/[^\s,]/);
  assert.ok(permissionCodes.every(code=>!code.startsWith('platform.')&&code!=='users.manage'));
});

test('029 limita el INSERT a company_admin y permissions.scope company',()=>{
  assert.match(sql,/INSERT\s+INTO\s+role_permissions\s*\(\s*role_id\s*,\s*permission_id\s*\)/i);
  assert.match(sql,/SELECT\s+r\.id\s*,\s*p\.id\s+FROM\s+roles\s+r\s+JOIN\s+permissions\s+p\s+ON\s+p\.scope\s*=\s*'company'\s+AND\s+p\.code\s+IN/i);
  assert.match(sql,/\)\s*WHERE\s+r\.code\s*=\s*'company_admin'\s+ON\s+CONFLICT/i);
  assert.doesNotMatch(sql,/\bOR\b|\bLIKE\b|\bUNION\b|\bplatform[._]|'users\.manage'/i);
});

test('029 es aditiva e idempotente por estructura, sin modificar identidades ni 022',()=>{
  const statements=sql.split(';').map(value=>value.trim()).filter(Boolean);
  assert.equal(statements.length,3);assert.match(statements[0],/^BEGIN$/i);assert.match(statements[2],/^COMMIT$/i);
  assert.match(statements[1],/^INSERT\s+INTO\s+role_permissions\b/i);
  assert.match(statements[1],/ON\s+CONFLICT\s+DO\s+NOTHING\s*$/i);
  assert.doesNotMatch(sql,/\b(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b|022_|\\i\b/i);
  assert.equal((sql.match(/\bINSERT\b/gi)||[]).length,1);
});

test('userView y resolveEffectiveMembership proyectan los permisos extraídos sin herencia legacy',async()=>{
  const raw=rawIdentity(),pool=identityPool(raw),effective=resolveEffectiveMembership(raw),user=await userView(pool,raw.id);
  assert.equal(pool.calls.length,1);
  assert.equal(effective.actor_type,'company');assert.equal(effective.scope,'company');assert.equal(effective.company_id,10);
  assert.equal(effective.role,'company_admin');assert.deepEqual(effective.permissions,permissionCodes);
  assert.equal(user.actor_type,'company');assert.equal(user.role_code,'company_admin');assert.equal(user.company_id,10);
  assert.equal(user.legacy_company_id,20);assert.equal(user.legacy_role_code,'admin');
  assert.equal(user.membership_id,701);assert.equal(user.platform_membership_id,null);
  assert.deepEqual(user.permissions,permissionCodes);assert.equal(isPlatformOwner(user),false);
  assert.equal(resolveActorContext({user}).company_id,10);
});

test('membership moderna funciona aunque users.company_id sea null',async()=>{
  const user=await actor({legacyCompany:null});assert.equal(user.company_id,10);
  assert.equal(user.legacy_company_id,null);assert.deepEqual(user.permissions,permissionCodes);
});

for(const code of expectedCodes)test(`guards reales permiten ${code} y lo rechazan al retirarlo de la membership`,async()=>{
  const user=await actor();
  for(const middleware of [requirePermission(code),requireScopedPermission(code,'company')]){
    const checked=await guard(middleware,user);assert.equal(checked.allowed,true);assert.equal(checked.res.statusCode,200);
  }
  const denied=await actor({codes:permissionCodes.filter(value=>value!==code)});
  for(const middleware of [requirePermission(code),requireScopedPermission(code,'company')]){
    const checked=await guard(middleware,denied);assert.equal(checked.allowed,false);assert.equal(checked.res.statusCode,403);
    assert.match(checked.res.payload.error,new RegExp(code.replaceAll('.','\\.')));
  }
});

test('role_code admin no activa bypass legacy cuando existe membership empresarial',async()=>{
  const user={...await actor({codes:[]}),role_code:'admin'};
  for(const middleware of [requirePermission('dashboard.read'),requirePermission('users.manage'),
    requirePlatformPermission('platform.users.manage'),requireScopedPermission('platform.users.manage','platform')]){
    const checked=await guard(middleware,user);assert.equal(checked.allowed,false);assert.equal(checked.res.statusCode,403);
  }
});

const companyRows={
  companies:[{id:10,company_id:10},{id:20,company_id:20}],
  users:[{id:71,company_id:10},{id:81,company_id:20},{id:82,company_id:20}],
  clients:[{id:101,company_id:10},{id:201,company_id:20}],
  trucks:[{id:103,company_id:10,patente:'A'},{id:203,company_id:20,patente:'B'}],
  drivers:[{id:104,company_id:10},{id:204,company_id:20}],
  trips:[{id:107,company_id:10,status:'Planificado'},{id:207,company_id:20,status:'Planificado'}],
  vehicle_documents:[{id:105,company_id:10},{id:205,company_id:20}],
  driver_documents:[{id:106,company_id:10},{id:206,company_id:20}]
};
function scopedPool(){
  const calls=[],violations=[];let releases=0;
  const db={async query(statement,values=[]){
    calls.push({sql:statement,values});
    try{
      if(statement==='BEGIN'||statement==='ROLLBACK')return result();
      assert.match(statement,/^select\b/i,'No se permiten escrituras en estas pruebas de aislamiento');
      const table=statement.match(/\bfrom\s+(companies|users|clients|trucks|drivers|trips|vehicle_documents|driver_documents)\b/i)?.[1];
      assert.ok(table,`Consulta inesperada: ${statement}`);
      const byId=/\bwhere\s+id=\$1\s+and\s+company_id=\$2/i.test(statement);
      if(byId){
        assert.equal(values.length,2);assert.equal(values[1],10);
        return result(companyRows[table].filter(row=>String(row.id)===String(values[0])&&row.company_id===values[1]));
      }
      assert.deepEqual(values,[10]);
      assert.match(statement,table==='companies'?/\bwhere\s+id=\$1\b/i:/\b(?:[a-z]+\.)?company_id=\$1\b/i);
      const rows=companyRows[table].filter(row=>row.company_id===values[0]);
      return /select count\(\*\)/i.test(statement)?result([{n:rows.length}]):result(rows);
    }catch(error){violations.push(error.message);throw error;}
  },release(){releases++;}};
  return {calls,violations,get releases(){return releases;},query:db.query,async connect(){return db;}};
}
function assertNoWrites(pool){assert.deepEqual(pool.violations,[]);
  assert.equal(pool.calls.some(call=>/^\s*(?:insert|update|delete|commit)\b/i.test(call.sql)),false);}

test('GET core/summary usa empresa A efectiva e ignora query/body company B',async()=>{
  const pool=scopedPool(),routes=app();registerCoreRoutes(routes,pool);
  const res=await invoke(routes.route('get','/api/core/summary'),await actor(),{query:{company_id:20},body:{company_id:20}});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,{companies:1,users:1,clients:1,active_trips:1,vehicle_documents_due:1,driver_documents_due:1});
  assert.equal(pool.calls.length,6);assertNoWrites(pool);
});

for(const route of ['/api/trips','/api/clients','/api/routes/resources','/api/documents/options']){
  test(`GET ${route} permite recursos A y oculta B pese a company_id manipulado`,async()=>{
    const pool=scopedPool(),routes=app();registerCoreRoutes(routes,pool);
    const res=await invoke(routes.route('get',route),await actor(),{query:{company_id:20},body:{company_id:20}});
    assert.equal(res.statusCode,200);
    const rows=Array.isArray(res.payload)?res.payload:Object.values(res.payload).flat();
    assert.ok(rows.length>0);assert.ok(rows.every(row=>row.company_id===10));assert.ok(pool.calls.length>0);assertNoWrites(pool);
  });
}

test('GET fleet/live permite catálogo de flota A y oculta B sin bypass legacy',async()=>{
  const pool=scopedPool(),routes=app();await registerFleetRoutes(routes,pool);
  const res=await invoke(routes.route('get','/api/fleet/live'),await actor(),{query:{company_id:20}});
  assert.equal(res.statusCode,200);assert.deepEqual(res.payload,companyRows.trucks.filter(row=>row.company_id===10));
  assert.equal(pool.calls.length,1);assertNoWrites(pool);
});

for(const [route,body] of [
  ['/api/trips/:id/status',{status:'En tránsito',company_id:20}],
  ['/api/fleet/fuel',{truck_id:203,company_id:20,liters:1,price_clp:1,odometer_km:1,date:'2026-10-21'}]
])test(`${route} rechaza recurso B sin escritura ni auditoría`,async()=>{
  const pool=scopedPool(),routes=app();registerCoreRoutes(routes,pool);await registerFleetRoutes(routes,pool);
  const res=await invoke(routes.route(route.includes('/status')?'patch':'post',route),await actor(),{params:{id:'207'},body});
  assert.equal(res.statusCode,404);assertNoWrites(pool);assert.equal(pool.releases,1);
  assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:'SELECT'),['BEGIN','SELECT','ROLLBACK']);
});

function authenticatedPool(){
  const raw=rawIdentity(),projection=identityPool(raw),calls=[];
  const digest=crypto.createHash('sha256').update('company-admin-test-token').digest('hex');
  return {calls,async query(statement,values=[]){
    calls.push({sql:statement,values});
    if(statement.includes('from user_sessions')){assert.deepEqual(values,[digest]);return result([{user_id:raw.id}]);}
    if(statement.startsWith('update user_sessions set last_seen_at')){assert.deepEqual(values,[digest]);return result();}
    return projection.query(statement,values);
  },async connect(){assert.fail('No debe abrir transacciones');}};
}
const authHeaders=context=>name=>name.toLowerCase()==='authorization'?'Bearer company-admin-test-token':name.toLowerCase()==='x-company-context'?context||'':'';

test('authMiddleware autentica COMPANY en A sin convertir su empresa legacy B en contexto',async()=>{
  const pool=authenticatedPool(),req={get:authHeaders()},res=response();let allowed=false;
  await authMiddleware(pool,req,res,()=>{allowed=true;});assert.equal(allowed,true);
  assert.equal(req.user.actor_type,'company');assert.equal(req.user.company_id,10);
  assert.deepEqual(req.user.permissions,permissionCodes);
  assert.equal(pool.calls.filter(call=>call.sql.startsWith('update user_sessions')).length,1);
});

test('authMiddleware rechaza X-Company-Context B para COMPANY antes de consultar B',async()=>{
  const pool=authenticatedPool(),res=response();let allowed=false;
  await authMiddleware(pool,{get:authHeaders('20')},res,()=>{allowed=true;});
  assert.equal(allowed,false);assert.equal(res.statusCode,403);assert.match(res.payload.error,/solo.*plataforma/i);
  assert.equal(pool.calls.some(call=>/\bfrom companies\b/.test(call.sql)),false);
  assert.equal(pool.calls.some(call=>/^(?:insert|delete)\b/i.test(call.sql)),false);
});

for(const [method,route,body] of [
  ['get','/api/companies',{}],['get','/api/admin/platform-summary',{}],
  ['get','/api/admin/settings',{}],['get','/api/admin/permissions',{}],
  ['get','/api/admin/audit',{}],['put','/api/admin/roles/:id/permissions',{permission_ids:[]}],
  ['get','/api/admin/owners',{}],['post','/api/admin/owners',{user_id:71,owner_type:'primary',slot:1}],
  ['patch','/api/admin/owners/:slot',{active:true}],['delete','/api/admin/owners/:slot',{}]
])test(`COMPANY recibe 403 en ${method.toUpperCase()} ${route} sin consultar ni mutar plataforma`,async()=>{
  const calls=[],pool={async query(...args){calls.push(args);assert.fail('Plataforma no debe consultar DB');},
    async connect(){calls.push(['connect']);assert.fail('Plataforma no debe abrir transacción');}};
  const routes=app();registerCoreRoutes(routes,pool);registerAdminRoutes(routes,pool);
  const user=await actor();assert.equal(isPlatformOwner(user),false);
  const res=await invoke(routes.route(method,route),user,{params:{id:'1',slot:'1'},body});
  assert.equal(res.statusCode,403);assert.deepEqual(calls,[]);
});

for(const route of ['/api/platform-roles','/api/platform-memberships','/api/users/:id/platform-membership','/api/auth/company-context']){
  test(`ruta autenticada ${route} niega plataforma a company_admin con los 18 permisos`,async()=>{
    const pool=authenticatedPool(),routes=app();registerAuthRoutes(routes,pool);
    const method=route==='/api/auth/company-context'?'post':'get';
    const res=await invoke(routes.route(method,route),undefined,{get:authHeaders(),params:{id:'71'},body:{company_id:20}});
    assert.equal(res.statusCode,403);
    assert.equal(pool.calls.length,3); // session lookup, real userView, session last_seen only
    assert.equal(pool.calls.some(call=>/from roles|from platform_memberships|from companies/.test(call.sql)&&!call.sql.includes('from users u')),false);
  });
}
