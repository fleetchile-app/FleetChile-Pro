const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {writeAudit}=require('../audit');
const {registerCoreRoutes}=require('../core-api');
const {registerOperationsRoutes}=require('../operations-api');

function fakeApp(){
  const routes=[];
  for(const method of ['get','post','put','patch','delete'])routes[method]=(routePath,...handlers)=>routes.push({method,path:routePath,handlers});
  routes.route=(method,routePath)=>{
    const route=routes.find(x=>x.method===method&&x.path===routePath);
    assert.ok(route,`Ruta no registrada: ${method.toUpperCase()} ${routePath}`);
    return route;
  };
  return routes;
}

function response(){
  return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}};
}

async function invoke(route,overrides={}){
  const req={user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage','loads.manage']},params:{id:'7'},body:{},query:{},ip:'127.0.0.1',get(){return ''},...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

function transactionalPool(resolver){
  const calls=[];
  const client={
    calls,
    async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)},
    release(){}
  };
  return {calls,client,async query(sql,values=[]){return client.query(sql,values)},async connect(){return client}};
}

const auditCall=calls=>calls.find(call=>call.sql.startsWith('insert into audit_logs'));
const indexOf=(calls,prefix)=>calls.findIndex(call=>call.sql.startsWith(prefix));

test('creación de viaje persiste route_id, fuerza Planificado y audita en la transacción',async()=>{
  const pool=transactionalPool(async(sql,values)=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rowCount:0,rows:[]};
    if(sql.startsWith('select id from routes'))return {rowCount:1,rows:[{id:44}]};
    if(sql.startsWith('insert into trips'))return {rowCount:1,rows:[{id:7,company_id:10,route_id:44,status:'Planificado'}]};
    if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/trips'),{body:{origin:'Santiago',destination:'Temuco',route_id:44,status:'Completado'}});
  assert.equal(res.statusCode,201);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into trips'));
  assert.match(insert.sql,/client_id,route_id,origin/);
  assert.equal(insert.values[5],44);
  assert.equal(insert.values[10],'Planificado');
  assert.equal(res.payload.status,'Planificado');
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[10,5,'create','trip','7']);
  assert.equal(audit.values[5],null);
  assert.deepEqual(audit.values[6],res.payload);
  assert.ok(indexOf(pool.calls,'insert into trips')<indexOf(pool.calls,'insert into audit_logs'));
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
});

test('creación de viaje rechaza route_id de otra empresa sin insertar',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('select id from routes'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/trips'),{body:{origin:'A',destination:'B',route_id:99}});
  assert.equal(res.statusCode,403);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trips')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('fallo de auditoría revierte la creación de viaje',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into trips'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Planificado'}]};
    if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/trips'),{body:{origin:'A',destination:'B'}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('asignación Planificado a Asignado registra historial, evento y auditoría antes de COMMIT',async()=>{
  const before={id:7,company_id:10,status:'Planificado',truck_id:null,driver_id:null,route_id:null};
  const after={...before,status:'Asignado',truck_id:3,driver_id:4,route_id:44};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.includes('select * from trips t'))return {rowCount:1,rows:[before]};
    if(/^select id from (trucks|drivers|routes)/.test(sql))return {rowCount:1,rows:[{id:1}]};
    if(sql.startsWith('update trips set'))return {rowCount:1,rows:[after]};
    if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/assign'),{body:{truck_id:3,driver_id:4,route_id:44}});
  assert.equal(res.statusCode,200);
  const history=pool.calls.find(call=>call.sql.startsWith('insert into trip_status_history'));
  assert.deepEqual(history.values.slice(0,3),['7','Planificado','Asignado']);
  assert.ok(pool.calls.some(call=>call.sql.startsWith('insert into trip_events')));
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[10,5,'assign','trip','7']);
  assert.deepEqual(audit.values[5],before);
  assert.deepEqual(audit.values[6],after);
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
});

