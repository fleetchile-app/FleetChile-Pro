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
const statusEndpoints=[
  {name:'core',path:'/api/trips/:id/status',register:registerCoreRoutes},
  {name:'operations',path:'/api/operations/trips/:id/status',register:registerOperationsRoutes}
];

async function statusRoute(endpoint,pool){
  const app=fakeApp();await endpoint.register(app,pool);return app.route('patch',endpoint.path);
}

function legacyLoadHandler(){
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('async function legacyTruckBelongs');
  const handlerStart=source.indexOf('async function createLegacyLoad',start);
  const end=source.indexOf('\n}\n',handlerStart)+2;
  assert.ok(start>=0&&handlerStart>start&&end>handlerStart,'No se pudo aislar createLegacyLoad');
  return Function('writeAudit',`${source.slice(start,end)};return createLegacyLoad;`)(writeAudit);
}

test('creación de viaje persiste route_id, registra Planificado inicial y audita en la transacción',async()=>{
  const pool=transactionalPool(async(sql,values)=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rowCount:0,rows:[]};
    if(sql.startsWith('select id from routes'))return {rowCount:1,rows:[{id:44}]};
    if(sql.startsWith('insert into trips'))return {rowCount:1,rows:[{id:7,company_id:10,route_id:44,status:'Planificado'}]};
    if(sql.startsWith('insert into trip_status_history'))return {rowCount:1,rows:[]};
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
  const history=pool.calls.find(call=>call.sql.startsWith('insert into trip_status_history'));
  assert.deepEqual(history.values,[7,null,'Planificado',5]);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[10,5,'create','trip','7']);
  assert.equal(audit.values[5],null);
  assert.deepEqual(audit.values[6],res.payload);
  assert.ok(indexOf(pool.calls,'insert into trips')<indexOf(pool.calls,'insert into trip_status_history'));
  assert.ok(indexOf(pool.calls,'insert into trip_status_history')<indexOf(pool.calls,'insert into audit_logs'));
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

test('fallo del historial inicial revierte la creación sin auditoría ni COMMIT',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into trips'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Planificado'}]};
    if(sql.startsWith('insert into trip_status_history'))throw new Error('history failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/trips'),{body:{origin:'A',destination:'B'}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('fallo de auditoría revierte la creación de viaje',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into trips'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Planificado'}]};
    if(sql.startsWith('insert into trip_status_history'))return {rowCount:1,rows:[]};
    if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/trips'),{body:{origin:'A',destination:'B'}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_status_history')),true);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('detalle operacional expone status_history separado de events y ordenado',async()=>{
  const trip={id:7,company_id:10,status:'Asignado'};
  const event={id:31,trip_id:7,event_type:'Control'};
  const history={id:41,trip_id:7,from_status:'Planificado',to_status:'Asignado'};
  const pool=transactionalPool(async(sql,values)=>{
    if(sql.includes('from trips t left join trucks'))return {rowCount:1,rows:[trip]};
    if(sql.startsWith('select * from trip_events'))return {rowCount:1,rows:[event]};
    if(sql.startsWith('select * from trip_status_history'))return {rowCount:1,rows:[history]};
    if(sql.startsWith('select * from trip_loads')||sql.includes('from vehicle_checklists vc')||sql.startsWith('select * from trip_delivery_proofs'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta inesperada: ${sql} ${JSON.stringify(values)}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload.events,[event]);
  assert.deepEqual(res.payload.status_history,[history]);
  assert.notStrictEqual(res.payload.events,res.payload.status_history);
  const historyQuery=pool.calls.find(call=>call.sql.startsWith('select * from trip_status_history'));
  assert.deepEqual(historyQuery.values,['7']);
  assert.match(historyQuery.sql,/order by created_at desc,id desc$/);
});

test('detalle operacional no consulta colecciones hijas para un viaje fuera del company scope',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql.includes('from trips t left join trucks'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta hija inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,404);
  assert.equal(pool.calls.length,1);
  assert.match(pool.calls[0].sql,/t\.company_id=\$2/);
  assert.deepEqual(pool.calls[0].values,['7',10]);
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

for(const endpoint of statusEndpoints){
  test(`${endpoint.name}: cambio de estado conserva scope, trazabilidad y orden transaccional`,async()=>{
    const before={id:7,company_id:10,status:'Asignado'};
    const after={...before,status:'En carga'};
    const pool=transactionalPool(async(sql)=>{
      if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
      if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
      if(sql.startsWith('update trips set'))return {rowCount:1,rows:[after]};
      if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invoke(await statusRoute(endpoint,pool),{body:{status:'En carga'}});
    assert.equal(res.statusCode,200);
    const select=pool.calls.find(call=>call.sql.includes('select * from trips where'));
    assert.match(select.sql,/company_id=\$2 for update$/);
    assert.deepEqual(select.values,['7',10]);
    const update=pool.calls.find(call=>call.sql.startsWith('update trips set'));
    assert.deepEqual(update.values,['En carga','7',10]);
    const histories=pool.calls.filter(call=>call.sql.startsWith('insert into trip_status_history'));
    const events=pool.calls.filter(call=>call.sql.startsWith('insert into trip_events'));
    const audits=pool.calls.filter(call=>call.sql.startsWith('insert into audit_logs'));
    assert.equal(histories.length,1);
    assert.deepEqual(histories[0].values,['7','Asignado','En carga',null,5]);
    assert.equal(events.length,1);
    assert.deepEqual(events[0].values,['7','En carga','Estado cambiado a En carga',5]);
    assert.equal(audits.length,1);
    assert.deepEqual(audits[0].values.slice(0,7),[10,5,'status_change','trip','7',before,after]);
    assert.ok(indexOf(pool.calls,'update trips set')<indexOf(pool.calls,'insert into trip_status_history'));
    assert.ok(indexOf(pool.calls,'insert into trip_status_history')<indexOf(pool.calls,'insert into trip_events'));
    assert.ok(indexOf(pool.calls,'insert into trip_events')<indexOf(pool.calls,'insert into audit_logs'));
    assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
  });

  test(`${endpoint.name}: Completado conserva trazabilidad sin modificar el camión`,async()=>{
    const before={id:7,company_id:10,status:'Descargando',truck_id:3};
    const after={...before,status:'Completado',actual_arrival:'2026-08-18T15:30:00.000Z'};
    const pool=transactionalPool(async(sql)=>{
      if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
      if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
      if(sql.startsWith('update trips set'))return {rowCount:1,rows:[after]};
      if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invoke(await statusRoute(endpoint,pool),{body:{status:'Completado'}});
    assert.equal(res.statusCode,200);
    const update=pool.calls.find(call=>call.sql.startsWith('update trips set'));
    assert.match(update.sql,/actual_arrival=case when \$1='Completado'/);
    assert.deepEqual(update.values,['Completado','7',10]);
    const history=pool.calls.find(call=>call.sql.startsWith('insert into trip_status_history'));
    assert.deepEqual(history.values,['7','Descargando','Completado',null,5]);
    const event=pool.calls.find(call=>call.sql.startsWith('insert into trip_events'));
    assert.deepEqual(event.values,['7','Completado','Estado cambiado a Completado',5]);
    const audit=auditCall(pool.calls);
    assert.deepEqual(audit.values.slice(0,7),[10,5,'status_change','trip','7',before,after]);
    assert.ok(indexOf(pool.calls,'update trips set')<indexOf(pool.calls,'insert into trip_status_history'));
    assert.ok(indexOf(pool.calls,'insert into trip_status_history')<indexOf(pool.calls,'insert into trip_events'));
    assert.ok(indexOf(pool.calls,'insert into trip_events')<indexOf(pool.calls,'insert into audit_logs'));
    assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
    assert.equal(pool.calls.some(call=>/\b(update|insert into)\s+trucks\b/i.test(call.sql)),false);
    assert.equal(pool.calls.some(call=>/ubicaci[oó]n|location|disponib|retorno|base/i.test(call.sql)),false);
  });

  test(`${endpoint.name}: fallo de historial revierte sin evento, auditoría ni COMMIT`,async()=>{
    const before={id:7,company_id:10,status:'Asignado'};
    const pool=transactionalPool(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
      if(sql.startsWith('update trips set'))return {rowCount:1,rows:[{...before,status:'En carga'}]};
      if(sql.startsWith('insert into trip_status_history'))throw new Error('history failed');
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invoke(await statusRoute(endpoint,pool),{body:{status:'En carga'}});
    assert.equal(res.statusCode,400);
    assert.ok(indexOf(pool.calls,'update trips set')<indexOf(pool.calls,'insert into trip_status_history'));
    assert.ok(indexOf(pool.calls,'insert into trip_status_history')<indexOf(pool.calls,'ROLLBACK'));
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_events')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
    assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
    assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  });

  test(`${endpoint.name}: fallo de evento revierte historial y cambio sin auditoría ni COMMIT`,async()=>{
    const before={id:7,company_id:10,status:'Asignado'};
    const pool=transactionalPool(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
      if(sql.startsWith('update trips set'))return {rowCount:1,rows:[{...before,status:'En carga'}]};
      if(sql.startsWith('insert into trip_status_history'))return {rowCount:1,rows:[]};
      if(sql.startsWith('insert into trip_events'))throw new Error('event failed');
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invoke(await statusRoute(endpoint,pool),{body:{status:'En carga'}});
    assert.equal(res.statusCode,400);
    assert.ok(indexOf(pool.calls,'insert into trip_status_history')<indexOf(pool.calls,'insert into trip_events'));
    assert.ok(indexOf(pool.calls,'insert into trip_events')<indexOf(pool.calls,'ROLLBACK'));
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
    assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
    assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  });

  test(`${endpoint.name}: fallo de auditoría revierte cambio, historial y evento sin COMMIT`,async()=>{
    const before={id:7,company_id:10,status:'Asignado'};
    const pool=transactionalPool(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
      if(sql.startsWith('update trips set'))return {rowCount:1,rows:[{...before,status:'En carga'}]};
      if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events'))return {rowCount:1,rows:[]};
      if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invoke(await statusRoute(endpoint,pool),{body:{status:'En carga'}});
    assert.equal(res.statusCode,400);
    assert.ok(indexOf(pool.calls,'insert into trip_events')<indexOf(pool.calls,'insert into audit_logs'));
    assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'ROLLBACK'));
    assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
    assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  });

  test(`${endpoint.name}: viaje cross-company devuelve 404 sin escrituras parciales`,async()=>{
    const pool=transactionalPool(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('select * from trips where'))return {rowCount:0,rows:[]};
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invoke(await statusRoute(endpoint,pool),{body:{status:'En carga'}});
    assert.equal(res.statusCode,404);
    assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:'SELECT'),['BEGIN','SELECT','ROLLBACK']);
    const select=pool.calls[1];
    assert.match(select.sql,/company_id=\$2 for update$/);
    assert.deepEqual(select.values,['7',10]);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips set')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_status_history')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_events')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
    assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  });
}

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

test('Completado finaliza el viaje sin modificar estado, ubicación ni retorno del camión',async()=>{
  const before={id:7,company_id:10,status:'Descargando',truck_id:3};
  const after={...before,status:'Completado',actual_arrival:'2026-08-18T15:30:00.000Z'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.includes('select * from trips where'))return {rowCount:1,rows:[before]};
    if(sql.startsWith('update trips set'))return {rowCount:1,rows:[after]};
    if(sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events')||sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/operations/trips/:id/status'),{body:{status:'Completado'}});
  assert.equal(res.statusCode,200);
  const update=pool.calls.find(call=>call.sql.startsWith('update trips set'));
  assert.match(update.sql,/actual_arrival=case when \$1='Completado'/);
  assert.equal(pool.calls.some(call=>/\b(update|insert into)\s+trucks\b/i.test(call.sql)),false);
  assert.equal(pool.calls.some(call=>/ubicaci[oó]n|location|retorno|base/i.test(call.sql)),false);
  assert.deepEqual(res.payload,after);
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

test('trip_loads: creación válida autoriza viaje y cliente antes de insertar y auditar',async()=>{
  const trip={id:7,company_id:10};
  const created={id:23,trip_id:7,client_id:8,guide:'G-100',cargo:'Fruta',weight_kg:1200,volume_m3:8,value_clp:450000,origin:'Talca',destination:'Santiago',status:'Planificada'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.includes('select id,company_id from trips t'))return {rowCount:1,rows:[trip]};
    if(sql.startsWith('select id from clients'))return {rowCount:1,rows:[{id:8}]};
    if(sql.startsWith('insert into trip_loads'))return {rowCount:1,rows:[created]};
    if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const body={client_id:8,guide:' G-100 ',cargo:' Fruta ',weight_kg:1200,volume_m3:8,value_clp:450000,origin:' Talca ',destination:' Santiago ',status:'Planificada'};
  const {res}=await invoke(app.route('post','/api/operations/trips/:id/loads'),{body});
  assert.equal(res.statusCode,201);
  assert.deepEqual(res.payload,created);
  const tripLookup=pool.calls.find(call=>call.sql.includes('select id,company_id from trips t'));
  assert.match(tripLookup.sql,/t\.id=\$1 and t\.company_id=\$2/);
  assert.deepEqual(tripLookup.values,['7',10]);
  const clientLookup=pool.calls.find(call=>call.sql.startsWith('select id from clients'));
  assert.deepEqual(clientLookup.values,[8,10]);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into trip_loads'));
  assert.match(insert.sql,/trip_id,client_id,guide,cargo,weight_kg,volume_m3,value_clp,origin,destination,status/);
  assert.deepEqual(insert.values,['7',8,'G-100','Fruta',1200,8,450000,'Talca','Santiago','Planificada']);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,7),[10,5,'create','trip_load','23',null,created]);
  assert.ok(indexOf(pool.calls,'select id,company_id from trips t')<indexOf(pool.calls,'select id from clients'));
  assert.ok(indexOf(pool.calls,'select id from clients')<indexOf(pool.calls,'insert into trip_loads'));
  assert.ok(indexOf(pool.calls,'insert into trip_loads')<indexOf(pool.calls,'insert into audit_logs'));
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
  assert.equal(pool.calls.filter(call=>call.sql.startsWith('insert into trip_loads')).length,1);
  assert.equal(pool.calls.filter(call=>call.sql.startsWith('insert into audit_logs')).length,1);
});

for(const scenario of ['cross-company','inexistente']){
  test(`trip_loads: cliente ${scenario} devuelve 403 sin carga ni auditoría`,async()=>{
    const pool=transactionalPool(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('select id,company_id from trips t'))return {rowCount:1,rows:[{id:7,company_id:10}]};
      if(sql.startsWith('select id from clients'))return {rowCount:0,rows:[]};
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const app=fakeApp();await registerOperationsRoutes(app,pool);
    const {res}=await invoke(app.route('post','/api/operations/trips/:id/loads'),{body:{cargo:'Carga',client_id:99}});
    assert.equal(res.statusCode,403);
    assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:call.sql.startsWith('select id from clients')?'CLIENT':'TRIP'),['BEGIN','TRIP','CLIENT','ROLLBACK']);
    assert.deepEqual(pool.calls[2].values,[99,10]);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_loads')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
    assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  });
}

for(const scenario of ['cross-company','inexistente']){
  test(`trip_loads: viaje ${scenario} devuelve 404 sin consultas hijas`,async()=>{
    const pool=transactionalPool(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('select id,company_id from trips t'))return {rowCount:0,rows:[]};
      throw new Error(`Consulta hija inesperada: ${sql}`);
    });
    const app=fakeApp();await registerOperationsRoutes(app,pool);
    const {res}=await invoke(app.route('post','/api/operations/trips/:id/loads'),{body:{cargo:'Carga',client_id:8}});
    assert.equal(res.statusCode,404);
    assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:'TRIP'),['BEGIN','TRIP','ROLLBACK']);
    assert.match(pool.calls[1].sql,/t\.id=\$1 and t\.company_id=\$2/);
    assert.deepEqual(pool.calls[1].values,['7',10]);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('select id from clients')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into trip_loads')),false);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
    assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  });
}

