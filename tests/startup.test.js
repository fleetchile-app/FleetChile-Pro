const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('path');
const {registerHealthRoutes}=require('../health-api');
const {MIGRATION_FILES,initializeDatabase,startApplication,migrationTimeouts}=require('../startup');
const {checkSyntax}=require('../scripts/check-syntax');

function fakeApp(){const routes=[];return {routes,get(routePath,handler){routes.push({path:routePath,handler})},route(routePath){const route=routes.find(item=>item.path===routePath);assert.ok(route,`Ruta no registrada: ${routePath}`);return route.handler}}}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this}}}

test('/api/health responde 200 sin consultar PostgreSQL',async()=>{
  const pool={async query(){throw new Error('No debe consultar PostgreSQL')}};
  const app=fakeApp();registerHealthRoutes(app,pool);const res=response();
  await app.route('/api/health')({},res);
  assert.equal(res.statusCode,200);assert.equal(res.payload.ok,true);assert.equal(res.payload.status,'alive');
});

test('/api/ready responde 200 cuando PostgreSQL está disponible',async()=>{
  const calls=[];const pool={async query(sql){calls.push(sql);return {rows:[{'?column?':1}]}}};
  const app=fakeApp();registerHealthRoutes(app,pool);const res=response();
  await app.route('/api/ready')({},res);
  assert.equal(res.statusCode,200);assert.equal(res.payload.status,'ready');assert.deepEqual(calls,['select 1']);
});

test('/api/ready responde 503 cuando PostgreSQL falla',async()=>{
  const pool={async query(){throw new Error('database unavailable')}};
  const app=fakeApp();registerHealthRoutes(app,pool);const res=response();
  await app.route('/api/ready')({},res);
  assert.equal(res.statusCode,503);assert.deepEqual(res.payload,{ok:false,service:'fleetchile',status:'not_ready',error:'database_unavailable'});
});

test('timeouts de migración usan configuración válida y defaults seguros',()=>{
  assert.deepEqual(migrationTimeouts({MIGRATION_LOCK_TIMEOUT_MS:'7000',MIGRATION_STATEMENT_TIMEOUT_MS:'90000'}),{lockTimeoutMs:7000,statementTimeoutMs:90000});
  assert.deepEqual(migrationTimeouts({MIGRATION_LOCK_TIMEOUT_MS:'0',MIGRATION_STATEMENT_TIMEOUT_MS:'invalid'}),{lockTimeoutMs:5000,statementTimeoutMs:120000});
});

test('runner incluye la migración aditiva de combustible al final',()=>{
  assert.ok(MIGRATION_FILES.includes('012_fuel_operations.sql'));
  assert.equal(MIGRATION_FILES.filter(file=>file==='012_fuel_operations.sql').length,1);
});

test('runner incluye la migración aditiva de mantenciones al final',()=>{
  assert.ok(MIGRATION_FILES.includes('013_maintenance_operations.sql'));
  assert.equal(MIGRATION_FILES.filter(file=>file==='013_maintenance_operations.sql').length,1);
});

test('runner incluye la migración de alertas operacionales al final',()=>{
  assert.ok(MIGRATION_FILES.includes('014_operational_alerts.sql'));
  assert.equal(MIGRATION_FILES.filter(file=>file==='014_operational_alerts.sql').length,1);
});

test('runner incluye la fundación económica después de alertas operacionales',()=>{
  assert.ok(MIGRATION_FILES.includes('015_economic_foundation.sql'));
  assert.ok(MIGRATION_FILES.includes('016_economic_authorizations.sql'));
  assert.ok(MIGRATION_FILES.includes('017_revenue_authorization_values.sql'));
  assert.ok(MIGRATION_FILES.includes('018_economic_reconciliation.sql'));
  assert.ok(MIGRATION_FILES.includes('019_driver_user_assignment.sql'));
  assert.equal(MIGRATION_FILES.at(-3),'022_platform_company_identity.sql');
  assert.equal(MIGRATION_FILES.at(-2),'023_platform_governance.sql');
  assert.equal(MIGRATION_FILES.at(-1),'024_platform_ownership.sql');
  assert.equal(MIGRATION_FILES.filter(file=>file==='015_economic_foundation.sql').length,1);
  assert.ok(MIGRATION_FILES.indexOf('015_economic_foundation.sql')>MIGRATION_FILES.indexOf('014_operational_alerts.sql'));
  assert.ok(MIGRATION_FILES.indexOf('019_driver_user_assignment.sql')>MIGRATION_FILES.indexOf('018_economic_reconciliation.sql'));
});

