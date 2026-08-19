const test=require('node:test');
const assert=require('node:assert/strict');
const {registerCoreRoutes}=require('../core-api');
const {registerAdminRoutes}=require('../admin-api');

function fakeApp(){
  const routes=[];
  for(const method of ['get','post','put','patch','delete'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});
  routes.route=(method,path)=>{
    const route=routes.find(x=>x.method===method&&x.path===path);
    assert.ok(route,`Ruta no registrada: ${method.toUpperCase()} ${path}`);
    return route;
  };
  return routes;
}

function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;this.payload=undefined;return this}};}

async function invoke(route,overrides={}){
  const req={user:{id:1,role_code:'admin',company_id:null,permissions:[]},params:{id:'20'},body:{},ip:'127.0.0.1',...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

const queryLabel=sql=>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return sql;
  if(sql.startsWith('insert into companies'))return 'INSERT_COMPANY';
  if(sql.startsWith('update companies set'))return 'UPDATE_COMPANY';
  if(sql.startsWith('select id,legal_name'))return sql.endsWith(' for update')?'LOCK_COMPANY':'COMPANY_VIEW';
  if(sql.startsWith('insert into audit_logs'))return 'AUDIT';
  return 'UNKNOWN';
};

function companiesPool({exists=true,failAt=null,afterActive=false}={}){
  const calls=[];let connects=0;let releases=0;
  const before={id:20,legal_name:'Empresa Anterior',rut:'76.000.000-1',trade_name:'Anterior',email:'contacto@example.test',phone:'123',address:'Dirección 1',commune:'Santiago',region:'Metropolitana',active:true,created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z'};
  const after={...before,legal_name:'Empresa Actualizada',active:afterActive,updated_at:'2026-08-19T00:00:00.000Z'};
  const client={
    async query(sql,values=[]){
      const label=queryLabel(sql);calls.push({sql,values,label});
      if(failAt===label)throw Object.assign(new Error(`${label} failed`),failAt==='INSERT_COMPANY'?{code:'XX000'}:{});
      if(['BEGIN','COMMIT','ROLLBACK'].includes(label))return {rowCount:0,rows:[]};
      if(label==='INSERT_COMPANY')return {rowCount:1,rows:[{id:20}]};
      if(label==='LOCK_COMPANY')return exists?{rowCount:1,rows:[before]}:{rowCount:0,rows:[]};
      if(label==='UPDATE_COMPANY')return {rowCount:1,rows:[{id:20}]};
      if(label==='COMPANY_VIEW')return exists?{rowCount:1,rows:[after]}:{rowCount:0,rows:[]};
      if(label==='AUDIT')return {rowCount:1,rows:[]};
      throw new Error(`Consulta de empresas inesperada: ${sql}`);
    },
    release(){releases++;}
  };
  return {calls,async connect(){connects++;return client;},get connects(){return connects;},get releases(){return releases;},before,after};
}

test('POST empresas crea, obtiene representación segura, audita y confirma',async()=>{
  const pool=companiesPool();const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/companies'),{body:{legal_name:'Empresa Actualizada',rut:'76.000.000-1',trade_name:'Actualizada'}});
  assert.equal(res.statusCode,201);
  assert.deepEqual(res.payload,pool.after);
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','INSERT_COMPANY','COMPANY_VIEW','AUDIT','COMMIT']);
  const audit=pool.calls.find(x=>x.label==='AUDIT');
  assert.deepEqual(audit.values.slice(0,5),[20,1,'create','company','20']);
  assert.equal(audit.values[5],null);
  assert.deepEqual(audit.values[6],pool.after);
  assert.deepEqual(Object.keys(audit.values[6]).sort(),['active','address','commune','created_at','email','id','legal_name','phone','region','rut','trade_name','updated_at'].sort());
  assert.equal(pool.calls.filter(x=>x.label==='COMMIT').length,1);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

for(const failure of ['INSERT_COMPANY','COMPANY_VIEW','AUDIT'])test(`POST empresas revierte sin COMMIT si falla ${failure}`,async()=>{
  const pool=companiesPool({failAt:failure});const app=fakeApp();registerCoreRoutes(app,pool);
  const {res}=await invoke(app.route('post','/api/companies'),{body:{legal_name:'Empresa'}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.at(-1).label,'ROLLBACK');
  assert.equal(pool.calls.some(x=>x.label==='COMMIT'),false);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

test('PATCH empresas bloquea, captura BEFORE/AFTER, desactiva, audita y confirma',async()=>{
  const pool=companiesPool();const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/companies/:id'),{body:{legal_name:'Empresa Actualizada',active:false}});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,pool.after);
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','LOCK_COMPANY','UPDATE_COMPANY','COMPANY_VIEW','AUDIT','COMMIT']);
  assert.match(pool.calls.find(x=>x.label==='LOCK_COMPANY').sql,/where id=\$1 for update$/);
  const update=pool.calls.find(x=>x.label==='UPDATE_COMPANY');
  assert.match(update.sql,/legal_name=\$1,active=\$2/);
  assert.deepEqual(update.values,['Empresa Actualizada',false,'20']);
  const audit=pool.calls.find(x=>x.label==='AUDIT');
  assert.deepEqual(audit.values.slice(0,5),[20,1,'update','company','20']);
  assert.deepEqual(audit.values[5],pool.before);
  assert.deepEqual(audit.values[6],pool.after);
  assert.notDeepEqual(audit.values[5],audit.values[6]);
  assert.equal(pool.calls.filter(x=>x.label==='COMMIT').length,1);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

test('PATCH empresas conserva la activación mediante active=true',async()=>{
  const pool=companiesPool({afterActive:true});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/companies/:id'),{body:{active:true}});
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.active,true);
  const update=pool.calls.find(x=>x.label==='UPDATE_COMPANY');
  assert.deepEqual(update.values,[true,'20']);
  assert.equal(pool.calls.find(x=>x.label==='AUDIT').values[6].active,true);
  assert.equal(pool.calls.filter(x=>x.label==='COMMIT').length,1);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

test('PATCH empresas devuelve 404 sin mutación, auditoría ni COMMIT si no existe',async()=>{
  const pool=companiesPool({exists:false});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/companies/:id'),{body:{active:false}});
  assert.equal(res.statusCode,404);
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','LOCK_COMPANY','ROLLBACK']);
  assert.equal(pool.calls.some(x=>['UPDATE_COMPANY','AUDIT','COMMIT'].includes(x.label)),false);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});

for(const failure of ['UPDATE_COMPANY','AUDIT'])test(`PATCH empresas revierte sin COMMIT si falla ${failure}`,async()=>{
  const pool=companiesPool({failAt:failure});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('patch','/api/admin/companies/:id'),{body:{active:false}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.at(-1).label,'ROLLBACK');
  assert.equal(pool.calls.some(x=>x.label==='COMMIT'),false);
  assert.equal(pool.connects,1);assert.equal(pool.releases,1);
});
