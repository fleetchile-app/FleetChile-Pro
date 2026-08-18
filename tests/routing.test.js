const test=require('node:test');
const assert=require('node:assert/strict');
const {registerRoutingRoutes}=require('../routing-api');
const {RoutingError,createOsrmRouter}=require('../routing');

function fakeApp(){
  const routes=[];
  routes.post=(path,...handlers)=>routes.push({path,handlers});
  routes.route=path=>{const route=routes.find(item=>item.path===path);assert.ok(route,`Ruta no registrada: POST ${path}`);return route};
  return routes;
}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,overrides={}){const req={user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage']},body:{origin_location_id:11,destination_location_id:12},ip:'127.0.0.1',...overrides};const res=response();let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};await next();return {req,res}}
function poolWith({lookup,transaction}){const calls=[];const client={async query(sql,values=[]){calls.push({sql,values,client:true});return transaction(sql,values,calls)},release(){calls.push({sql:'RELEASE',values:[],client:true})}};return {calls,async query(sql,values=[]){calls.push({sql,values,client:false});return lookup(sql,values,calls)},async connect(){return client}}}

const origin={id:11,company_id:10,name:'Concepción',lat:'-36.827',lng:'-73.05'};
const destination={id:12,company_id:10,name:'Santiago',lat:'-33.4489',lng:'-70.6693'};
const calculated={distance_meters:500250.4,duration_seconds:19800.5,geometry:{type:'LineString',coordinates:[[-73.05,-36.827],[-70.6693,-33.4489]]},provider:'osrm',calculated_at:'2026-08-18T18:00:00.000Z'};

test('adaptador OSRM calcula distancia vial, duración y geometría normalizadas',async()=>{
  let requested;
  const router=createOsrmRouter({now:()=>new Date('2026-08-18T18:00:00Z'),fetchImpl:async(url,options)=>{requested={url,options};return {ok:true,async json(){return {code:'Ok',routes:[{distance:500250.4,duration:19800.5,geometry:calculated.geometry}]}}}}});
  assert.deepEqual(await router.route(origin,destination),calculated);
  assert.match(requested.url.pathname,/\/route\/v1\/driving\/-73\.05,-36\.827;-70\.6693,-33\.4489$/);
  assert.equal(requested.url.searchParams.get('geometries'),'geojson');
  assert.equal(requested.url.searchParams.get('overview'),'full');
});

test('ruta válida autoriza ubicaciones, persiste snapshot y audita antes de COMMIT',async()=>{
  const saved={id:81,company_id:10,origin_location_id:11,destination_location_id:12,...calculated};
  const pool=poolWith({lookup:async(sql,values)=>{assert.match(sql,/where id=\$1 and company_id=\$2$/);assert.equal(values[1],10);return {rowCount:1,rows:[values[0]===11?origin:destination]}},transaction:async(sql)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith('insert into road_routes'))return {rowCount:1,rows:[saved]};if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};throw new Error(`Consulta inesperada: ${sql}`)}});
  const adapter={async route(from,to){assert.deepEqual(from,origin);assert.deepEqual(to,destination);return calculated}};
  const app=fakeApp();registerRoutingRoutes(app,pool,adapter);
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,201);assert.deepEqual(res.payload,saved);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into road_routes'));
  assert.deepEqual(insert.values,[10,11,12,500250.4,19800.5,calculated.geometry,'osrm','2026-08-18T18:00:00.000Z']);
  const audit=pool.calls.find(call=>call.sql.startsWith('insert into audit_logs'));
  assert.deepEqual(audit.values,[10,5,'create','road_route','81',null,saved,'127.0.0.1']);
  assert.ok(pool.calls.indexOf(insert)<pool.calls.indexOf(audit));assert.ok(pool.calls.indexOf(audit)<pool.calls.findIndex(call=>call.sql==='COMMIT'));
});

