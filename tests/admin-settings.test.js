const test=require('node:test');
const assert=require('node:assert/strict');
const {registerAdminRoutes}=require('../admin-api');

function fakeApp(){
  const routes=[];
  for(const method of ['get','post','put','patch','delete'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});
  routes.route=(method,path)=>{const route=routes.find(x=>x.method===method&&x.path===path);assert.ok(route,`Ruta no registrada: ${method.toUpperCase()} ${path}`);return route};
  return routes;
}

function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;this.payload=undefined;return this}};}

async function invoke(route,overrides={}){
  const req={user:{id:1,role_code:'admin',company_id:null,permissions:[]},params:{key:'gps.refresh_seconds'},body:{value:45},ip:'127.0.0.1',...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

const label=sql=>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return sql;
  if(sql.startsWith('select id,setting_key'))return sql.endsWith(' for update')?'LOCK_SETTING':'SETTING_VIEW';
  if(sql.startsWith('update system_settings'))return 'UPDATE_SETTING';
  if(sql.startsWith('insert into audit_logs'))return 'AUDIT';
  return 'UNKNOWN';
};

function settingsPool({exists=true,failAt=null}={}){
  const calls=[];let connects=0;let releases=0;
  const before={id:6,setting_key:'gps.refresh_seconds',category:'gps',label:'Actualización GPS (segundos)',value:30,description:'Frecuencia de actualización',updated_at:'2026-01-01T00:00:00.000Z',updated_by:null};
  const after={...before,value:45,updated_at:'2026-08-19T00:00:00.000Z',updated_by:1};
  const client={
    async query(sql,values=[]){
      const kind=label(sql);calls.push({sql,values,label:kind});
      if(failAt===kind)throw new Error(`${kind} failed`);
      if(['BEGIN','COMMIT','ROLLBACK'].includes(kind))return {rowCount:0,rows:[]};
      if(kind==='LOCK_SETTING')return exists?{rowCount:1,rows:[before]}:{rowCount:0,rows:[]};
      if(kind==='UPDATE_SETTING')return {rowCount:1,rows:[{setting_key:'gps.refresh_seconds'}]};
      if(kind==='SETTING_VIEW')return {rowCount:1,rows:[after]};
      if(kind==='AUDIT')return {rowCount:1,rows:[]};
      throw new Error(`Consulta de configuración inesperada: ${sql}`);
    },
    release(){releases++;}
  };
  return {calls,async connect(){connects++;return client;},get connects(){return connects;},get releases(){return releases;},before,after};
}

test('setting global actualiza, conserva BEFORE/AFTER, audita y confirma una vez',async()=>{
  const pool=settingsPool();const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/settings/:key'));
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,pool.after);
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','LOCK_SETTING','UPDATE_SETTING','SETTING_VIEW','AUDIT','COMMIT']);
  const lock=pool.calls.find(x=>x.label==='LOCK_SETTING');
  assert.match(lock.sql,/where setting_key=\$1 for update$/);
  assert.deepEqual(lock.values,['gps.refresh_seconds']);
  const update=pool.calls.find(x=>x.label==='UPDATE_SETTING');
  assert.deepEqual(update.values,['45',1,'gps.refresh_seconds']);
  const audit=pool.calls.find(x=>x.label==='AUDIT');
  assert.deepEqual(audit.values.slice(0,5),[null,1,'update','system_setting','gps.refresh_seconds']);
  assert.deepEqual(audit.values[5],pool.before);
  assert.deepEqual(audit.values[6],pool.after);
  assert.equal(audit.values[5].value,30);
  assert.equal(audit.values[6].value,45);
  assert.notDeepEqual(audit.values[5],audit.values[6]);
  assert.deepEqual(Object.keys(audit.values[6]).sort(),['category','description','id','label','setting_key','updated_at','updated_by','value'].sort());
  assert.equal(pool.calls.filter(x=>x.label==='COMMIT').length,1);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

for(const failure of ['LOCK_SETTING','UPDATE_SETTING','AUDIT'])test(`setting global revierte sin COMMIT si falla ${failure}`,async()=>{
  const pool=settingsPool({failAt:failure});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/settings/:key'));
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.at(-1).label,'ROLLBACK');
  assert.equal(pool.calls.some(x=>x.label==='COMMIT'),false);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

test('setting inexistente conserva 404 sin UPDATE, auditoría ni COMMIT',async()=>{
  const pool=settingsPool({exists:false});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/settings/:key'));
  assert.equal(res.statusCode,404);
  assert.deepEqual(res.payload,{error:'Configuración no encontrada'});
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','LOCK_SETTING','ROLLBACK']);
  assert.equal(pool.calls.some(x=>['UPDATE_SETTING','SETTING_VIEW','AUDIT','COMMIT'].includes(x.label)),false);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});
