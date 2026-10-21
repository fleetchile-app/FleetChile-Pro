const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {registerCoreRoutes}=require('../core-api');
const {registerOperationsRoutes}=require('../operations-api');
const {registerFleetRoutes}=require('../fleet-api');
const {requirePermission}=require('../auth');
const {writeAudit}=require('../audit');
const {syncResourceAlert}=require('../trip-resources');
const {MIGRATION_FILES}=require('../startup');

function setup(options={}){
 const source={id:7,company_id:10,client_id:11,truck_id:8,driver_id:9,status:'Planificado',...options.source};
 const target={id:20,company_id:10,client_id:11,truck_id:12,driver_id:15,status:'Asignado',...options.target};
 const load={id:30,trip_id:7,status:'Planificada',...options.load};
 const calls=[],events=[],audits=[];let releases=0;
 const reply=rows=>({rows,rowCount:rows.length});
 const db={async query(sql,values=[]){
  calls.push({sql,values});
  if(options.fail&&sql.startsWith(options.fail))throw Error('Fallo simulado');
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return reply([]);
  if(sql.startsWith('select id,company_id from trips t'))return reply(options.foreignSource?[]:[source]);
  if(sql.startsWith('select * from trips where id=any'))return reply([source,target].filter(trip=>String(trip.company_id)===String(values[1])));
  if(sql.startsWith('select status,truck_id,driver_id from trips'))return reply([source]);
  if(sql.startsWith('select id,company_id,driver_id,truck_id from trips'))return reply(String(source.driver_id)===String(values[2])?[source]:[]);
  if(sql.startsWith('select id,truck_id,driver_id,trip_id,checklist_type'))return reply([]);
  if(sql.startsWith('select * from trips'))return reply(options.foreignSource?[]:[source]);
  if(sql.startsWith('select id from clients')||sql.startsWith('select id from routes')||sql.startsWith('select id from drivers')||sql.startsWith('select id from trucks'))return reply(options.foreignResource?[]:[{id:values[0]}]);
  if(sql.startsWith('select id,patente from trucks'))return reply(options.foreignResource?[]:[{id:8,patente:'MIFLOTA'}]);
  if(sql.startsWith('select id,patente,tipo,status from trucks'))return reply([{id:8,patente:'MIFLOTA',tipo:'Camión'}]);
  if(sql.startsWith('select * from trip_loads'))return reply(options.foreignLoad?[]:[load]);
  if(sql.startsWith('select id from trip_delivery_proofs'))return reply(options.proof?[{id:2,status:options.proof}]:[]);
  if(sql.startsWith('select * from alerts'))return reply([{id:5,company_id:10,source_type:'trip',source_id:7,condition_code:'trip_resources_missing',resolved:false}]);
  if(sql.startsWith('insert into routes'))return reply([{id:40,company_id:10,truck_id:values[1],truck:values[2],status:'Planificada',distance_km:values[5]}]);
  if(sql.startsWith('insert into trips'))return reply([{...source,truck_id:values[2],driver_id:values[3]}]);
  if(sql.startsWith('update trips set truck_id'))return reply([{...source,truck_id:values[0],driver_id:values[1],client_id:values[2],route_id:values[3],status:values[0]&&values[1]&&source.status==='Planificado'?'Asignado':source.status}]);
  if(sql.startsWith('update trips set status'))return reply([{...source,status:values[0]}]);
  if(sql.startsWith('update trip_loads set trip_id'))return reply([{...load,trip_id:values[0]}]);
  if(sql.startsWith('insert into trip_events')){events.push(values);return reply([])}
  if(sql.startsWith('insert into audit_logs')){audits.push(values);return reply([])}
  if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into alerts')||sql.startsWith('update alerts'))return reply([]);
  throw Error('SQL inesperado: '+sql);
 },release(){releases++}};
 const pool={calls,events,audits,get releases(){return releases},async connect(){return db},query:db.query};
 const routes=[],app={};
 for(const method of ['get','post','patch'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
 registerCoreRoutes(app,pool);registerOperationsRoutes(app,pool);registerFleetRoutes(app,pool);
 // Registrar solamente el handler real de creación de rutas, sin iniciar servidor ni migraciones.
 const server=fs.readFileSync(require.resolve('../server.js'),'utf8').replace(/\r\n/g,'\n');
 const start=server.indexOf('app.post("/api/routes"'),end=server.indexOf('\napp.',start+1);
 Function('app','pool','requirePermission','requireCreationCompany','writeAudit',server.slice(start,end))(app,pool,requirePermission,(req,res,next)=>next(),writeAudit);
 return {pool,source,route:(method,path)=>routes.find(route=>route.method===method&&route.path===path)};
}
async function invoke(route,body={},overrides={}){
 const req={user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage','loads.manage','fleet.manage']},params:{id:'7',loadId:'30'},body,resourceCompanyId:10,query:{},ip:'127.0.0.1',...overrides};
 const res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this},sendStatus(code){this.statusCode=code;return this}};
 let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
 await next();return res;
}

for(const path of ['/api/trips/:id/status','/api/operations/trips/:id/status']){
 for(const status of ['Asignado','En carga','En tránsito','Detenido','Llegó a destino','Descargando','Completado'])test(`${path}: no permite ${status} sin conductor`,async()=>{
  const {pool,route}=setup({source:{driver_id:null}});
  assert.equal((await invoke(route('patch',path),{status})).statusCode,409);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
 });
 test(`${path}: no permite iniciar sin camión`,async()=>{
  const {route}=setup({source:{truck_id:null}});
  assert.equal((await invoke(route('patch',path),{status:'En tránsito'})).statusCode,409);
 });
}

test('conductor no inicia su viaje asignado si falta camión',async()=>{
 const {pool,route}=setup({source:{truck_id:null,status:'Asignado'}});
 const user={id:5,role_code:'driver',company_id:10,driver_id:9};
 assert.equal((await invoke(route('patch','/api/driver/trips/:id/status'),{status:'En tránsito'},{user})).statusCode,409);
 assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips')),false);
});

test('asignación diferida mantiene Planificado y crea aviso persistente deduplicado',async()=>{
 const {pool,route}=setup({source:{truck_id:null,driver_id:null}});
 const result=await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:8,driver_id:null});
 assert.equal(result.statusCode,200);assert.equal(result.payload.status,'Planificado');
 const alert=pool.calls.find(call=>call.sql.startsWith('insert into alerts'));
 assert.match(alert.sql,/on conflict \(company_id,source_type,source_id,condition_code\)/);
 assert.match(alert.sql,/do update set text=excluded.text/);
 assert.deepEqual(alert.values.slice(2),[7,'trip_resources_missing']);
 assert.equal(pool.calls.at(-1).sql,'COMMIT');
});

