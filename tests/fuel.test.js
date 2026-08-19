const test=require('node:test');
const assert=require('node:assert/strict');
const {registerFleetRoutes}=require('../fleet-api');

function fakeApp(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>{const route=routes.find(item=>item.method===method&&item.path===path);assert.ok(route,`Ruta no registrada: ${method} ${path}`);return route};return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,overrides={}){const req={user:{id:7,role_code:'operations',company_id:10,permissions:['fuel.manage']},body:{},query:{},params:{},ip:'127.0.0.1',...overrides};const res=response();let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};await next();return res}
function mockPool(resolver){const calls=[];let releases=0;const client={async query(sql,values=[]){const call={sql,values};calls.push(call);return resolver(sql,values,calls)},release(){releases++}};return {calls,client,get releases(){return releases},async connect(){return client},async query(sql,values=[]){const call={sql,values};calls.push(call);return resolver(sql,values,calls)}}}
async function fuelApp(pool){const app=fakeApp();await registerFleetRoutes(app,pool);return app}
const validBody={truck_id:3,date:'2026-08-19',liters:100,price_clp:1200,odometer_km:10500,station:'Copec'};

test('combustible crea una carga, calcula total y audita antes de COMMIT',async()=>{
  const created={id:41,company_id:10,date:'2026-08-19',truck:'ABCD12',truck_id:3,liters:'100',price_clp:'1200',total_clp:'120000',odometer_km:'10500',station:'Copec'};
  const pool=mockPool(async(sql,values)=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rows:[],rowCount:0};
    if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,10]);return {rows:[{id:3,company_id:10,patente:'ABCD12'}],rowCount:1}}
    if(sql.startsWith('insert into fuel')){assert.match(sql,/\$5\*\$6/);assert.deepEqual(values,[10,'2026-08-19','ABCD12',3,100,1200,'Copec',10500]);return {rows:[created],rowCount:1}}
    if(sql.startsWith('insert into audit_logs')){assert.equal(values[0],10);assert.equal(values[1],7);assert.equal(values[2],'create');assert.equal(values[3],'fuel');assert.equal(values[4],'41');assert.equal(values[6].total_clp,'120000');return {rows:[],rowCount:1}}
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=await fuelApp(pool);const res=await invoke(app.route('post','/api/fleet/fuel'),{body:{...validBody,total_clp:1}});
  assert.equal(res.statusCode,201);assert.equal(res.payload.truck_patente,'ABCD12');
  assert.deepEqual(pool.calls.map(call=>call.sql==='BEGIN'||call.sql==='COMMIT'?call.sql:call.sql.startsWith('select')?'TRUCK':call.sql.startsWith('insert into fuel')?'FUEL':'AUDIT'),['BEGIN','TRUCK','FUEL','AUDIT','COMMIT']);
  assert.equal(pool.releases,1);
});

test('combustible oculta camión inexistente o de otra empresa sin insertar',async()=>{
  const pool=mockPool(async sql=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[],rowCount:0};if(sql.startsWith('select id,company_id,patente from trucks'))return {rows:[],rowCount:0};throw new Error(`Consulta inesperada: ${sql}`)});
  const app=await fuelApp(pool);const res=await invoke(app.route('post','/api/fleet/fuel'),{body:validBody});
  assert.equal(res.statusCode,404);assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into fuel')),false);assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into audit_logs')),false);assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);assert.equal(pool.releases,1);
});

test('combustible mantiene company scope explícito para admin',async()=>{
  const pool=mockPool(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[],rowCount:0};if(sql.startsWith('select id,company_id,patente from trucks')){assert.deepEqual(values,[3,20]);return {rows:[{id:3,company_id:20,patente:'ADMIN20'}],rowCount:1}}if(sql.startsWith('insert into fuel'))return {rows:[{id:50,company_id:20,truck_id:3,total_clp:120000}],rowCount:1};if(sql.startsWith('insert into audit_logs')){assert.equal(values[0],20);return {rows:[],rowCount:1}}throw new Error(`Consulta inesperada: ${sql}`)});
  const app=await fuelApp(pool);const res=await invoke(app.route('post','/api/fleet/fuel'),{user:{id:1,role_code:'admin',company_id:null,permissions:[]},body:{...validBody,company_id:20}});
  assert.equal(res.statusCode,201);assert.equal(pool.releases,1);
});

test('combustible rechaza litros, precio, odómetro y fecha inválidos antes de conectar',async()=>{
  const pool={async connect(){throw new Error('No debe conectar')},async query(){throw new Error('No debe consultar')}};const app=await fuelApp(pool);const route=app.route('post','/api/fleet/fuel');
  const cases=[[{...validBody,liters:0},'liters debe ser mayor que cero'],[{...validBody,liters:-1},'liters debe ser mayor que cero'],[{...validBody,liters:[100]},'liters debe ser mayor que cero'],[{...validBody,price_clp:0},'price_clp debe ser mayor que cero'],[{...validBody,price_clp:'x'},'price_clp debe ser mayor que cero'],[{...validBody,odometer_km:-1},'odometer_km no válido'],[{...validBody,odometer_km:'x'},'odometer_km no válido'],[{...validBody,odometer_km:{}},'odometer_km no válido'],[{...validBody,date:'2026-02-30'},'Fecha no válida']];
  for(const [body,error] of cases){const res=await invoke(route,{body});assert.equal(res.statusCode,400);assert.deepEqual(res.payload,{error})}
});

