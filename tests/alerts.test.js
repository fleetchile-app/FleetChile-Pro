const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {registerFleetRoutes}=require('../fleet-api');

function fakeApp(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>{const route=routes.find(item=>item.method===method&&item.path===path);assert.ok(route,`Ruta no registrada: ${method} ${path}`);return route};return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,overrides={}){const req={user:{id:7,role_code:'maintenance',company_id:10,permissions:['dashboard.read','fleet.manage']},body:{},query:{},params:{id:'5'},ip:'127.0.0.1',...overrides};const res=response();let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};await next();return res}
function mockPool(resolver){const calls=[];let releases=0;const client={async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)},release(){releases++}};return {calls,get releases(){return releases},async connect(){return client},async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)}}}
async function alertApp(pool){const app=fakeApp();await registerFleetRoutes(app,pool);return app}

test('migración protege concurrencia con identidad estructurada y conserva legacy nullable',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'..','migrations','014_operational_alerts.sql'),'utf8');assert.match(sql,/add column if not exists source_type text/i);assert.match(sql,/add column if not exists source_id bigint/i);assert.match(sql,/create unique index if not exists uq_alerts_active_condition/i);assert.match(sql,/company_id, source_type, source_id, condition_code/i);assert.match(sql,/where resolved = false/i);assert.doesNotMatch(sql,/update alerts set source_type/i);
});

function generatorPool({inserted=true,active=[],failAt=null,maintenance=true}={}){
 const insertedAlerts=[];
 const pool=mockPool(async(sql,values)=>{
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],rowCount:0};
  if(sql.includes("setting_key='notifications.maintenance_alerts'"))return {rows:[{value:maintenance}],rowCount:1};
  if(sql.startsWith('select m.id,m.item')){assert.deepEqual(values,[10]);assert.match(sql,/m\.status not in \('Completada','Cancelada'\)/);assert.match(sql,/next_due_date<=current_date\+7/);return {rows:[{id:1,item:'Aceite',next_due_date:'2026-08-25',overdue_date:false,next_due_odometer_km:null,patente:'AAA111',km:1000},{id:2,item:'Frenos',next_due_date:'2026-08-01',overdue_date:true,next_due_odometer_km:null,patente:'BBB222',km:2000},{id:3,item:'Motor',next_due_date:null,overdue_date:null,next_due_odometer_km:3000,patente:'CCC333',km:3100}],rowCount:3}}
  if(sql.startsWith("select id,patente from trucks")){assert.deepEqual(values,[10]);return {rows:[{id:9,patente:'TRK999'}],rowCount:1}}
  if(sql.startsWith('select vd.id')){assert.match(sql,/join trucks t/);assert.match(sql,/t\.company_id=\$1/);return {rows:[{id:11,document_type:'Revisión técnica',expires_at:'2026-08-25',expired:false,patente:'AAA111'},{id:12,document_type:'Permiso',expires_at:'2026-08-01',expired:true,patente:'BBB222'}],rowCount:2}}
  if(sql.startsWith('select dd.id')){assert.match(sql,/join drivers d/);assert.match(sql,/d\.company_id=\$1/);return {rows:[{id:21,document_type:'Licencia',expires_at:'2026-08-25',expired:false,driver_name:'Ana'},{id:22,document_type:'Licencia',expires_at:'2026-08-01',expired:true,driver_name:'Luis'}],rowCount:2}}
  if(sql.startsWith('insert into alerts')){if(failAt==='insert')throw new Error('insert failed');assert.match(sql,/on conflict \(company_id,source_type,source_id,condition_code\)/);assert.match(sql,/where resolved=false/);insertedAlerts.push({level:values[1],source_type:values[4],source_id:values[5],condition_code:values[6]});return inserted?{rows:[{id:100+insertedAlerts.length,company_id:10,...insertedAlerts.at(-1),resolved:false}],rowCount:1}:{rows:[],rowCount:0}}
  if(sql.startsWith('select id,source_type')){assert.match(sql,/source_type is not null/);assert.match(sql,/condition_code=any/);return {rows:active,rowCount:active.length}}
  if(sql.startsWith('update alerts set resolved=true,resolved_at=now()'))return {rows:[{id:values[0],resolved:true,resolved_at:'2026-08-20T00:00:00Z'}],rowCount:1};
  throw new Error(`Consulta inesperada: ${sql}`);
 });
 pool.insertedAlerts=insertedAlerts;return pool;
}