test('completar camión y conductor pasa a Asignado y resuelve el aviso',async()=>{
 const {pool,route}=setup({source:{truck_id:null,driver_id:null}});
 const result=await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:8,driver_id:9});
 assert.equal(result.statusCode,200);assert.equal(result.payload.status,'Asignado');
 assert.ok(pool.calls.some(call=>call.sql.startsWith('update alerts set resolved=true')));
 assert.equal(pool.events[0][4].before.driver_id,null);
 assert.equal(pool.events[0][4].after.driver_id,9);
});

test('no se puede ocultar manualmente una alerta de recursos pendientes',async()=>{
 const {pool,route}=setup();
 assert.equal((await invoke(route('post','/api/fleet/alerts/:id/resolve'))).statusCode,409);
 assert.equal(pool.calls.some(call=>call.sql.startsWith('update alerts')),false);
});

test('cancelación permite cerrar un viaje incompleto y resolver la alerta',async()=>{
 const {pool,route}=setup({source:{driver_id:null}});
 assert.equal((await invoke(route('patch','/api/operations/trips/:id/status'),{status:'Cancelado'})).statusCode,200);
 assert.ok(pool.calls.some(call=>call.sql.startsWith('update alerts set resolved=true')));
});

test('cambio en ruta exige motivo y conserva anterior/nuevo, autor e instante del evento',async()=>{
 const {pool,route}=setup({source:{status:'En tránsito',actual_departure:'2026-10-21T10:00:00Z'}});
 assert.equal((await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:12})).statusCode,400);
 const result=await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:12,reason:'Reemplazo por avería'});
 assert.equal(result.statusCode,200);assert.equal(result.payload.status,'En tránsito');
 const event=pool.events.at(-1);
 assert.equal(event[1],'Reasignación de recursos');assert.equal(event[2],'Reemplazo por avería');assert.equal(event[3],5);
 assert.equal(event[4].before.truck_id,8);assert.equal(event[4].after.truck_id,12);
 assert.equal(pool.calls.some(call=>call.sql.startsWith('update trucks')),false);
});