test('trip_loads: fallo del INSERT ejecuta ROLLBACK sin auditoría ni COMMIT',async()=>{
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.includes('select id,company_id from trips t'))return {rowCount:1,rows:[{id:7,company_id:10}]};
    if(sql.startsWith('insert into trip_loads'))throw new Error('insert failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/operations/trips/:id/loads'),{body:{cargo:'Carga'}});
  assert.equal(res.statusCode,400);
  assert.ok(indexOf(pool.calls,'insert into trip_loads')<indexOf(pool.calls,'ROLLBACK'));
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('trip_loads: fallo de auditoría revierte la carga sin COMMIT',async()=>{
  const created={id:23,trip_id:7,cargo:'Carga'};
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.includes('select id,company_id from trips t'))return {rowCount:1,rows:[{id:7,company_id:10}]};
    if(sql.startsWith('insert into trip_loads'))return {rowCount:1,rows:[created]};
    if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/operations/trips/:id/loads'),{body:{cargo:'Carga'}});
  assert.equal(res.statusCode,400);
  assert.ok(indexOf(pool.calls,'insert into trip_loads')<indexOf(pool.calls,'insert into audit_logs'));
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'ROLLBACK'));
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('trip_loads: admin conserva bypass del viaje y valida cliente contra la empresa del viaje',async()=>{
  const created={id:23,trip_id:7,client_id:8,cargo:'Carga'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.includes('select id,company_id from trips t'))return {rowCount:1,rows:[{id:7,company_id:20}]};
    if(sql.startsWith('select id from clients'))return {rowCount:1,rows:[{id:8}]};
    if(sql.startsWith('insert into trip_loads'))return {rowCount:1,rows:[created]};
    if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const user={id:1,role_code:'admin',company_id:null,permissions:[]};
  const {res}=await invoke(app.route('post','/api/operations/trips/:id/loads'),{user,body:{cargo:'Carga',client_id:8}});
  assert.equal(res.statusCode,201);
  const tripLookup=pool.calls.find(call=>call.sql.includes('select id,company_id from trips t'));
  assert.match(tripLookup.sql,/t\.id=\$1 and true/);
  assert.deepEqual(tripLookup.values,['7']);
  const clientLookup=pool.calls.find(call=>call.sql.startsWith('select id from clients'));
  assert.deepEqual(clientLookup.values,[8,20]);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[20,1,'create','trip_load','23']);
});

