const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {registerOperationsRoutes}=require('../operations-api');

function fakeApp(){
  const routes=[];
  for(const method of ['get','post','put','patch','delete'])routes[method]=(routePath,...handlers)=>routes.push({method,path:routePath,handlers});
  routes.route=(method,routePath)=>{
    const route=routes.find(item=>item.method===method&&item.path===routePath);
    assert.ok(route,`Ruta no registrada: ${method.toUpperCase()} ${routePath}`);
    return route;
  };
  return routes;
}

function response(){
  return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}};
}

async function invoke(route,overrides={}){
  const req={user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage','fleet.manage']},params:{id:'7'},body:{},query:{},...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

function transactionalPool(resolver){
  const calls=[];
  let releases=0;
  const client={
    async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)},
    release(){releases++}
  };
  return {calls,client,get releases(){return releases},async query(sql,values=[]){return client.query(sql,values)},async connect(){return client}};
}

function legacyLocationHandler(){
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const start=source.indexOf('const parseLegacyCoordinate');
  const handlerStart=source.indexOf('async function updateLegacyTruckLocation',start);
  const end=source.indexOf('\n}\n',handlerStart)+2;
  assert.ok(start>=0&&handlerStart>start&&end>handlerStart,'No se pudo aislar updateLegacyTruckLocation');
  return Function('isAdmin','companyId',`${source.slice(start,end)};return updateLegacyTruckLocation;`)(req=>req.user?.role_code==='admin',req=>req.user?.company_id||null);
}

const invokeLegacy=(pool,body)=>invoke({handlers:[(req,res)=>legacyLocationHandler()(req,res,pool)]},{body});

test('detalle operacional conserva identidad y estado del checklist sin colisiones',async()=>{
  const checklist={id:81,truck_id:3,driver_id:4,trip_id:7,checklist_type:'Preoperacional',status:'Aprobado',items:[],observations:'OK',completed_at:'2026-08-18T12:00:00.000Z',created_at:'2026-08-18T11:55:00.000Z',driver_name:'Juan Pérez',patente:'ABCD12'};
  let checklistQuery;
  const pool=transactionalPool(async(sql,values)=>{
    if(sql.includes('from trips t left join trucks'))return {rowCount:1,rows:[{id:7,company_id:10,status:'Asignado'}]};
    if(sql.includes('from vehicle_checklists vc')){checklistQuery={sql,values};return {rowCount:1,rows:[checklist]}}
    if(sql.startsWith('select * from trip_events')||sql.startsWith('select * from trip_status_history')||sql.startsWith('select * from trip_loads')||sql.startsWith('select * from trip_delivery_proofs'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerOperationsRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/operations/trips/:id'));
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.checklists[0].id,81);
  assert.equal(res.payload.checklists[0].status,'Aprobado');
  assert.equal(res.payload.checklists[0].driver_name,'Juan Pérez');
  assert.equal(res.payload.checklists[0].patente,'ABCD12');
  assert.match(checklistQuery.sql,/select vc\.\*,d\.name as driver_name,tr\.patente as patente from vehicle_checklists vc/);
  assert.doesNotMatch(checklistQuery.sql,/select \* from vehicle_checklists/);
  assert.deepEqual(checklistQuery.values,['7']);
});

test('GPS legacy confirma UPDATE e historial en una sola transacción',async()=>{
  const updated={id:7,company_id:10,lat:-33.45,lng:-70.66,km:12500,location:'Santiago',status:'Disponible'};
  const pool=transactionalPool(async sql=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.startsWith('update trucks set'))return {rowCount:1,rows:[updated]};
    if(sql.startsWith('insert into telemetry'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const {res}=await invokeLegacy(pool,{lat:-33.45,lng:-70.66,km:12500,location:'Santiago'});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,updated);
  assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='COMMIT'?call.sql:call.sql.startsWith('update trucks')?'UPDATE':'INSERT'),['BEGIN','UPDATE','INSERT','COMMIT']);
  assert.equal(pool.releases,1);
});

test('GPS legacy revierte y libera el cliente cuando falla el UPDATE',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('update trucks set'))throw new Error('update failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const {res}=await invokeLegacy(pool,{lat:-33.45,lng:-70.66});
  assert.equal(res.statusCode,400);
  assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:'UPDATE'),['BEGIN','UPDATE','ROLLBACK']);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.releases,1);
});

test('GPS legacy revierte el UPDATE si falla el historial telemetry',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('update trucks set'))return {rowCount:1,rows:[{id:7,company_id:10,km:12000}]};
    if(sql.startsWith('insert into telemetry'))throw new Error('telemetry failed');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const {res}=await invokeLegacy(pool,{lat:-33.45,lng:-70.66});
  assert.equal(res.statusCode,400);
  assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:call.sql.startsWith('update trucks')?'UPDATE':'INSERT'),['BEGIN','UPDATE','INSERT','ROLLBACK']);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  assert.equal(pool.releases,1);
});

test('GPS legacy devuelve 404 con rollback y libera el cliente',async()=>{
  const pool=transactionalPool(async sql=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('update trucks set'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const {res}=await invokeLegacy(pool,{lat:-33.45,lng:-70.66});
  assert.equal(res.statusCode,404);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into telemetry')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  assert.equal(pool.releases,1);
});

test('GPS legacy rechaza coordenadas inválidas sin abrir conexión ni escribir',async()=>{
  const pool={async connect(){throw new Error('No debe abrir conexión')}};
  const invalid=[
    {lat:91,lng:-70.66},
    {lat:-91,lng:-70.66},
    {lat:-33.45,lng:181},
    {lat:-33.45,lng:-181},
    {lat:'norte',lng:-70.66},
    {lat:-33.45,lng:'oeste'},
    {lat:false,lng:-70.66},
    {lat:true,lng:-70.66},
    {lat:[],lng:-70.66},
    {lat:[10],lng:-70.66},
    {lat:{},lng:-70.66},
    {lat:'',lng:-70.66},
    {lat:Number.NaN,lng:-70.66},
    {lat:Number.POSITIVE_INFINITY,lng:-70.66},
    {lat:Number.NEGATIVE_INFINITY,lng:-70.66}
  ];
  for(const body of invalid){
    const {res}=await invokeLegacy(pool,body);
    assert.equal(res.statusCode,400);
    assert.deepEqual(res.payload,{error:'lat o lng no válidos'});
  }
});

test('GPS legacy conserva mensaje para coordenadas ausentes o null sin abrir conexión',async()=>{
  const pool={async connect(){throw new Error('No debe abrir conexión')}};
  for(const body of [{lat:null,lng:-70.66},{lat:-33.45,lng:null},{lng:-70.66},{lat:-33.45}]){
    const {res}=await invokeLegacy(pool,body);
    assert.equal(res.statusCode,400);
    assert.deepEqual(res.payload,{error:'lat y lng son obligatorios'});
  }
});

test('GPS legacy acepta coordenadas numéricas válidas en los límites',async()=>{
  for(const body of [{lat:-90,lng:-180},{lat:90,lng:180},{lat:'-33.45',lng:'-70.66'}]){
    const pool=transactionalPool(async sql=>{
      if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
      if(sql.startsWith('update trucks set'))return {rowCount:1,rows:[{id:7,company_id:10,km:0}]};
      if(sql.startsWith('insert into telemetry'))return {rowCount:1,rows:[]};
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    const {res}=await invokeLegacy(pool,body);
    assert.equal(res.statusCode,200);
    assert.equal(pool.calls.at(-1).sql,'COMMIT');
    assert.equal(pool.releases,1);
  }
});
