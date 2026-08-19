const test=require('node:test');
const assert=require('node:assert/strict');
const {registerEconomicsRoutes}=require('../economics-api');

function fakeApp(){const routes=[];for(const method of ['get','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>{const route=routes.find(x=>x.method===method&&x.path===path);assert.ok(route,`Ruta no registrada: ${method} ${path}`);return route};return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,overrides={}){const req={user:{id:7,role_code:'operations',company_id:10,permissions:['economics.read','economics.manage']},params:{id:'31'},query:{},body:{},ip:'127.0.0.1',...overrides};const res=response();let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};await next();return res}
function mockPool(resolver){const calls=[];let releases=0;const client={async query(sql,values=[]){calls.push({source:'client',sql,values});return resolver(sql,values,calls)},release(){releases++}};return {calls,get releases(){return releases},async connect(){return client},async query(sql,values=[]){calls.push({source:'pool',sql,values});return resolver(sql,values,calls)}}}
async function economicsApp(pool){const app=fakeApp();registerEconomicsRoutes(app,pool);return app}
const trip={id:31,company_id:10,revenue_clp:'150000',actual_departure:null,status:'Planificado'};
const profile={trip_id:31,company_id:10,revenue_defined:true,revenue_includes_vat:true,revenue_confirmed_by:7,revenue_confirmed_at:'2026-08-19T15:00:00Z',economic_status:'open'};

function successfulMutationPool({existingProfile=null,failAt=null,started=false}={}){
 return mockPool(async(sql,values)=>{
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],rowCount:0};
  if(sql.startsWith('select id,company_id,revenue_clp,actual_departure,status from trips'))return {rows:[{...trip,actual_departure:started?'2026-08-19T12:00:00Z':null}],rowCount:1};
  if(sql.startsWith('select * from trip_economic_profiles'))return {rows:existingProfile?[existingProfile]:[],rowCount:existingProfile?1:0};
  if(sql.startsWith('insert into trip_economic_profiles')){if(failAt==='profile')throw Error('profile');return {rows:[profile],rowCount:1}}
  if(sql.startsWith('insert into trip_revenue_history')){if(failAt==='history')throw Error('history');return {rows:[],rowCount:1}}
  if(sql.startsWith('update trips set revenue_clp')){if(failAt==='trip')throw Error('trip');return {rows:[],rowCount:1}}
  if(sql.startsWith('insert into audit_logs')){if(failAt==='audit')throw Error('audit');return {rows:[],rowCount:1}}
  throw Error(`Consulta inesperada: ${sql} ${JSON.stringify(values)}`);
 });
}

test('GET económico distingue viaje con ingreso confirmado en la misma empresa',async()=>{
 const pool=mockPool(async(sql,values)=>{assert.match(sql,/where t\.id=\$1 and t\.company_id=\$2/);assert.deepEqual(values,['31',10]);return {rows:[{...trip,...profile,economic_profile_trip_id:31}],rowCount:1}});
 const app=await economicsApp(pool);const res=await invoke(app.route('get','/api/economics/trips/:id'));
 assert.equal(res.statusCode,200);assert.equal(res.payload.revenue_defined,true);assert.equal(res.payload.revenue_status,'confirmed_positive');assert.equal(res.payload.legacy_unverified,false);assert.equal(res.payload.revenue_includes_vat,true);
});

test('GET no revela un viaje de otra empresa',async()=>{
 const pool=mockPool(async(sql,values)=>{assert.deepEqual(values,['31',10]);return {rows:[],rowCount:0}});const app=await economicsApp(pool);
 const res=await invoke(app.route('get','/api/economics/trips/:id'));assert.equal(res.statusCode,404);assert.equal(res.payload,undefined);
});

test('viewer con economics.read puede leer y usuario sin permiso recibe 403',async()=>{
 const pool=mockPool(async()=>({rows:[{...trip,economic_profile_trip_id:null}],rowCount:1}));const app=await economicsApp(pool);const route=app.route('get','/api/economics/trips/:id');
 const viewer=await invoke(route,{user:{id:8,role_code:'viewer',company_id:10,permissions:['economics.read']}});assert.equal(viewer.statusCode,200);
 const denied=await invoke(route,{user:{id:9,role_code:'maintenance',company_id:10,permissions:[]}});assert.equal(denied.statusCode,403);assert.equal(pool.calls.length,1);
});

test('legacy sin perfil conserva el valor pero queda no verificado y no hace backfill',async()=>{
 const pool=mockPool(async()=>({rows:[{...trip,economic_profile_trip_id:null}],rowCount:1}));const app=await economicsApp(pool);
 const res=await invoke(app.route('get','/api/economics/trips/:id'));assert.deepEqual({value:res.payload.revenue_clp,defined:res.payload.revenue_defined,status:res.payload.revenue_status,legacy:res.payload.legacy_unverified},{value:150000,defined:false,status:'legacy_unverified',legacy:true});assert.equal(pool.calls.some(x=>/^insert|^update/i.test(x.sql)),false);
});

test('operations y manager definen ingreso antes del inicio con permiso manage',async()=>{
 for(const role_code of ['operations','manager']){const pool=successfulMutationPool();const app=await economicsApp(pool);const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{user:{id:7,role_code,company_id:10,permissions:['economics.manage']},body:{revenue_clp:180000,revenue_includes_vat:true,reason:'Tarifa acordada'}});assert.equal(res.statusCode,200);assert.equal(res.payload.revenue_clp,180000);assert.equal(pool.releases,1)}
});