test('no se puede quitar conductor durante la ejecución ni modificar un viaje terminado',async()=>{
 const active=setup({source:{status:'En tránsito'}});
 assert.equal((await invoke(active.route('patch','/api/operations/trips/:id/assign'),{driver_id:null,reason:'Cambio'})).statusCode,409);
 for(const status of ['Completado','Cancelado']){
  const closed=setup({source:{status}});
  assert.equal((await invoke(closed.route('patch','/api/operations/trips/:id/assign'),{truck_id:12,reason:'Cambio'})).statusCode,409);
 }
});

test('reasignación rechaza recursos ajenos y ausencia de permiso',async()=>{
 const {pool,route}=setup({foreignResource:true});
 assert.equal((await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:12})).statusCode,403);
 assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips')),false);
 assert.equal((await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:12},{user:{id:5,role_code:'viewer',company_id:10,permissions:[]}})).statusCode,403);
});

test('fallo al sincronizar alerta revierte la asignación y su auditoría',async()=>{
 const {pool,route}=setup({fail:'update alerts'});
 assert.equal((await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:12})).statusCode,400);
 assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
 assert.equal(pool.calls.at(-1).sql,'ROLLBACK');assert.equal(pool.releases,1);
});

test('transferencia conserva carga, motivo y trazabilidad en ambos viajes de la misma empresa',async()=>{
 const {pool,route}=setup();
 const result=await invoke(route('post','/api/operations/trips/:id/loads/:loadId/transfer'),{target_trip_id:20,reason:'Cambio de equipo'});
 assert.equal(result.statusCode,200);assert.equal(result.payload.load.trip_id,20);
 assert.deepEqual(pool.events.map(event=>event[0]),[7,20]);
 assert.equal(pool.audits[0][2],'transfer');
 assert.equal(pool.audits[0][5].trip_id,7);assert.equal(pool.audits[0][6].trip_id,20);
 assert.match(pool.calls.find(call=>call.sql.includes('id=any')).sql,/order by id for update/);
 assert.equal(pool.calls.some(call=>/update .*economic|update .*cost/i.test(call.sql)),false);
});

