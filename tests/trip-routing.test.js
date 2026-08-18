const test=require('node:test');
const assert=require('node:assert/strict');
const {registerOperationsRoutes}=require('../operations-api');

function fakeApp(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>{const route=routes.find(item=>item.method===method&&item.path===path);assert.ok(route,`Ruta no registrada: ${method.toUpperCase()} ${path}`);return route};return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,overrides={}){const req={user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage']},params:{id:'21'},body:{road_route_id:31},ip:'127.0.0.1',...overrides};const res=response();let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};await next();return {req,res}}
function transactionalPool(resolver){const calls=[];const client={async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)},release(){calls.push({sql:'RELEASE',values:[]})}};return {calls,async connect(){return client},async query(sql,values=[]){return client.query(sql,values)}}}

const currentTrip={id:21,company_id:10,trip_number:'V-21',status:'Planificado',distance_km:'0',planned_route_snapshot_id:null};
const roadRoute={id:31,company_id:10,origin_location_id:41,destination_location_id:42,distance_meters:'500250.4',duration_seconds:'19800.5',geometry:{type:'LineString',coordinates:[[-73.05,-36.827],[-70.6693,-33.4489]]},provider:'osrm',calculated_at:'2026-08-18T18:00:00.000Z'};
const snapshot={id:51,company_id:10,trip_id:21,road_route_id:31,origin_location_id:41,destination_location_id:42,distance_meters:'500250.4',duration_seconds:'19800.5',geometry:roadRoute.geometry,provider:'osrm',route_calculated_at:'2026-08-18T18:00:00.000Z',created_by:5};
const updatedTrip={...currentTrip,distance_km:'500.2504',planned_route_snapshot_id:51};

test('asocia ruta vial creando snapshot y actualizando el viaje transaccionalmente',async()=>{
  const pool=transactionalPool(async(sql)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith('select * from trips t'))return {rowCount:1,rows:[currentTrip]};if(sql.startsWith('select rr.* from road_routes'))return {rowCount:1,rows:[roadRoute]};if(sql.startsWith('insert into trip_route_snapshots'))return {rowCount:1,rows:[snapshot]};if(sql.startsWith('update trips set planned_route_snapshot_id'))return {rowCount:1,rows:[updatedTrip]};if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};throw new Error(`Consulta inesperada: ${sql}`)});
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/planned-route'));
  assert.equal(res.statusCode,200);assert.deepEqual(res.payload,{trip:updatedTrip,planned_route:snapshot});
  const tripLookup=pool.calls.find(call=>call.sql.startsWith('select * from trips t'));assert.match(tripLookup.sql,/t\.id=\$1 and t\.company_id=\$2 for update$/);assert.deepEqual(tripLookup.values,['21',10]);
  const routeLookup=pool.calls.find(call=>call.sql.startsWith('select rr.*'));assert.match(routeLookup.sql,/rr\.id=\$1 and rr\.company_id=\$2$/);assert.deepEqual(routeLookup.values,[31,10]);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into trip_route_snapshots'));assert.deepEqual(insert.values,[10,21,31,41,42,'500250.4','19800.5',roadRoute.geometry,'osrm','2026-08-18T18:00:00.000Z',5]);
  const update=pool.calls.find(call=>call.sql.startsWith('update trips set planned_route_snapshot_id'));assert.deepEqual(update.values,[51,'500250.4',21,10]);
  const audit=pool.calls.find(call=>call.sql.startsWith('insert into audit_logs'));assert.equal(audit.values[2],'plan_route');assert.equal(audit.values[3],'trip');assert.deepEqual(audit.values[5],currentTrip);assert.deepEqual(audit.values[6],{trip:updatedTrip,planned_route:snapshot});
  assert.ok(pool.calls.indexOf(insert)<pool.calls.indexOf(update));assert.ok(pool.calls.indexOf(update)<pool.calls.indexOf(audit));assert.ok(pool.calls.indexOf(audit)<pool.calls.findIndex(call=>call.sql==='COMMIT'));
});

