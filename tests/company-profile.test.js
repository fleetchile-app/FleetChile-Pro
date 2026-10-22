const test=require('node:test');
const assert=require('node:assert/strict');
const {registerAuthRoutes}=require('../auth');
const companyActor={id:1,company_id:20,company_name:'Empresa legacy B',role_code:'viewer',legacy_permissions:[],memberships:[{id:11,company_id:10,active:true,role_code:'company_admin',permissions:['company.users.manage']}],platform_memberships:[]};
companyActor.personnel_state={company_id:10,policy:{enforced:false,time_zone:'America/Santiago'},regularization_eligible:true,person:null,membership:{active:true,role_code:'company_admin'},account_active:true,contracts:[],conditions:[],licenses:[]};
const record={id:10,legal_name:'Empresa A',rut:'RUT registrado',trade_name:'Nombre comercial',email:'contacto@example.test',phone:'Teléfono registrado',address:'Dirección registrada',commune:'Comuna registrada',region:'Región registrada',active:true,plan_code:'plan_registrado',license_status:'active',license_started_at:'2026-10-01',license_expires_at:null,capabilities:{fleet:true,gps:false},user_limit:50,truck_limit:20,registered_users:3,active_users:2,trucks:4,secret_billing_key:'NO EXPONER'};

function setup({actor=companyActor,row=record,dbError=false}={}){
 const calls=[],routes=[],failures=[];
 const pool={async query(sql,values=[]){
  calls.push({sql,values});
  if(sql.startsWith('select s.user_id'))return {rows:actor?[{user_id:1}]:[],rowCount:actor?1:0};
  if(sql.startsWith('select u.id,u.name,u.email,u.phone,u.active'))return {rows:actor?[{...actor,active:true,personnel_state:actor.personnel_state}]:[],rowCount:actor?1:0};
  if(sql.includes('po.owner_type ownership_role'))return {rows:[actor],rowCount:1};
  if(sql.startsWith('update user_sessions'))return {rows:[],rowCount:0};
  if(sql==='select id from companies where id=$1 and active=true'){assert.deepEqual(values,[10]);return {rows:[{id:10}],rowCount:1}}
  if(sql.startsWith('select c.id,c.legal_name')){
   try{
    assert.deepEqual(values,[10]);assert.match(sql,/from companies c where c.id=\$1/);
    assert.match(sql,/um.company_id=c.id/);assert.match(sql,/um.active=true and u.active=true/);
    assert.match(sql,/count\(distinct um.user_id\)/);assert.match(sql,/t.company_id=c.id/);
    assert.doesNotMatch(sql,/select \*/i);
   }catch(error){failures.push(error);throw error}
   if(dbError)throw Error('Detalle interno reservado');
   return {rows:row?[row]:[],rowCount:row?1:0};
  }
  throw Error('Consulta inesperada: '+sql);
 },async connect(){assert.fail('La consulta de ficha no abre transacciones ni muta datos')}};
 const app={};for(const method of ['get','post','patch','put','delete'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
 registerAuthRoutes(app,pool);
 async function request(overrides={}){
  const req={get:name=>name==='authorization'?'Bearer test-session':'',params:{},query:{company_id:20},body:{company_id:20,plan_code:'NO APLICAR',user_limit:999999},...overrides};
  const res={statusCode:200,status(code){this.statusCode=code;return this},json(data){this.payload=data;return this}};
  const route=routes.find(r=>r.path==='/api/company/profile');
  // Ejecutar autenticación, resolución y userManagement reales; sólo la BD es simulada.
  for(const handler of route.handlers){let next=false;await handler(req,res,()=>next=true);if(!next)break}
  assert.deepEqual(failures,[]);return res;
 }
 return {request,calls,routes};
}

test('ficha propia se deriva de membership A e ignora query/body B; licencia no se modifica',async()=>{
 const s=setup(),res=await s.request();
 assert.equal(res.statusCode,200);assert.equal(res.payload.company.id,10);assert.equal(res.payload.company.legal_name,'Empresa A');
 assert.equal(res.payload.license.plan_code,'plan_registrado');assert.equal(res.payload.license.user_limit,50);
 assert.equal(res.payload.license.expires_at,null);assert.deepEqual(res.payload.usage,{registered_users:3,active_users:2,trucks:4});
 assert.equal(JSON.stringify(res.payload).includes('NO EXPONER'),false);assert.equal(JSON.stringify(res.payload).includes('Empresa legacy B'),false);
 assert.equal(s.calls.filter(call=>call.sql.startsWith('select c.id')).length,1);
 assert.ok(s.calls.every(call=>!/^\s*(insert|delete|alter|begin|commit)\b/i.test(call.sql)));
 assert.equal(s.routes.filter(route=>route.path==='/api/company/profile').length,1);assert.equal(s.routes.find(route=>route.path==='/api/company/profile').method,'get');
});

for(const [name,actor,status] of [
 ['sin sesión',null,401],
 ['sin permiso',{...companyActor,memberships:[{id:11,company_id:10,role_code:'viewer',permissions:[]}]},403],
 ['membership ambigua',{...companyActor,memberships:[{id:11,company_id:10},{id:12,company_id:20}]},403],
 ['membership inactiva',{...companyActor,memberships:[{id:11,company_id:10,active:false}]},403],
 ['administrador legacy sin empresa',{...companyActor,role_code:'admin',company_id:null,memberships:[]},403],
 ['plataforma global',{...companyActor,memberships:[],platform_memberships:[{id:9,role_code:'platform_superadmin',permissions:['platform.users.manage']}]},403],
 ['plataforma contextualizada',{...companyActor,memberships:[],platform_memberships:[{id:9,role_code:'platform_superadmin',permissions:['platform.users.manage']}]},403]
])test('consulta de ficha rechaza '+name,async()=>{
 const s=setup({actor}),res=await s.request(name==='plataforma contextualizada'?{get:key=>key==='authorization'?'Bearer test-session':key==='x-company-context'?'10':''}:{});
 assert.equal(res.statusCode,status);assert.equal(s.calls.some(call=>call.sql.startsWith('select c.id')),false);
});

test('company no puede utilizar X-Company-Context para consultar B',async()=>{
 const s=setup(),res=await s.request({get:key=>key==='authorization'?'Bearer test-session':key==='x-company-context'?'20':''});
 assert.equal(res.statusCode,403);assert.equal(s.calls.some(call=>call.sql.startsWith('select c.id')),false);
});

test('empresa no encontrada devuelve 404 sin sustituirla por otra ni inventar licencia',async()=>{
 const s=setup({row:null}),res=await s.request();assert.equal(res.statusCode,404);assert.equal(res.payload.license,undefined);
});

test('fallo PostgreSQL devuelve error controlado, sin detalles internos ni datos de otra empresa',async()=>{
 const s=setup({dbError:true}),res=await s.request();assert.equal(res.statusCode,500);assert.match(res.payload.error,/datos de empresa y licencia/);
 assert.equal(JSON.stringify(res.payload).includes('Detalle interno'),false);
});

test('administrador legacy con empresa conserva consulta propia sin acceso transversal',async()=>{
 const s=setup({actor:{...companyActor,company_id:10,role_code:'admin',memberships:[]}}),res=await s.request();
 assert.equal(res.statusCode,200);assert.equal(res.payload.company.id,10);
});