test('generador crea mantenciones próximas, vencidas por fecha/odómetro y camión en Mantención',async()=>{
 const pool=generatorPool();const app=await alertApp(pool);const res=await invoke(app.route('post','/api/fleet/alerts/generate'));
 assert.equal(res.statusCode,200);const codes=pool.insertedAlerts.map(x=>x.condition_code);for(const code of ['maintenance_due_date','maintenance_overdue_date','maintenance_overdue_odometer','truck_maintenance_status'])assert.ok(codes.includes(code));assert.equal(pool.insertedAlerts.find(x=>x.condition_code==='maintenance_due_date').level,'warning');assert.equal(pool.insertedAlerts.find(x=>x.condition_code==='maintenance_overdue_date').level,'critical');assert.equal(pool.insertedAlerts.find(x=>x.condition_code==='maintenance_overdue_odometer').level,'critical');assert.equal(pool.calls[0].sql,'BEGIN');assert.equal(pool.calls.at(-1).sql,'COMMIT');assert.equal(pool.releases,1);
});

test('generador crea documentos próximos/vencidos con company scope de vehículo y conductor',async()=>{
 const pool=generatorPool();const app=await alertApp(pool);await invoke(app.route('post','/api/fleet/alerts/generate'));const codes=pool.insertedAlerts.map(x=>x.condition_code);for(const code of ['vehicle_document_due','vehicle_document_expired','driver_document_due','driver_document_expired'])assert.ok(codes.includes(code));for(const alert of pool.insertedAlerts.filter(x=>x.condition_code.endsWith('_expired')))assert.equal(alert.level,'critical');for(const alert of pool.insertedAlerts.filter(x=>x.condition_code.endsWith('_due')))assert.equal(alert.level,'warning');
});

test('generador respeta setting de mantenciones y no consulta condiciones deshabilitadas',async()=>{
 const pool=generatorPool({maintenance:false});const app=await alertApp(pool);await invoke(app.route('post','/api/fleet/alerts/generate'));assert.equal(pool.calls.some(c=>c.sql.startsWith('select m.id,m.item')),false);assert.equal(pool.insertedAlerts.some(x=>x.source_type==='maintenance'),false);assert.equal(pool.insertedAlerts.some(x=>x.source_type==='truck'),true);
});

test('deduplicación usa índice parcial y una segunda ejecución no crea duplicados',async()=>{
 const pool=generatorPool({inserted:false});const app=await alertApp(pool);const res=await invoke(app.route('post','/api/fleet/alerts/generate'));assert.equal(res.payload.created,0);assert.equal(res.payload.alerts.length,0);assert.ok(pool.calls.filter(c=>c.sql.startsWith('insert into alerts')).every(c=>c.sql.includes('on conflict')));
});

test('generador resuelve condición estructurada desaparecida sin tocar alertas legacy',async()=>{
 const stale={id:77,source_type:'maintenance',source_id:999,condition_code:'maintenance_overdue_date'};const pool=generatorPool({active:[stale]});const app=await alertApp(pool);const res=await invoke(app.route('post','/api/fleet/alerts/generate'));assert.equal(res.payload.resolved,1);assert.ok(pool.calls.some(c=>c.sql.startsWith('update alerts set resolved=true,resolved_at=now()')&&c.values[0]===77));const activeQuery=pool.calls.find(c=>c.sql.startsWith('select id,source_type'));assert.match(activeQuery.sql,/source_type is not null/);assert.match(activeQuery.sql,/source_id is not null/);
});