test('admin exige company scope explícito y opera con la empresa indicada',async()=>{
 const noCompany=successfulMutationPool();const appA=await economicsApp(noCompany);const denied=await invoke(appA.route('patch','/api/economics/trips/:id/revenue'),{user:{id:1,role_code:'admin',company_id:null,permissions:[]},body:{revenue_clp:10}});assert.equal(denied.statusCode,400);assert.equal(noCompany.calls.length,0);
 const pool=successfulMutationPool();const app=await economicsApp(pool);const ok=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{user:{id:1,role_code:'admin',company_id:null,permissions:[]},body:{company_id:10,revenue_clp:10}});assert.equal(ok.statusCode,200);const locked=pool.calls.find(x=>x.sql.startsWith('select id,company_id'));assert.deepEqual(locked.values,['31',10]);const audit=pool.calls.find(x=>x.sql.startsWith('insert into audit_logs'));assert.equal(audit.values[0],10);
});

test('maintenance y driver no pueden modificar ingresos',async()=>{
 const pool=successfulMutationPool();const app=await economicsApp(pool);const route=app.route('patch','/api/economics/trips/:id/revenue');
 for(const role_code of ['maintenance','driver']){const res=await invoke(route,{user:{id:9,role_code,company_id:10,permissions:[]},body:{revenue_clp:1}});assert.equal(res.statusCode,403)}assert.equal(pool.calls.length,0);
});

test('mutación usa un cliente y ordena BEGIN, perfil, historial, viaje, auditoría y COMMIT',async()=>{
 const pool=successfulMutationPool();const app=await economicsApp(pool);const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:180000,revenue_includes_vat:false,reason:'Corrección comercial'}});assert.equal(res.statusCode,200);
 assert.deepEqual(pool.calls.map(x=>x.sql==='BEGIN'||x.sql==='COMMIT'?x.sql:x.sql.startsWith('select id,company')?'TRIP':x.sql.startsWith('select *')?'OLD_PROFILE':x.sql.startsWith('insert into trip_economic_profiles')?'PROFILE':x.sql.startsWith('insert into trip_revenue_history')?'HISTORY':x.sql.startsWith('update trips')?'TRIP_UPDATE':'AUDIT'),['BEGIN','TRIP','OLD_PROFILE','PROFILE','HISTORY','TRIP_UPDATE','AUDIT','COMMIT']);assert.ok(pool.calls.every(x=>x.source==='client'));assert.equal(pool.releases,1);
 const history=pool.calls.find(x=>x.sql.startsWith('insert into trip_revenue_history'));assert.deepEqual(history.values,[10,31,'150000',180000,false,null,'Corrección comercial',7]);
});

test('cero confirmado exige justificación y se distingue de no informado',async()=>{
 const untouched={async connect(){throw Error('no debe conectar')},async query(){throw Error('no debe consultar')}};const appA=await economicsApp(untouched);const invalid=await invoke(appA.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:0,revenue_includes_vat:null,reason:'  '}});assert.equal(invalid.statusCode,400);
 const pool=successfulMutationPool();const app=await economicsApp(pool);const ok=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:0,revenue_includes_vat:null,reason:'Servicio sin cobro'}});assert.equal(ok.payload.revenue_status,'confirmed_zero');assert.equal(ok.payload.revenue_defined,true);assert.equal(ok.payload.legacy_unverified,false);const history=pool.calls.find(x=>x.sql.startsWith('insert into trip_revenue_history'));assert.equal(history.values[5],'Servicio sin cobro');
});

test('rechaza ingresos negativos, fraccionarios y tipos coercibles no admitidos antes de conectar',async()=>{
 const pool={async connect(){throw Error('no debe conectar')},async query(){throw Error('no debe consultar')}};const app=await economicsApp(pool);const route=app.route('patch','/api/economics/trips/:id/revenue');
 for(const revenue_clp of [-1,1.5,true,[],{},null,'','   ']){const res=await invoke(route,{body:{revenue_clp}});assert.equal(res.statusCode,400)}
 const vat=await invoke(route,{body:{revenue_clp:1,revenue_includes_vat:'true'}});assert.equal(vat.statusCode,400);
});

test('viaje iniciado requiere autorización y no realiza ninguna escritura',async()=>{
 const pool=successfulMutationPool({started:true});const app=await economicsApp(pool);const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:200000}});assert.equal(res.statusCode,409);assert.equal(res.payload.code,'ECONOMIC_AUTHORIZATION_REQUIRED');assert.deepEqual(pool.calls.map(x=>x.sql),['BEGIN','select id,company_id,revenue_clp,actual_departure,status from trips where id=$1 and company_id=$2 for update','ROLLBACK']);assert.equal(pool.releases,1);
});