test('viaje inexistente o cross-company devuelve 404 sin consultar la ruta ni escribir',async()=>{
  const pool=transactionalPool(async(sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.startsWith('select * from trips t'))return {rowCount:0,rows:[]};throw new Error(`Consulta inesperada: ${sql}`)});
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/planned-route'));
  assert.equal(res.statusCode,404);assert.equal(pool.calls.some(call=>call.sql.includes('road_routes')),false);assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into')),false);assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});

test('ruta vial inexistente o de otra empresa se rechaza antes del snapshot',async()=>{
  const pool=transactionalPool(async(sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.startsWith('select * from trips t'))return {rowCount:1,rows:[currentTrip]};if(sql.startsWith('select rr.* from road_routes'))return {rowCount:0,rows:[]};throw new Error(`Consulta inesperada: ${sql}`)});
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/planned-route'));
  assert.equal(res.statusCode,404);assert.deepEqual(res.payload,{error:'Ruta vial no encontrada'});assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_route_snapshots')),false);assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});

test('fallo al crear snapshot revierte sin actualizar viaje ni auditar',async()=>{
  const pool=transactionalPool(async(sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.startsWith('select * from trips t'))return {rowCount:1,rows:[currentTrip]};if(sql.startsWith('select rr.* from road_routes'))return {rowCount:1,rows:[roadRoute]};if(sql.startsWith('insert into trip_route_snapshots'))throw new Error('snapshot failure');throw new Error(`Consulta inesperada: ${sql}`)});
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/planned-route'));
  assert.equal(res.statusCode,400);assert.equal(pool.calls.some(call=>call.sql==='ROLLBACK'),true);assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips')),false);assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});

test('fallo de auditoría revierte snapshot y actualización del viaje',async()=>{
  const pool=transactionalPool(async(sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.startsWith('select * from trips t'))return {rowCount:1,rows:[currentTrip]};if(sql.startsWith('select rr.* from road_routes'))return {rowCount:1,rows:[roadRoute]};if(sql.startsWith('insert into trip_route_snapshots'))return {rowCount:1,rows:[snapshot]};if(sql.startsWith('update trips set planned_route_snapshot_id'))return {rowCount:1,rows:[updatedTrip]};if(sql.startsWith('insert into audit_logs'))throw new Error('audit failure');throw new Error(`Consulta inesperada: ${sql}`)});
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/planned-route'));
  assert.equal(res.statusCode,400);assert.equal(pool.calls.some(call=>call.sql==='ROLLBACK'),true);assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});

test('detalle expone el snapshot preservado sin volver a consultar road_routes',async()=>{
  const plannedRoute={id:51,road_route_id:31,origin_location_id:41,destination_location_id:42,distance_km:'500.2504',duration_seconds:'19800.5',geometry:roadRoute.geometry,provider:'osrm',calculated_at:'2026-08-18T18:00:00.000Z',created_at:'2026-08-18T18:01:00.000Z'};
  const pool={calls:[],async query(sql,values=[]){this.calls.push({sql,values});if(sql.includes('from trips t left join trucks'))return {rowCount:1,rows:[updatedTrip]};if(sql.startsWith('select id,road_route_id'))return {rowCount:1,rows:[plannedRoute]};return {rowCount:0,rows:[]}}};
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'),{body:{}});
  assert.equal(res.statusCode,200);assert.deepEqual(res.payload.planned_route,plannedRoute);assert.equal(pool.calls.some(call=>call.sql.includes('from road_routes')),false);
  const snapshotQuery=pool.calls.find(call=>call.sql.startsWith('select id,road_route_id'));assert.match(snapshotQuery.sql,/where id=\$1 and trip_id=\$2$/);assert.deepEqual(snapshotQuery.values,[51,'21']);
});

test('detalle de viaje legacy sin snapshot conserva contrato y devuelve planned_route null',async()=>{
  const pool={calls:[],async query(sql,values=[]){this.calls.push({sql,values});if(sql.includes('from trips t left join trucks'))return {rowCount:1,rows:[currentTrip]};return {rowCount:0,rows:[]}}};
  const app=fakeApp();registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'),{body:{}});
  assert.equal(res.statusCode,200);assert.equal(res.payload.planned_route,null);assert.equal(pool.calls.some(call=>call.sql.includes('trip_route_snapshots')),false);
});
