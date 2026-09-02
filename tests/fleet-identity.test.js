const test=require('node:test');
const assert=require('node:assert/strict');
const {registerFleetRoutes}=require('../fleet-api');

function app(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>routes.find(r=>r.method===method&&r.path===path);return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,user,body={},query={},params={}){const req={user,body,query,params,ip:'127.0.0.1'};const res=response();let i=0;const next=async()=>{const handler=route.handlers[i++];if(handler)return handler(req,res,next)};await next();return res}
function pool(resolver){const calls=[];const client={async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values)},release(){}};return {calls,releases:0,async connect(){return client},async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values)}}}
const modern=(company,permissions=['fuel.manage'],extra={})=>({id:7,actor_type:'company',scope:'company',company_id:company,membership_id:11,platform_membership_id:null,role_code:'company_admin',permissions,...extra});
const platform={id:1,actor_type:'platform',scope:'platform',company_id:null,membership_id:null,platform_membership_id:4,role_code:'platform_superadmin',permissions:['fuel.manage','gps.read']};
const unresolved={id:2,actor_type:'unresolved',scope:null,company_id:null,membership_id:null,platform_membership_id:null,role_code:null,permissions:['fuel.manage']};
const legacy={id:3,actor_type:'legacy',scope:'company',company_id:10,membership_id:null,platform_membership_id:null,role_code:'admin',permissions:[]};

test('fleet usa la membership A aunque el company_id legacy sea B',async()=>{
  const p=pool(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,10]);return {rowCount:1,rows:[{id:3,company_id:10,patente:'A'}]}}if(sql.startsWith('insert into fuel')){assert.equal(values[0],10);return {rowCount:1,rows:[{id:1,company_id:10}]}}if(sql.startsWith('insert into audit_logs'))return {rows:[]};throw Error(sql)});
  const a=app();await registerFleetRoutes(a,p);const res=await invoke(a.route('post','/api/fleet/fuel'),modern(10,['fuel.manage'],{legacy_company_id:20}),{truck_id:3,liters:1,price_clp:1,odometer_km:1,date:'2026-01-01'});assert.equal(res.statusCode,201);assert.equal(p.calls.find(x=>x.sql.startsWith('insert into fuel')).values[0],10);
});

test('fleet funciona con membership A aunque users.company_id sea null',async()=>{
  const p=pool(async(sql,values)=>{if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,10]);return {rowCount:1,rows:[{id:3,company_id:10,patente:'A'}]}}if(sql.startsWith('insert into fuel'))return {rowCount:1,rows:[{id:1,company_id:10}]};if(sql.startsWith('insert into audit_logs'))return {rows:[]};if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};throw Error(sql)});const a=app();await registerFleetRoutes(a,p);const res=await invoke(a.route('post','/api/fleet/fuel'),modern(10,['fuel.manage'],{legacy_company_id:null}),{truck_id:3,liters:1,price_clp:1,odometer_km:1,date:'2026-01-01'});assert.equal(res.statusCode,201);
});

test('fleet rechaza memberships múltiples sin contexto',async()=>{const p={async connect(){throw Error('No debe conectar')},async query(){throw Error('No debe consultar')}};const a=app();await registerFleetRoutes(a,p);const res=await invoke(a.route('post','/api/fleet/fuel'),unresolved,{truck_id:3,liters:1,price_clp:1,odometer_km:1});assert.equal(res.statusCode,400)});

test('fleet rechaza platform sin company context',async()=>{const p={async connect(){throw Error('No debe conectar')},async query(){throw Error('No debe consultar')}};const a=app();await registerFleetRoutes(a,p);const res=await invoke(a.route('post','/api/fleet/fuel'),platform,{company_id:20,truck_id:3,liters:1,price_clp:1,odometer_km:1});assert.equal(res.statusCode,400)});

test('company moderno ignora body.company_id malicioso',async()=>{const p=pool(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,10]);return {rowCount:1,rows:[{id:3,company_id:10,patente:'A'}]}}if(sql.startsWith('insert into fuel')){assert.equal(values[0],10);return {rowCount:1,rows:[{id:1,company_id:10}]}}if(sql.startsWith('insert into audit_logs'))return {rows:[]};throw Error(sql)});const a=app();await registerFleetRoutes(a,p);const res=await invoke(a.route('post','/api/fleet/fuel'),modern(10),{company_id:20,truck_id:3,liters:1,price_clp:1,odometer_km:1});assert.equal(res.statusCode,201)});

test('truck de B bloquea fuel de actor A',async()=>{const p=pool(async(sql,values)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,10]);return {rowCount:0,rows:[]}}throw Error(sql)});const a=app();await registerFleetRoutes(a,p);const res=await invoke(a.route('post','/api/fleet/fuel'),modern(10),{truck_id:3,liters:1,price_clp:1,odometer_km:1});assert.equal(res.statusCode,404);assert.equal(p.calls.some(x=>x.sql.startsWith('insert into fuel')),false)});

test('platform y unresolved no pueden leer maintenance sin empresa',async()=>{const p={async query(){return {rowCount:0,rows:[]}},async connect(){throw Error('No debe conectar')}};const a=app();await registerFleetRoutes(a,p);for(const user of [platform,unresolved]){const res=await invoke(a.route('get','/api/fleet/maintenance'),user);assert.equal(res.statusCode,403);}}
);

test('admin moderno no activa bypass global y legacy admin conserva explicit company',async()=>{
  const modernPool=pool(async(sql,values)=>{if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,10]);return {rowCount:0,rows:[]}}if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};throw Error(sql)});const a=app();await registerFleetRoutes(a,modernPool);const denied=await invoke(a.route('post','/api/fleet/fuel'),modern(10,['fuel.manage'],{role_code:'admin'}),{company_id:20,truck_id:3,liters:1,price_clp:1,odometer_km:1});assert.equal(denied.statusCode,404);
  const legacyPool=pool(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,20]);return {rowCount:1,rows:[{id:3,company_id:20,patente:'B'}]}}if(sql.startsWith('insert into fuel'))return {rowCount:1,rows:[{id:1,company_id:20}]};if(sql.startsWith('insert into audit_logs'))return {rows:[]};throw Error(sql)});const b=app();await registerFleetRoutes(b,legacyPool);const allowed=await invoke(b.route('post','/api/fleet/fuel'),legacy,{company_id:20,truck_id:3,liters:1,price_clp:1,odometer_km:1});assert.equal(allowed.statusCode,201);
});