test('generador confirma atomicidad y revierte por error sin COMMIT',async()=>{
 const pool=generatorPool({failAt:'insert'});const app=await alertApp(pool);const res=await invoke(app.route('post','/api/fleet/alerts/generate'));assert.equal(res.statusCode,500);assert.equal(pool.calls.at(-1).sql,'ROLLBACK');assert.equal(pool.calls.some(c=>c.sql==='COMMIT'),false);assert.equal(pool.releases,1);
});

test('GET filtra alertas con company scope y orden determinista',async()=>{
 const pool=mockPool(async(sql,values)=>{assert.match(sql,/a\.company_id=\$1/);assert.match(sql,/a\.resolved=\$2/);assert.match(sql,/a\.level=\$3/);assert.match(sql,/a\.source_type=\$4/);assert.match(sql,/a\.condition_code=\$5/);assert.match(sql,/a\.created_at::date >= \$6/);assert.match(sql,/a\.created_at::date <= \$7/);assert.match(sql,/q\.truck_id=\$8/);assert.match(sql,/order by q\.resolved asc,q\.created_at desc,q\.id desc/);assert.deepEqual(values,[10,false,'critical','maintenance','maintenance_overdue_date','2026-08-01','2026-08-31',3]);return {rows:[],rowCount:0}});const app=await alertApp(pool);const res=await invoke(app.route('get','/api/fleet/alerts'),{query:{resolved:'false',level:'critical',source_type:'maintenance',condition_code:'maintenance_overdue_date',from:'2026-08-01',to:'2026-08-31',truck_id:'3'}});assert.equal(res.statusCode,200);assert.deepEqual(res.payload,[]);
});

test('GET devuelve colección vacía sin inventar alertas',async()=>{const pool=mockPool(async()=>({rows:[],rowCount:0}));const app=await alertApp(pool);const res=await invoke(app.route('get','/api/fleet/alerts'));assert.equal(res.statusCode,200);assert.deepEqual(res.payload,[])});

test('resolución manual bloquea, aplica company scope, registra resolved_at y confirma',async()=>{
 const pool=mockPool(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[],rowCount:0};if(sql.includes('from alerts a')){assert.match(sql,/a\.company_id=\$2/);assert.match(sql,/for update/);assert.deepEqual(values,['5',10]);return {rows:[{id:5,company_id:10,resolved:false}],rowCount:1}}if(sql.startsWith('update alerts')){assert.match(sql,/resolved_at=coalesce\(resolved_at,now\(\)\)/);return {rows:[{id:5,company_id:10,resolved:true,resolved_at:'2026-08-20T00:00:00Z'}],rowCount:1}}throw new Error(`Consulta inesperada: ${sql}`)});const app=await alertApp(pool);const res=await invoke(app.route('post','/api/fleet/alerts/:id/resolve'));assert.equal(res.statusCode,200);assert.equal(res.payload.resolved,true);assert.ok(res.payload.resolved_at);assert.equal(pool.calls.at(-1).sql,'COMMIT');assert.equal(pool.releases,1);
});

test('resolución manual oculta alerta cross-company y no hace COMMIT',async()=>{
 const pool=mockPool(async sql=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[],rowCount:0};if(sql.includes('from alerts a'))return {rows:[],rowCount:0};throw new Error(`Consulta inesperada: ${sql}`)});const app=await alertApp(pool);const res=await invoke(app.route('post','/api/fleet/alerts/:id/resolve'));assert.equal(res.statusCode,404);assert.equal(pool.calls.some(c=>c.sql.startsWith('update alerts')),false);assert.equal(pool.calls.some(c=>c.sql==='COMMIT'),false);assert.equal(pool.releases,1);
});
