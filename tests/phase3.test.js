const test=require('node:test');
const assert=require('node:assert/strict');
const {registerFleetRoutes}=require('../fleet-api');

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
  const req={user:{id:5,role_code:'operations',company_id:10,permissions:['fleet.manage','gps.read']},params:{id:'3'},body:{},query:{},...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

function transactionalPool(resolver){
  const calls=[];
  const client={calls,async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)},release(){}};
  return {calls,client,async query(sql,values=[]){return client.query(sql,values)},async connect(){return client}};
}

test('GPS registra una posición válida para un camión de la empresa',async()=>{
  const position={id:91,truck_id:3,trip_id:null,lat:-33.45,lng:-70.66,speed_kmh:35,km:12500,recorded_at:'2026-08-18T12:00:00.000Z'};
  const truck={id:3,company_id:10,lat:-33.45,lng:-70.66,km:12500,location:'Santiago'};
  const pool=transactionalPool(async(sql)=>{
    if(['BEGIN','COMMIT'].includes(sql))return {rowCount:0,rows:[]};
    if(sql.startsWith('select id,company_id,km,status from trucks'))return {rowCount:1,rows:[{id:3,company_id:10,km:12000,status:'Disponible'}]};
    if(sql.startsWith('insert into telemetry'))return {rowCount:1,rows:[position]};
    if(sql.startsWith('update trucks set'))return {rowCount:1,rows:[truck]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerFleetRoutes(app,pool);
  const body={truck_id:3,lat:-33.45,lng:-70.66,speed_kmh:35,km:12500,location:'Santiago',recorded_at:'2026-08-18T12:00:00Z'};
  const {res}=await invoke(app.route('post','/api/fleet/positions'),{body});
  assert.equal(res.statusCode,201);
  assert.deepEqual(res.payload,{position,truck});
  const lookup=pool.calls.find(call=>call.sql.startsWith('select id,company_id,km,status from trucks'));
  assert.match(lookup.sql,/id=\$1 and company_id=\$2 for update$/);
  assert.deepEqual(lookup.values,[3,10]);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into telemetry'));
  assert.deepEqual(insert.values,[3,null,-33.45,-70.66,35,12500,'2026-08-18T12:00:00.000Z']);
  assert.ok(pool.calls.findIndex(call=>call.sql==='BEGIN')<pool.calls.indexOf(insert));
  assert.ok(pool.calls.indexOf(insert)<pool.calls.findIndex(call=>call.sql==='COMMIT'));
});

test('GPS consulta la última posición registrada del camión',async()=>{
  const position={id:92,truck_id:3,trip_id:null,lat:-33.44,lng:-70.65,speed_kmh:0,km:12510,recorded_at:'2026-08-18T12:05:00.000Z'};
  const pool=transactionalPool(async(sql,values)=>{
    assert.match(sql,/from telemetry te join trucks t/);
    assert.match(sql,/te\.truck_id=\$1 and t\.company_id=\$2/);
    assert.match(sql,/order by te\.recorded_at desc,te\.id desc limit 1$/);
    assert.deepEqual(values,[3,10]);
    return {rowCount:1,rows:[position]};
  });
  const app=fakeApp();await registerFleetRoutes(app,pool);
  const {res}=await invoke(app.route('get','/api/fleet/trucks/:id/position'));
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,position);
  assert.equal(pool.calls.length,1);
});

test('GPS rechaza registrar posición para un camión de otra empresa',async()=>{
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('select id,company_id,km,status from trucks'))return {rowCount:0,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();await registerFleetRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/fleet/positions'),{body:{truck_id:3,lat:-33.45,lng:-70.66}});
  assert.equal(res.statusCode,404);
  assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='ROLLBACK'?call.sql:'TRUCK'),['BEGIN','TRUCK','ROLLBACK']);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into telemetry')),false);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});

test('GPS rechaza coordenadas fuera de rango antes de consultar PostgreSQL',async()=>{
  const pool={async query(){throw new Error('No debe consultar PostgreSQL')},async connect(){throw new Error('No debe abrir conexión')}};
  const app=fakeApp();await registerFleetRoutes(app,pool);
  const route=app.route('post','/api/fleet/positions');
  for(const body of [{truck_id:3,lat:91,lng:-70.66},{truck_id:3,lat:-33.45,lng:181}]){
    const {res}=await invoke(route,{body});
    assert.equal(res.statusCode,400);
    assert.deepEqual(res.payload,{error:'latitud o longitud no válidas'});
  }
});