test('fallo intermedio de asignación ejecuta ROLLBACK sin auditoría ni COMMIT',async()=>{
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.includes('select * from trips t'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Planificado'}]};
    if(sql.startsWith('select id from trucks')||sql.startsWith('select id from drivers'))return {rowCount:1,rows:[{id:1}]};
    if(sql.startsWith('update trips set'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Asignado'}]};
    if(sql.startsWith('insert into trip_status_history'))return {rowCount:1,rows:[]};
    if(sql.startsWith('insert into trip_events'))throw new Error('event failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/assign'),{body:{truck_id:3,driver_id:4}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('fallo de auditoría revierte la asignación',async()=>{
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.includes('select * from trips t'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Planificado'}]};
    if(sql.startsWith('select id from trucks')||sql.startsWith('select id from drivers'))return {rowCount:1,rows:[{id:1}]};
    if(sql.startsWith('update trips set'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Asignado'}]};
    if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events'))return {rowCount:1,rows:[]};
    if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/assign'),{body:{truck_id:3,driver_id:4}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('cambio de estado conserva historial/evento y agrega auditoría transaccional',async()=>{
  const before={id:7,company_id:10,status:'Asignado'};
  const after={...before,status:'En carga'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
    if(sql.startsWith('update trips set'))return {rowCount:1,rows:[after]};
    if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/status'),{body:{status:'En carga'}});
  assert.equal(res.statusCode,200);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[10,5,'status_change','trip','7']);
  assert.deepEqual(audit.values[5],before);
  assert.deepEqual(audit.values[6],after);
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
});

test('endpoint core de estado también audita dentro de su transacción',async()=>{
  const before={id:7,company_id:10,status:'En carga'};
  const after={...before,status:'En tránsito'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
    if(sql.startsWith('update trips set'))return {rowCount:1,rows:[after]};
    if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/trips/:id/status'),{body:{status:'En tránsito'}});
  assert.equal(res.statusCode,200);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[10,5,'status_change','trip','7']);
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
});

test('eventos, checklist, cargas y POD escriben audit_logs antes de COMMIT',async()=>{
  const cases=[
    ['post','/api/operations/trips/:id/events',{event_type:'Control'},'trip_event'],
    ['post','/api/operations/trips/:id/checklist',{truck_id:3,status:'Aprobado'},'vehicle_checklist'],
    ['post','/api/operations/trips/:id/loads',{cargo:'Carga'},'trip_load'],
    ['post','/api/operations/trips/:id/deliver',{load_id:9,recipient_name:'Receptor'},'trip_delivery_proof']
  ];
  for(const [method,routePath,body,entity] of cases){
    const pool=transactionalPool(async(sql)=>{
      if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
      if(sql.includes('from trips t')||sql.includes('from trips where'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Asignado'}]};
      if(sql.startsWith('select id from trucks'))return {rowCount:1,rows:[{id:3}]};
      if(sql.startsWith('select * from trip_loads'))return {rowCount:1,rows:[{id:9,trip_id:7,status:'Planificada'}]};
      if(sql.startsWith('insert into trip_events')&&entity==='trip_event')return {rowCount:1,rows:[{id:21,trip_id:7,event_type:'Control'}]};
      if(sql.startsWith('insert into vehicle_checklists'))return {rowCount:1,rows:[{id:22,trip_id:7,truck_id:3}]};
      if(sql.startsWith('insert into trip_loads'))return {rowCount:1,rows:[{id:23,trip_id:7,cargo:'Carga'}]};
      if(sql.startsWith('insert into trip_delivery_proofs'))return {rowCount:1,rows:[{id:24,trip_id:7,load_id:9}]};
      if(sql.startsWith('update trip_loads'))return {rowCount:1,rows:[{id:9,trip_id:7,status:'Entregada'}]};
      if(sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
      throw new Error(`Consulta inesperada en ${routePath}: ${sql}`);
    });
    const app=fakeApp();await registerOperationsRoutes(app,pool);
    const {res}=await invoke(app.route(method,routePath),{body});
    assert.ok([200,201].includes(res.statusCode),routePath);
    const audit=auditCall(pool.calls);
    assert.ok(audit,routePath);
    assert.equal(audit.values[0],10,routePath);
    assert.equal(audit.values[1],5,routePath);
    assert.equal(audit.values[3],entity,routePath);
    assert.ok(audit.values[6],routePath);
    assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'),routePath);
  }
});

test('writeAudit registra company, actor, before/after e IP',async()=>{
  const calls=[];const db={async query(sql,values){calls.push({sql,values});return {rowCount:1,rows:[]}}};
  const before={status:'Planificado'},after={status:'Asignado'};
  await writeAudit(db,{user:{id:8},ip:'10.0.0.8'},{companyId:12,action:'assign',entity:'trip',entityId:77,beforeData:before,afterData:after});
  assert.match(calls[0].sql,/insert into audit_logs/);
  assert.deepEqual(calls[0].values,[12,8,'assign','trip','77',before,after,'10.0.0.8']);
});

test('creación de ruta y DELETE legacy contienen auditoría transaccional',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(source,/app\.post\("\/api\/routes"[\s\S]*?writeAudit\(client,req,\{companyId:req\.resourceCompanyId,action:'create',entity:'route'/);
  assert.match(source,/app\.delete\("\/api\/:table\/:id"[\s\S]*?delete from \$\{req\.params\.table\}[\s\S]*?returning \*[\s\S]*?action:'delete'/);
  assert.match(source,/action:'delete'[\s\S]*?beforeData:before[\s\S]*?COMMIT/);
});