test('viaje inexistente o fuera de scope responde 404 sin mutar',async()=>{
 const pool=mockPool(async sql=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[],rowCount:0};if(sql.startsWith('select id,company_id'))return {rows:[],rowCount:0};throw Error(`Consulta inesperada: ${sql}`)});const app=await economicsApp(pool);const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:1}});assert.equal(res.statusCode,404);assert.equal(pool.calls.some(x=>x.sql.startsWith('insert')||x.sql.startsWith('update')),false);assert.equal(pool.releases,1);
});

test('historial es company-scoped, append-only, determinista y expone actor sin secretos',async()=>{
 const rows=[{id:2,company_id:10,trip_id:31,previous_revenue_clp:'0',new_revenue_clp:'100',created_by:7,created_by_name:'Operador',created_at:'2026-08-19T12:00:00Z',authorization_request_id:null}];
 const pool=mockPool(async(sql,values)=>{assert.deepEqual(values,['31',10]);if(sql.startsWith('select id from trips'))return {rows:[{id:31}],rowCount:1};assert.match(sql,/order by h\.created_at desc,h\.id desc/);assert.doesNotMatch(sql,/password/i);return {rows,rowCount:1}});const app=await economicsApp(pool);const res=await invoke(app.route('get','/api/economics/trips/:id/revenue-history'));assert.deepEqual(res.payload,rows);assert.equal(pool.calls.some(x=>/^update|^delete/i.test(x.sql)),false);
});

test('actualización conserva before/after y usa writeAudit en la misma transacción',async()=>{
 const old={...profile,revenue_includes_vat:false};const pool=successfulMutationPool({existingProfile:old});const app=await economicsApp(pool);await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:200000,revenue_includes_vat:true,reason:'Nueva tarifa'}});const audit=pool.calls.find(x=>x.sql.startsWith('insert into audit_logs'));assert.equal(audit.source,'client');assert.equal(audit.values[2],'update');assert.equal(audit.values[3],'trip_revenue');assert.equal(audit.values[5].revenue_clp,150000);assert.equal(audit.values[5].revenue_includes_vat,false);assert.equal(audit.values[6].revenue_clp,200000);assert.equal(audit.values[6].revenue_includes_vat,true);assert.equal(audit.values[6].reason,'Nueva tarifa');
});

test('auditoría usa define sin perfil o con ingreso no definido y update solo si ya estaba definido',async()=>{
 const cases=[
  {previous:null,expected:'define'},
  {previous:{...profile,revenue_defined:false,revenue_includes_vat:null,revenue_confirmed_by:null,revenue_confirmed_at:null},expected:'define'},
  {previous:profile,expected:'update'}
 ];
 for(const item of cases){const pool=successfulMutationPool({existingProfile:item.previous});const app=await economicsApp(pool);const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:180000}});assert.equal(res.statusCode,200);const audit=pool.calls.find(x=>x.sql.startsWith('insert into audit_logs'));assert.equal(audit.values[2],item.expected)}
});

test('cada fallo transaccional revierte sin COMMIT y libera exactamente una vez',async()=>{
 for(const failAt of ['profile','history','trip','audit']){const pool=successfulMutationPool({failAt});const app=await economicsApp(pool);const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:180000}});assert.equal(res.statusCode,500,failAt);assert.equal(pool.calls.at(-1).sql,'ROLLBACK',failAt);assert.equal(pool.calls.some(x=>x.sql==='COMMIT'),false,failAt);assert.equal(pool.releases,1,failAt)}
});

test('fallo al adquirir cliente responde error sin intentar liberar una conexión inexistente',async()=>{
 const app=await economicsApp({async connect(){throw Error('pool unavailable')}});const res=await invoke(app.route('patch','/api/economics/trips/:id/revenue'),{body:{revenue_clp:180000}});assert.equal(res.statusCode,500);assert.deepEqual(res.payload,{error:'No se pudo modificar el ingreso del viaje'});
});

test('el frontend reutiliza el viaje cargado, no repite su GET y muestra errores económicos',()=>{
 const fs=require('node:fs');const source=fs.readFileSync(require('node:path').join(__dirname,'..','public','operations-ui.js'),'utf8');
 assert.match(source,/window\.loadedOperationalTrip=d/);
 const wrapper=source.match(/window\.openTrip=async function\(id\)\{[^\n]+/g)?.at(-1)||'';
 assert.match(wrapper,/attachEconomicPanel\(window\.loadedOperationalTrip\)/);
 assert.doesNotMatch(wrapper,/api\('operations\/trips\/'\+id\)/);
 assert.doesNotMatch(wrapper,/catch\s*\{\s*\}/);
 const panelLoader=source.slice(source.indexOf('async function attachEconomicPanel'),source.indexOf('const openTripWithoutEconomics'));
 assert.match(panelLoader,/catch\(err\)/);
 assert.match(panelLoader,/No se pudo cargar: \$\{esc\(err\.message\)\}/);
 assert.match(source,/economics\.manage/);assert.doesNotMatch(source,/economicCostForm|TAG económico|conciliación económica/);
});