test('trip_loads: detalle autoriza el viaje antes de devolver loads filtradas por trip_id',async()=>{
  const load={id:23,trip_id:7,cargo:'Carga A'};
  const pool=transactionalPool(async(sql,values,calls)=>{
    if(sql.includes('from trips t left join trucks'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Asignado'}]};
    if(sql.startsWith('select * from trip_loads')){
      assert.equal(calls.length>1,true);
      return {rowCount:1,rows:[load]};
    }
    if(sql.startsWith('select * from trip_events')||sql.startsWith('select * from trip_status_history')||sql.includes('from vehicle_checklists vc')||sql.startsWith('select * from trip_delivery_proofs'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta inesperada: ${sql} ${JSON.stringify(values)}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload.loads,[load]);
  const parentIndex=pool.calls.findIndex(call=>call.sql.includes('from trips t left join trucks'));
  const loadsIndex=pool.calls.findIndex(call=>call.sql.startsWith('select * from trip_loads'));
  assert.ok(parentIndex<loadsIndex);
  const loadsQuery=pool.calls[loadsIndex];
  assert.match(loadsQuery.sql,/where trip_id=\$1 order by id desc$/);
  assert.deepEqual(loadsQuery.values,['7']);
  assert.equal(res.payload.loads.some(item=>item.trip_id!==7),false);
});

test('loads legacy: creación conserva payload, audita y confirma en orden transaccional',async()=>{
  const created={id:31,company_id:10,client:'Cliente',guide:'G-1',cargo:'Carga',weight_kg:100,volume_m3:4,value_clp:90000,truck:null,origin:'A',destination:'B',status:'Planificada'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into loads'))return {rowCount:1,rows:[created]};
    if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const req={body:{client:'Cliente',guide:'G-1',cargo:'Carga',weight_kg:100,volume_m3:4,value_clp:90000,origin:'A',destination:'B'},resourceCompanyId:10,user:{id:5},ip:'127.0.0.1'};
  const res=response();await legacyLoadHandler()(req,res,pool);
  assert.equal(res.statusCode,201);
  assert.deepEqual(res.payload,created);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into loads'));
  assert.deepEqual(insert.values,[10,'Cliente','G-1','Carga',100,4,90000,null,'A','B','Planificada']);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,7),[10,5,'create','loads','31',null,created]);
  assert.ok(indexOf(pool.calls,'BEGIN')<indexOf(pool.calls,'insert into loads'));
  assert.ok(indexOf(pool.calls,'insert into loads')<indexOf(pool.calls,'insert into audit_logs'));
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'COMMIT'));
  assert.equal(pool.calls.filter(call=>call.sql.startsWith('insert into loads')).length,1);
  assert.equal(pool.calls.filter(call=>call.sql.startsWith('insert into audit_logs')).length,1);
});

test('loads legacy: fallo del INSERT ejecuta ROLLBACK sin auditoría ni COMMIT',async()=>{
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into loads'))throw new Error('insert failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const req={body:{cargo:'Carga'},resourceCompanyId:10,user:{id:5}};
  const res=response();await legacyLoadHandler()(req,res,pool);
  assert.equal(res.statusCode,400);
  assert.ok(indexOf(pool.calls,'insert into loads')<indexOf(pool.calls,'ROLLBACK'));
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('loads legacy: fallo de auditoría revierte la carga sin COMMIT',async()=>{
  const created={id:31,company_id:10,cargo:'Carga'};
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into loads'))return {rowCount:1,rows:[created]};
    if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const req={body:{cargo:'Carga'},resourceCompanyId:10,user:{id:5}};
  const res=response();await legacyLoadHandler()(req,res,pool);
  assert.equal(res.statusCode,400);
  assert.ok(indexOf(pool.calls,'insert into loads')<indexOf(pool.calls,'insert into audit_logs'));
  assert.ok(indexOf(pool.calls,'insert into audit_logs')<indexOf(pool.calls,'ROLLBACK'));
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('loads legacy: validación de camión se conserva antes de abrir la transacción',async()=>{
  const pool=transactionalPool(async(sql,values)=>{
    if(sql.startsWith('select id from trucks')){
      assert.deepEqual(values,['OTRA-1',10]);
      return {rowCount:0,rows:[]};
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const req={body:{cargo:'Carga',truck:'OTRA-1'},resourceCompanyId:10,user:{id:5}};
  const res=response();await legacyLoadHandler()(req,res,pool);
  assert.equal(res.statusCode,403);
  assert.equal(pool.calls.length,1);
  assert.equal(pool.calls.some(call=>call.sql==='BEGIN'),false);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into loads')),false);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);
});

test('loads legacy: conserva middleware de empresa y contexto transversal admin',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(source,/app\.post\("\/api\/loads",requirePermission\("loads\.manage"\),requireCreationCompany,/);
  assert.match(source,/const companyId=req=>\{const actor=resolveActorContext\(req\);if\(actor\?\.scope==='company'\)return actor\.company_id\|\|null;/);
  const created={id:31,company_id:20,cargo:'Carga'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into loads'))return {rowCount:1,rows:[created]};
    if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const req={body:{cargo:'Carga',company_id:20},resourceCompanyId:20,user:{id:1,role_code:'admin'}};
  const res=response();await legacyLoadHandler()(req,res,pool);
  assert.equal(res.statusCode,201);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into loads'));
  assert.equal(insert.values[0],20);
  const audit=auditCall(pool.calls);
  assert.deepEqual(audit.values.slice(0,5),[20,1,'create','loads','31']);
});

test('eventos, checklist, cargas y POD escriben audit_logs antes de COMMIT',async()=>{
  const cases=[
    ['post','/api/operations/trips/:id/events',{event_type:'Control'},'trip_event'],
    ['post','/api/operations/trips/:id/checklist',{truck_id:3,status:'Aprobado'},'vehicle_checklist'],
    ['post','/api/operations/trips/:id/loads',{cargo:'Carga'},'trip_load']
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

test('endpoint legacy de entrega no puede crear un POD CLOSED incompleto',async()=>{
  const pool=transactionalPool(async()=>{throw new Error('no debe consultar ni mutar');});
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/operations/trips/:id/deliver'),{body:{load_id:9,recipient_name:'Receptor'}});
  assert.equal(res.statusCode,410);
  assert.match(res.payload.error,/flujo moderno de evidencias/);
  assert.equal(pool.calls.length,0);
});

test('la interfaz administrativa no intenta usar el endpoint legacy de entrega',()=>{
  const operationsUi=fs.readFileSync(path.join(__dirname,'..','public','operations-ui.js'),'utf8');
  const appUi=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  assert.doesNotMatch(operationsUi,/operations\/trips\/\'+id\+'\/deliver/);
  assert.doesNotMatch(appUi,/operations\/trips\/\$\{id\}\/deliver/);
  assert.match(operationsUi,/POD debe registrarse desde la aplicación del conductor/);
  assert.match(appUi,/POD debe registrarse desde la aplicación del conductor/);
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