test('combustible revierte si falla el INSERT',async()=>{
  const pool=mockPool(async sql=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[],rowCount:0};if(sql.startsWith('select id,company_id,patente from trucks'))return {rows:[{id:3,company_id:10,patente:'ABCD12'}],rowCount:1};if(sql.startsWith('insert into fuel'))throw new Error('insert failed');throw new Error(`Consulta inesperada: ${sql}`)});
  const app=await fuelApp(pool);const res=await invoke(app.route('post','/api/fleet/fuel'),{body:validBody});
  assert.equal(res.statusCode,400);assert.equal(pool.calls.at(-1).sql,'ROLLBACK');assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);assert.equal(pool.releases,1);
});

test('combustible revierte la carga si falla la auditoría',async()=>{
  const pool=mockPool(async sql=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[],rowCount:0};if(sql.startsWith('select id,company_id,patente from trucks'))return {rows:[{id:3,company_id:10,patente:'ABCD12'}],rowCount:1};if(sql.startsWith('insert into fuel'))return {rows:[{id:41,company_id:10,truck_id:3,total_clp:120000}],rowCount:1};if(sql.startsWith('insert into audit_logs'))throw new Error('audit failed');throw new Error(`Consulta inesperada: ${sql}`)});
  const app=await fuelApp(pool);const res=await invoke(app.route('post','/api/fleet/fuel'),{body:validBody});
  assert.equal(res.statusCode,400);assert.equal(pool.calls.at(-1).sql,'ROLLBACK');assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);assert.equal(pool.releases,1);
});

test('historial filtra camión y fechas con orden determinista',async()=>{
  const pool=mockPool(async(sql,values)=>{assert.match(sql,/f\.company_id=\$1 and f\.truck_id=\$2/);assert.match(sql,/q\.date >= \$3 and q\.date <= \$4/);assert.match(sql,/order by q\.date desc,q\.id desc limit 1000$/);assert.deepEqual(values,[10,3,'2026-08-01','2026-08-31']);return {rows:[],rowCount:0}});
  const app=await fuelApp(pool);const res=await invoke(app.route('get','/api/fleet/fuel'),{query:{truck_id:'3',from:'2026-08-01',to:'2026-08-31'}});
  assert.equal(res.statusCode,200);assert.deepEqual(res.payload,[]);
});

test('historial calcula rendimiento y costo por km de cargas consecutivas',async()=>{
  const rows=[{id:2,truck_id:3,truck_patente:'ABCD12',date:'2026-08-19',liters:'100',total_clp:'120000',odometer_km:'10500',previous_odometer_km:'10000'},{id:1,truck_id:3,truck_patente:'ABCD12',date:'2026-08-01',liters:'90',total_clp:'108000',odometer_km:'10000',previous_odometer_km:null}];
  const pool=mockPool(async()=>({rows,rowCount:2}));const app=await fuelApp(pool);const res=await invoke(app.route('get','/api/fleet/fuel'),{query:{include_summary:'true'}});
  assert.equal(res.statusCode,200);assert.equal(res.payload.records[0].distance_km,500);assert.equal(res.payload.records[0].efficiency_km_l,5);assert.equal(res.payload.records[0].cost_per_km,240);assert.equal(res.payload.records[1].efficiency_km_l,null);
});

test('historial no inventa métricas sin odómetro o con distancia no positiva',async()=>{
  const rows=[{id:3,truck_id:3,liters:'100',total_clp:'120000',odometer_km:null,previous_odometer_km:'10000'},{id:2,truck_id:3,liters:'100',total_clp:'120000',odometer_km:'9900',previous_odometer_km:'10000'}];
  const pool=mockPool(async()=>({rows,rowCount:2}));const app=await fuelApp(pool);const res=await invoke(app.route('get','/api/fleet/fuel'),{query:{include_summary:'true'}});
  for(const row of res.payload.records){assert.equal(row.distance_km,null);assert.equal(row.efficiency_km_l,null);assert.equal(row.cost_per_km,null)}
  assert.equal(res.payload.totals.efficiency_km_l,null);assert.equal(res.payload.totals.cost_per_km,null);
});

test('resumen por camión agrega cargas y solo usa tramos calculables',async()=>{
  const rows=[{id:3,truck_id:3,truck_patente:'ABCD12',liters:'100',total_clp:'120000',odometer_km:'11000',previous_odometer_km:'10500'},{id:2,truck_id:3,truck_patente:'ABCD12',liters:'100',total_clp:'120000',odometer_km:'10500',previous_odometer_km:'10000'},{id:1,truck_id:3,truck_patente:'ABCD12',liters:'90',total_clp:'108000',odometer_km:'10000',previous_odometer_km:null},{id:4,truck_id:null,truck:'Legacy',liters:'50',total_clp:'60000',odometer_km:null,previous_odometer_km:null}];
  const pool=mockPool(async()=>({rows,rowCount:4}));const app=await fuelApp(pool);const res=await invoke(app.route('get','/api/fleet/fuel'),{query:{include_summary:'true'}});
  assert.equal(res.payload.summary.length,1);assert.deepEqual(res.payload.summary[0],{truck_id:3,patente:'ABCD12',loads_count:3,total_liters:290,total_cost_clp:348000,calculable_distance_km:1000,calculable_liters:200,calculable_cost_clp:240000,efficiency_km_l:5,cost_per_km:240});assert.equal(res.payload.totals.loads_count,4);assert.equal(res.payload.totals.total_liters,340);assert.equal(res.payload.totals.total_cost_clp,408000);
});