test('origen inexistente o cross-company se oculta antes de consultar destino o proveedor',async()=>{
  let providerCalls=0;
  const pool=poolWith({lookup:async()=>({rowCount:0,rows:[]}),transaction:async()=>{throw new Error('No debe abrir transacción')}});
  const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){providerCalls++;return calculated}});
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,404);assert.equal(res.payload.error,'Ubicación de origen no encontrada');assert.equal(pool.calls.length,1);assert.equal(providerCalls,0);
  assert.deepEqual(pool.calls[0].values,[11,10]);
});

test('destino inexistente o cross-company se oculta antes de llamar al proveedor',async()=>{
  let providerCalls=0,lookups=0;
  const pool=poolWith({lookup:async()=>{lookups++;return lookups===1?{rowCount:1,rows:[origin]}:{rowCount:0,rows:[]}},transaction:async()=>{throw new Error('No debe abrir transacción')}});
  const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){providerCalls++;return calculated}});
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,404);assert.equal(res.payload.error,'Ubicación de destino no encontrada');assert.equal(lookups,2);assert.equal(providerCalls,0);
  assert.deepEqual(pool.calls[1].values,[12,10]);
});

test('ubicaciones sin coordenadas válidas se rechazan antes del proveedor',async()=>{
  for(const invalidSide of ['origin','destination']){
    let providerCalls=0,lookups=0;
    const pool=poolWith({lookup:async()=>{lookups++;if(invalidSide==='origin')return {rowCount:1,rows:[{...origin,lat:null}]};return {rowCount:1,rows:[lookups===1?origin:{...destination,lng:null}]}},transaction:async()=>{throw new Error('No debe abrir transacción')}});
    const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){providerCalls++;return calculated}});
    const {res}=await invoke(app.route('/api/geography/routes'));
    assert.equal(res.statusCode,422);assert.match(res.payload.error,new RegExp(invalidSide==='origin'?'origen':'destino'));assert.equal(providerCalls,0);
  }
});

test('error del proveedor no persiste ninguna ruta',async()=>{
  const pool=poolWith({lookup:async(sql,values)=>({rowCount:1,rows:[values[0]===11?origin:destination]}),transaction:async()=>{throw new Error('No debe abrir transacción')}});
  const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){throw new RoutingError('OSRM unavailable')}});
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,502);assert.equal(pool.calls.some(call=>call.sql==='BEGIN'),false);
});

test('ruta no encontrada devuelve 404 sin persistencia',async()=>{
  const pool=poolWith({lookup:async(sql,values)=>({rowCount:1,rows:[values[0]===11?origin:destination]}),transaction:async()=>{throw new Error('No debe abrir transacción')}});
  const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){return null}});
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,404);assert.equal(res.payload.error,'No se encontró una ruta por carretera');assert.equal(pool.calls.some(call=>call.sql==='BEGIN'),false);
});

test('respuesta incompleta del proveedor se rechaza sin persistencia',async()=>{
  const pool=poolWith({lookup:async(sql,values)=>({rowCount:1,rows:[values[0]===11?origin:destination]}),transaction:async()=>{throw new Error('No debe abrir transacción')}});
  const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){return {...calculated,geometry:null}}});
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,502);assert.equal(pool.calls.some(call=>call.sql==='BEGIN'),false);
});

test('fallo de persistencia ejecuta ROLLBACK sin auditoría ni COMMIT',async()=>{
  const pool=poolWith({lookup:async(sql,values)=>({rowCount:1,rows:[values[0]===11?origin:destination]}),transaction:async(sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.startsWith('insert into road_routes'))throw new Error('insert failure');throw new Error(`Consulta inesperada: ${sql}`)}});
  const app=fakeApp();registerRoutingRoutes(app,pool,{async route(){return calculated}});
  const {res}=await invoke(app.route('/api/geography/routes'));
  assert.equal(res.statusCode,400);assert.equal(pool.calls.some(call=>call.sql==='ROLLBACK'),true);assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});