for(const [name,options,status] of [
 ['otro tenant',{target:{company_id:20}},404],['viaje origen ajeno',{foreignSource:true},404],['viaje destino terminado',{target:{status:'Completado'}},409],
 ['carga ajena',{foreignLoad:true},404],['carga entregada',{load:{status:'Entregada'}},409],['POD cerrado',{proof:'CLOSED'},409],['POD borrador',{proof:'DRAFT'},409],['POD anulado',{proof:'VOID'},409]
])test('transferencia bloquea '+name,async()=>{
 const {pool,route}=setup(options);
 assert.equal((await invoke(route('post','/api/operations/trips/:id/loads/:loadId/transfer'),{target_trip_id:20,reason:'Reemplazo'})).statusCode,status);
 assert.equal(pool.calls.some(call=>call.sql.startsWith('update trip_loads')),false);
 assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

for(const reason of ['',null])test('transferencia exige motivo '+String(reason),async()=>{
 const {pool,route}=setup();
 assert.equal((await invoke(route('post','/api/operations/trips/:id/loads/:loadId/transfer'),{target_trip_id:20,reason})).statusCode,400);
 assert.equal(pool.calls.length,0);
});

test('transferencia revierte si falla la auditoría',async()=>{
 const {pool,route}=setup({fail:'insert into audit_logs'});
 assert.equal((await invoke(route('post','/api/operations/trips/:id/loads/:loadId/transfer'),{target_trip_id:20,reason:'Cambio'})).statusCode,500);
 assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
 assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('ruta usa camión real de la empresa y permite planificación sin camión',async()=>{
 for(const truck_id of [8,null]){
  const {pool,route}=setup();
  const result=await invoke(route('post','/api/routes'),{truck_id,origin:'Origen',destination:'Destino',distance_km:null});
  assert.equal(result.statusCode,201);assert.equal(result.payload.status,'Planificada');
  assert.equal(result.payload.truck,truck_id?'MIFLOTA':null);assert.equal(result.payload.distance_km,null);
  if(truck_id)assert.deepEqual(pool.calls.find(call=>call.sql.startsWith('select id,patente from trucks')).values,[8,10]);
 }
});

test('ruta rechaza texto libre, camión ajeno y activación por estado o avance',async()=>{
 for(const body of [{truck:'PATENTE INVENTADA'},{truck_id:8,status:'En ruta'},{truck_id:8,progress:1}]){
  const {pool,route}=setup();
  assert.equal((await invoke(route('post','/api/routes'),{origin:'Origen',destination:'Destino',...body})).statusCode,400);
  assert.equal(pool.calls.length,0);
 }
 const {pool,route}=setup({foreignResource:true});
 assert.equal((await invoke(route('post','/api/routes'),{truck_id:8,origin:'Origen',destination:'Destino'})).statusCode,403);
 assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into routes')),false);
});

test('migración 028 es aditiva, se registra y genera avisos actuales sin reescribir viajes',()=>{
 const sql=fs.readFileSync(require.resolve('../migrations/028_trip_resource_coherence.sql'),'utf8');
 assert.equal(MIGRATION_FILES.at(-1),'028_trip_resource_coherence.sql');
 assert.match(sql,/ADD COLUMN IF NOT EXISTS details JSONB/);
 assert.match(sql,/ON CONFLICT/);
 assert.doesNotMatch(sql,/UPDATE trips|DELETE FROM trips/i);
 assert.match(sql,/BEGIN;[\s\S]*COMMIT;/);
});

test('conductor no recibe acciones de avance cuando falta el camión',async()=>{
 const {route}=setup({source:{truck_id:null,status:'Asignado'}});
 const result=await invoke(route('get','/api/driver/trips/:id/allowed-statuses'),{}, {user:{id:5,role_code:'driver',company_id:10,driver_id:9}});
 assert.equal(result.statusCode,200);assert.deepEqual(result.payload.allowed_statuses,[]);
});

test('checklist del conductor se consulta para los recursos actuales, sin reutilizar otra inspección',async()=>{
 const {pool,route}=setup();
 const result=await invoke(route('get','/api/driver/trips/:id/checklist'),{}, {user:{id:5,role_code:'driver',company_id:10,driver_id:9}});
 assert.equal(result.statusCode,200);
 const query=pool.calls.find(call=>call.sql.includes('from vehicle_checklists'));
 assert.match(query.sql,/trip_id=\$1 and truck_id=\$2 and driver_id=\$3/);
 assert.deepEqual(query.values,[7,8,9]);
});

test('conductor reemplazado deja de acceder al checklist del viaje',async()=>{
 const {pool,route}=setup({source:{driver_id:15}});
 assert.equal((await invoke(route('get','/api/driver/trips/:id/checklist'),{}, {user:{id:5,role_code:'driver',company_id:10,driver_id:9}})).statusCode,404);
 assert.equal(pool.calls.some(call=>call.sql.includes('from vehicle_checklists')),false);
});

test('catálogo de ruta solo consulta la flota del contexto empresarial activo',async()=>{
 const {pool,route}=setup();
 const result=await invoke(route('get','/api/routes/resources'));
 assert.equal(result.statusCode,200);
 assert.deepEqual(pool.calls[0].values,[10]);assert.match(pool.calls[0].sql,/company_id=\$1/);
});

test('plataforma contextualizada reasigna únicamente dentro de su empresa activa',async()=>{
 const {pool,route}=setup();
 const user={id:5,actor_type:'platform',scope:'platform',platform_membership_id:2,active_company_context:10,permissions:['trips.manage']};
 assert.equal((await invoke(route('patch','/api/operations/trips/:id/assign'),{truck_id:12},{user})).statusCode,200);
 assert.deepEqual(pool.calls.find(call=>call.sql.startsWith('select * from trips t')).values,['7',10]);
});

test('aviso de faltantes se actualiza y se resuelve al cancelarse el viaje',async()=>{
 const {pool}=setup();
 await syncResourceAlert(pool,{id:7,company_id:10,status:'Planificado',truck_id:8,driver_id:null});
 await syncResourceAlert(pool,{id:7,company_id:10,status:'Cancelado',truck_id:8,driver_id:null});
 assert.equal(pool.calls[0].values[1],'Viaje #7: falta asignar conductor');
 assert.ok(pool.calls[1].sql.startsWith('update alerts set resolved=true'));
});

test('formulario de rutas usa catálogo, permite diferir y no envía patentes libres',async()=>{
 const vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const start=source.indexOf('async function openRouteForm()'),end=source.indexOf('async function openDriverForm',start);
 const elements={},posts=[],messages=[];
 const context={document:{getElementById:id=>elements[id]||(elements[id]={classList:{remove(){}},innerHTML:''})},
  get:async path=>{assert.equal(path,'routes/resources');return {trucks:[{id:8,patente:'MIFLOTA',tipo:'Camión'}]}},
  gpsEscape:value=>String(value),FormData:class{constructor(form){return form.data}},
  post:async(path,body)=>posts.push({path,body}),close(){},render(){},alert:message=>messages.push(message)};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 await context.openRouteForm();
 assert.match(elements.form.innerHTML,/<select name="truck_id">/);
 assert.doesNotMatch(elements.form.innerHTML,/<input name="truck"/);
 assert.match(elements.form.innerHTML,/Asignar después/);
 for(const truck_id of ['8',''])await elements.form.onsubmit({preventDefault(){},target:{data:[['truck_id',truck_id],['origin','Origen'],['destination','Destino'],['distance_km','']]}});
 assert.equal(posts.length,2);assert.equal(posts[0].body.truck_id,8);assert.equal(posts[1].body.truck_id,null);
 assert.equal(posts[0].body.distance_km,null);assert.equal('truck' in posts[0].body,false);
 await elements.form.onsubmit({preventDefault(){},target:{data:[['truck_id','999'],['origin','Origen'],['destination','Destino'],['distance_km','']]}});
 assert.equal(posts.length,2);assert.match(messages[0],/tu flota/);
});

test('borrado genérico revierte al intentar ocultar una alerta vigente de recursos',async()=>{
 const source=fs.readFileSync(require.resolve('../server.js'),'utf8').replace(/\r\n/g,'\n');
 const start=source.indexOf('app.delete("/api/:table/:id"'),end=source.indexOf('\n',start);
 const calls=[];let handler;
 const db={async query(sql){calls.push(sql);return {rowCount:1,rows:[{id:5,company_id:10,source_type:'trip',condition_code:'trip_resources_missing',resolved:false}]}},release(){}};
 Function('app','pool','requireTablePermission','writePermissions','safeTable','isAdmin','companyId','writeAudit',source.slice(start,end))(
  {delete(path,...handlers){handler=handlers.at(-1)}},{connect:async()=>db},()=>()=>{}, {},()=>true,()=>false,()=>10,()=>{throw Error('No debe auditar una eliminación rechazada')});
 const res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
 await handler({params:{table:'alerts',id:'5'}},res);
 assert.equal(res.statusCode,409);assert.equal(calls.at(-1),'ROLLBACK');assert.equal(calls.includes('COMMIT'),false);
});

test('reabrir un viaje incompleto como Planificado restablece su aviso persistente',async()=>{
 for(const path of ['/api/trips/:id/status','/api/operations/trips/:id/status']){
  const {pool,route}=setup({source:{status:'Cancelado',driver_id:null}});
  assert.equal((await invoke(route('patch',path),{status:'Planificado'})).statusCode,200);
  assert.ok(pool.calls.some(call=>call.sql.startsWith('insert into alerts')));
 }
});
