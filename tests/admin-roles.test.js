const test=require('node:test');
const assert=require('node:assert/strict');
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

function response(){
  return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;this.payload=undefined;return this}};
}

async function invoke(route,overrides={}){
  const req={user:{id:1,role_code:'admin',company_id:null,permissions:[]},params:{id:'2'},body:{permission_ids:[11,12]},ip:'127.0.0.1',...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

const label=sql=>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return sql;
  if(sql.startsWith('select id,code,name from roles'))return 'ROLE';
  if(sql.startsWith('select p.id,p.code,p.name,p.module'))return 'SNAPSHOT';
  if(sql.startsWith('delete from role_permissions'))return 'DELETE';
  if(sql.startsWith('insert into role_permissions'))return 'INSERT';
  if(sql.startsWith('insert into audit_logs'))return 'AUDIT';
  return 'UNKNOWN';
};

function adminPool({roleExists=true,failAt=null}={}){
  const calls=[];let releases=0;let snapshots=0;
  const before=[{id:10,code:'users.read',name:'Ver usuarios',module:'users'}];
  const after=[{id:11,code:'users.manage',name:'Administrar usuarios',module:'users'},{id:12,code:'trips.manage',name:'Administrar viajes',module:'trips'}];
  const client={
    async query(sql,values=[]){
      const kind=label(sql);calls.push({sql,values,label:kind});
      if(failAt===kind&&kind!=='SNAPSHOT')throw new Error(`${kind} failed`);
      if(['BEGIN','COMMIT','ROLLBACK'].includes(kind))return {rowCount:0,rows:[]};
      if(kind==='ROLE')return roleExists?{rowCount:1,rows:[{id:2,code:'operations',name:'Operaciones'}]}:{rowCount:0,rows:[]};
      if(kind==='SNAPSHOT'){snapshots++;if(failAt==='SNAPSHOT_AFTER'&&snapshots===2)throw new Error('SNAPSHOT_AFTER failed');return {rowCount:snapshots===1?before.length:after.length,rows:snapshots===1?before:after};}
      if(kind==='DELETE'||kind==='INSERT'||kind==='AUDIT')return {rowCount:1,rows:[]};
      throw new Error(`Consulta administrativa inesperada: ${sql}`);
    },
    release(){releases++;}
  };
  return {calls,async connect(){return client;},get releases(){return releases;}};
}

test('reemplazo de permisos captura BEFORE/AFTER, audita y confirma una vez',async()=>{
  const pool=adminPool();const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('put','/api/admin/roles/:id/permissions'));
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,{ok:true});
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','ROLE','SNAPSHOT','DELETE','INSERT','INSERT','SNAPSHOT','AUDIT','COMMIT']);
  assert.equal(pool.calls.filter(x=>x.label==='COMMIT').length,1);
  const role=pool.calls.find(x=>x.label==='ROLE');
  assert.match(role.sql,/where id=\$1 for update$/);
  assert.deepEqual(role.values,['2']);
  const audit=pool.calls.find(x=>x.label==='AUDIT');
  assert.deepEqual(audit.values.slice(0,5),[null,1,'update','role_permissions','2']);
  assert.deepEqual(audit.values[5],{role_id:2,role_code:'operations',role_name:'Operaciones',permissions:[{id:10,code:'users.read',name:'Ver usuarios',module:'users'}]});
  assert.deepEqual(audit.values[6],{role_id:2,role_code:'operations',role_name:'Operaciones',permissions:[{id:11,code:'users.manage',name:'Administrar usuarios',module:'users'},{id:12,code:'trips.manage',name:'Administrar viajes',module:'trips'}]});
  assert.notDeepEqual(audit.values[5].permissions,audit.values[6].permissions);
  assert.equal(pool.releases,1);
});

for(const failure of [
  {at:'DELETE',expected:['BEGIN','ROLE','SNAPSHOT','DELETE','ROLLBACK']},
  {at:'INSERT',expected:['BEGIN','ROLE','SNAPSHOT','DELETE','INSERT','ROLLBACK']},
  {at:'SNAPSHOT_AFTER',expected:['BEGIN','ROLE','SNAPSHOT','DELETE','INSERT','INSERT','SNAPSHOT','ROLLBACK']},
  {at:'AUDIT',expected:['BEGIN','ROLE','SNAPSHOT','DELETE','INSERT','INSERT','SNAPSHOT','AUDIT','ROLLBACK']}
])test(`reemplazo de permisos revierte sin COMMIT si falla ${failure.at}`,async()=>{
  const pool=adminPool({failAt:failure.at});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('put','/api/admin/roles/:id/permissions'));
  assert.equal(res.statusCode,500);
  assert.deepEqual(pool.calls.map(x=>x.label),failure.expected);
  assert.equal(pool.calls.some(x=>x.label==='COMMIT'),false);
  assert.equal(pool.calls.at(-1).label,'ROLLBACK');
  assert.equal(pool.releases,1);
});

test('rol inexistente devuelve 404 sin mutaciones, auditoría ni COMMIT',async()=>{
  const pool=adminPool({roleExists:false});const app=fakeApp();registerAdminRoutes(app,pool);
  const {res}=await invoke(app.route('put','/api/admin/roles/:id/permissions'));
  assert.equal(res.statusCode,404);
  assert.deepEqual(pool.calls.map(x=>x.label),['BEGIN','ROLE','ROLLBACK']);
  assert.equal(pool.calls.some(x=>['DELETE','INSERT','SNAPSHOT','AUDIT','COMMIT'].includes(x.label)),false);
  assert.equal(pool.releases,1);
});