test('runner configura timeouts antes de schema y migraciones',async()=>{
  const calls=[];const client={async query(sql,values=[]){calls.push({sql,values});if(sql.startsWith('select count'))return {rows:[{count:1}]};return {rows:[]}},release(){calls.push({sql:'RELEASE',values:[]})}};
  const pool={async connect(){return client}};const logger={log(){}};
  await initializeDatabase(pool,{baseDir:path.join(__dirname,'..'),initializeCorePlatform:async()=>{},logger,env:{MIGRATION_LOCK_TIMEOUT_MS:'6500',MIGRATION_STATEMENT_TIMEOUT_MS:'75000'}});
  assert.equal(calls[0].sql,'select 1');
  assert.match(calls[1].sql,/set_config\('lock_timeout'/);assert.deepEqual(calls[1].values,['6500ms','75000ms']);
  assert.match(calls[2].sql,/CREATE TABLE IF NOT EXISTS trucks/);
  assert.ok(calls.findIndex(call=>call.sql.includes('CREATE TABLE IF NOT EXISTS user_sessions'))>1);
  assert.equal(calls.at(-2).sql,'RESET lock_timeout; RESET statement_timeout');
  assert.equal(calls.at(-1).sql,'RELEASE');
});

test('error de migración identifica etapa, libera conexión y detiene migraciones siguientes',async()=>{
  const calls=[];let migrationCount=0;
  const client={async query(sql,values=[]){calls.push({sql,values});if(sql.startsWith('select count'))return {rows:[{count:1}]};if(sql.includes('CREATE TABLE IF NOT EXISTS user_sessions')){migrationCount++;return {rows:[]}};if(sql.includes('CREATE TABLE IF NOT EXISTS trip_status_history')){migrationCount++;throw new Error('migration failed')}return {rows:[]}},release(){calls.push({sql:'RELEASE',values:[]})}};
  const pool={async connect(){return client}};
  await assert.rejects(initializeDatabase(pool,{baseDir:path.join(__dirname,'..'),initializeCorePlatform:async()=>{},logger:{log(){}}}),error=>error.message==='migration failed'&&error.startupStage==='migración 004_operations.sql');
  assert.equal(migrationCount,2);assert.equal(calls.some(call=>call.sql.includes('ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_id')),false);assert.equal(calls.at(-2).sql,'RESET lock_timeout; RESET statement_timeout');assert.equal(calls.at(-1).sql,'RELEASE');
});

test('cliente vuelve al pool sin heredar timeouts de migración',async()=>{
  const session={lock_timeout:'0',statement_timeout:'0'};let released=false;
  const client={async query(sql,values=[]){
    if(sql.includes("set_config('lock_timeout'")){session.lock_timeout=values[0];session.statement_timeout=values[1]}
    if(sql==='RESET lock_timeout; RESET statement_timeout'){session.lock_timeout='0';session.statement_timeout='0'}
    if(sql.startsWith('select count'))return {rows:[{count:1}]};
    return {rows:[]};
  },release(error){assert.equal(error,undefined);released=true}};
  const pool={async connect(){return client},async query(){assert.equal(released,true);return {rows:[{...session}]}}};
  await initializeDatabase(pool,{baseDir:path.join(__dirname,'..'),initializeCorePlatform:async()=>{},logger:{log(){}}});
  const normalQuery=await pool.query('select current_setting');
  assert.deepEqual(normalQuery.rows[0],{lock_timeout:'0',statement_timeout:'0'});
});

test('fallo de limpieza no oculta el error original y descarta la conexión',async()=>{
  const logged=[];let releasedWith;
  const client={async query(sql){
    if(sql.startsWith('select count'))return {rows:[{count:1}]};
    if(sql.includes('CREATE TABLE IF NOT EXISTS trip_status_history'))throw new Error('migration failed');
    if(sql==='RESET lock_timeout; RESET statement_timeout')throw new Error('reset failed');
    return {rows:[]};
  },release(error){releasedWith=error}};
  const pool={async connect(){return client}};
  await assert.rejects(initializeDatabase(pool,{baseDir:path.join(__dirname,'..'),initializeCorePlatform:async()=>{},logger:{log(){},error(message){logged.push(message)}}}),error=>error.message==='migration failed'&&error.startupStage==='migración 004_operations.sql');
  assert.equal(releasedWith.message,'reset failed');
  assert.deepEqual(logged,['[STARTUP CLEANUP ERROR] reset failed']);
});

test('fallo de conexión PostgreSQL queda identificado como etapa de startup',async()=>{
  const pool={async connect(){throw new Error('connection refused')}};
  await assert.rejects(initializeDatabase(pool,{initializeCorePlatform:async()=>{},logger:{log(){}}}),error=>error.message==='connection refused'&&error.startupStage==='conexión PostgreSQL');
});

test('fallo de inicialización impide ejecutar app.listen',async()=>{
  let listened=false;
  const app={listen(){listened=true}};
  await assert.rejects(startApplication({app,pool:{},port:3000,initialize:async()=>{throw new Error('startup failed')},logger:{log(){}}}),/startup failed/);
  assert.equal(listened,false);
});

test('validador sintáctico detiene la secuencia ante node --check fallido',()=>{
  const visited=[];const spawn=(command,args)=>{visited.push({command,args});return {status:args[1].endsWith('invalid.js')?1:0}};
  assert.throws(()=>checkSyntax(['valid.js','invalid.js','never.js'],{spawn,logger:{log(){}}}),/Validación sintáctica fallida/);
  assert.deepEqual(visited.map(item=>item.args),[['--check','valid.js'],['--check','invalid.js']]);
});
