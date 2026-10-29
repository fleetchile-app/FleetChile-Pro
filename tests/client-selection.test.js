const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {registerCoreRoutes: registerCoreRoutesImpl}=require('../core-api');
const {registerOperationsRoutes: registerOperationsRoutesImpl}=require('../operations-api');
const registerCoreRoutes=(app,pool,options={})=>registerCoreRoutesImpl(app,pool,{assertTripResourcesReady:async()=>{},...options});
const registerOperationsRoutes=(app,pool,options={})=>registerOperationsRoutesImpl(app,pool,{assertTripResourcesReady:async()=>{},...options});
const {writeAudit}=require('../audit');

function setup({owned=true,permission='loads.manage',company=10,tripClient=11}={}){
  const routes=[];
  const app={};
  for(const method of ['get','post','patch'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
  const calls=[];
  const db={async query(sql,values=[]){
    calls.push({sql,values});let rows=[];
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows,rowCount:0};
    if(sql.startsWith('select id,name,rut from clients'))rows=[{id:'11',name:'Mi cliente',rut:'RUT prueba'}];
    else if(sql.startsWith('select id,patente,tipo,status from trucks'))rows=[{id:1,patente:'QA-OWN',tipo:'Camión',status:'Disponible'}];
    else if(sql.startsWith('select id,name from clients')||sql.startsWith('select id from clients'))rows=owned?[{id:'11',name:'Nombre real'}]:[];
    else if(sql.includes('from trips t where'))rows=[{id:7,company_id:10,client_id:tripClient,status:'Planificado'}];
    else if(sql.startsWith('select id from trucks')||sql.startsWith('select id from drivers'))rows=[{id:1}];
    else if(sql.startsWith('insert into loads')||sql.startsWith('insert into trip_loads')||sql.startsWith('insert into trips')||sql.startsWith('update trips set'))rows=[{id:21,company_id:10,client_id:11,status:'Asignado'}];
    else if(sql.startsWith('insert into audit_logs')||sql.startsWith('insert into trip_status_history')||sql.startsWith('insert into trip_events'))rows=[];
    else throw Error('SQL inesperado: '+sql);
    return {rows,rowCount:rows.length};
  },release(){}};
  const pool={calls,async connect(){return db},query:db.query};
  registerCoreRoutes(app,pool);registerOperationsRoutes(app,pool);
  const user={id:5,actor_type:'company',scope:'company',company_id:company,membership_id:1,role_code:'operations',permissions:[permission]};
  return {pool,user,route:(method,path)=>routes.find(route=>route.method===method&&route.path===path)};
}
function response(){return {statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,user,body={}){
  const req={user,body,params:{id:'7'},query:{company_id:999},ip:'127.0.0.1'};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return res;
}
function legacyLoad(){
  const source=fs.readFileSync(require.resolve('../server.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('async function legacyTruckBelongs');
  const end=source.indexOf('\n}\n',source.indexOf('async function createLegacyLoad',start))+2;
  return Function('writeAudit',source.slice(start,end)+';return createLegacyLoad;')(writeAudit);
}

for(const [entity,permission] of [['loads','loads.manage'],['trips','trips.manage']]){
  test(`${entity}: catálogo filtra empresa activa y clientes activos con el permiso de la operación`,async()=>{
    const {pool,user,route}=setup({permission});
    const result=await invoke(route('get','/api/'+entity+'/clients'),user);
    assert.equal(result.statusCode,200);
    assert.match(pool.calls[0].sql,/company_id=\$1 and active=true/);
    assert.deepEqual(pool.calls[0].values,[10]);
    assert.equal(result.payload[0].id,'11');
    const denied=await invoke(route('get','/api/'+entity+'/clients'),{...user,permissions:[]});
    assert.equal(denied.statusCode,403);
  });
  test(`${entity}: catálogo rechaza plataforma global sin empresa`,async()=>{
    const {pool,user,route}=setup({permission});
    const result=await invoke(route('get','/api/'+entity+'/clients'),{...user,actor_type:'platform',scope:'platform',platform_membership_id:1,membership_id:null,company_id:null});
    assert.equal(result.statusCode,403);
    assert.equal(pool.calls.length,0);
  });
}

for(const [path,permission,body] of [
  ['/api/trips','trips.manage',{origin:'Origen',destination:'Destino'}],
  ['/api/operations/trips/:id/loads','loads.manage',{cargo:'Carga'}]
]){
  for(const client_id of [undefined,null,'',false,{},-1,1.5])test(`${path}: rechaza cliente ausente o inválido ${String(client_id)}`,async()=>{
    const {pool,user,route}=setup({permission});
    assert.equal((await invoke(route('post',path),user,{...body,client_id})).statusCode,400);
    assert.equal(pool.calls.length,0);
  });
  test(`${path}: rechaza cliente ajeno, inexistente o inactivo sin insertar`,async()=>{
    const {pool,user,route}=setup({permission,owned:false});
    assert.equal((await invoke(route('post',path),user,{...body,client_id:11,company_id:999})).statusCode,403);
    const lookup=pool.calls.find(call=>call.sql.startsWith('select id from clients'));
    assert.deepEqual(lookup.values,[11,10]);
    assert.match(lookup.sql,/active=true for share/);
    assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into')),false);
    assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
  });
}

test('nueva carga del menú rechaza texto libre y no permite omitir el cliente registrado',async()=>{
  const {pool,user}=setup();const res=response();
  await legacyLoad()({body:{client:'Nombre inventado',cargo:'Carga'},resourceCompanyId:10,user},res,pool);
  assert.equal(res.statusCode,400);assert.equal(pool.calls.length,0);
});

test('nueva carga conserva nombre del catálogo e identificador en auditoría e ignora el nombre enviado',async()=>{
  const {pool,user}=setup();const res=response();
  await legacyLoad()({body:{client_id:'11',client:'Nombre manipulado',company_id:999,cargo:'Carga'},resourceCompanyId:10,user},res,pool);
  assert.equal(res.statusCode,201);
  const query=pool.calls.find(call=>call.sql.startsWith('select id,name from clients'));
  assert.deepEqual(query.values,['11',10]);
  assert.match(query.sql,/active=true for share/);
  assert.equal(pool.calls.find(call=>call.sql.startsWith('insert into loads')).values[1],'Nombre real');
  assert.equal(pool.calls.find(call=>call.sql.startsWith('insert into audit_logs')).values[6].client_id,'11');
});

test('nueva carga rechaza un cliente de otra empresa antes de escribir',async()=>{
  const {pool,user}=setup({owned:false});const res=response();
  await legacyLoad()({body:{client_id:11,cargo:'Carga'},resourceCompanyId:10,user},res,pool);
  assert.equal(res.statusCode,403);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('insert into')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

test('asignación valida el cliente contra la empresa del viaje y no usa company_id del formulario',async()=>{
  const {pool,user,route}=setup({permission:'trips.manage',owned:false});
  assert.equal((await invoke(route('patch','/api/operations/trips/:id/assign'),user,{client_id:11,company_id:999})).statusCode,403);
  assert.deepEqual(pool.calls.find(call=>call.sql.startsWith('select id from clients')).values,[11,10]);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips set')),false);
});

test('viaje histórico sin cliente exige seleccionarlo antes de asignar recursos',async()=>{
  const {pool,user,route}=setup({permission:'trips.manage',tripClient:null});
  const result=await invoke(route('patch','/api/operations/trips/:id/assign'),user,{truck_id:1,driver_id:2});
  assert.equal(result.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('update trips set')),false);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');
});

function browser(clients=[{id:'11',name:'Mi cliente & empresa',rut:'RUT prueba'}]){
  const elements={};const requests=[];const alerts=[];
  const document={getElementById:id=>elements[id]||(elements[id]={innerHTML:'',data:[],querySelectorAll:()=>[],classList:{add(){},remove(){}}}),querySelectorAll:()=>[],querySelector:()=>null};
  const context={document,Auth:{user:{actor_type:'company',role_code:'operations',company_id:10}},localStorage:{getItem:()=>null},alert:message=>alerts.push(message),setInterval(){},setTimeout(){},clearTimeout(){},URLSearchParams,FormData:class{constructor(form){return form.data}},fetch:async(url,opt={})=>{
    requests.push({url,opt});
    return {ok:true,status:200,json:async()=>url.endsWith('/resources')?{trucks:[]}:url.endsWith('/clients')?clients:opt.method?{id:21}:[]};
  }};
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'),'utf8'),context);
  return {context,elements,requests,alerts};
}

for(const entity of ['loads','trips'])test(`${entity}: formulario selecciona mi cliente por ID y evita nombres libres`,async()=>{
  const {context,elements,requests}=browser();
  await context.openForm(entity);
  assert.match(elements.form.innerHTML,/<select name="client_id" required/);
  assert.match(elements.form.innerHTML,/Mi cliente &amp; empresa/);
  assert.doesNotMatch(elements.form.innerHTML,/<input name="client"/);
  elements.form.data=[['client_id','11'],['cargo','Carga'],['origin','Origen'],['destination','Destino']];
  await elements.form.onsubmit({preventDefault(){},target:elements.form});
  const save=requests.find(request=>request.opt.method==='POST');
  assert.equal(save.url,'/api/'+entity);
  assert.equal(JSON.parse(save.opt.body).client_id,'11');
  assert.equal('client' in JSON.parse(save.opt.body),false);
});

test('sin clientes registrados la interfaz explica el alta y no permite guardar',async()=>{
  const {context,elements,requests}=browser([]);
  await context.openForm('loads');
  assert.match(elements.form.innerHTML,/No tienes clientes activos registrados/);
  assert.match(elements.form.innerHTML,/button class="primary" disabled/);
  elements.form.data=[['client_id','99'],['cargo','Carga']];
  await elements.form.onsubmit({preventDefault(){},target:elements.form});
  assert.equal(requests.some(request=>request.opt.method==='POST'),false);
});

test('catálogo de camiones para cargas usa solo empresa activa y permiso loads.manage',async()=>{
 const {pool,user,route}=setup();const r=await invoke(route('get','/api/loads/resources'),user);
 assert.equal(r.statusCode,200);assert.deepEqual(pool.calls[0].values,[10]);assert.equal(r.payload.trucks[0].patente,'QA-OWN');
 assert.equal((await invoke(route('get','/api/loads/resources'),{...user,permissions:[]})).statusCode,403);
 assert.equal((await invoke(route('get','/api/loads/resources'),{...user,actor_type:'platform',scope:'platform',company_id:null,platform_membership_id:1})).statusCode,403);
});

test('carga no acepta patente inventada desde el formulario ni exige escribir un camión',async()=>{
 const {context,elements,requests,alerts}=browser();await context.openForm('loads');
 assert.match(elements.form.innerHTML,/<select name="truck">/);assert.doesNotMatch(elements.form.innerHTML,/<input name="truck"/);assert.match(elements.form.innerHTML,/Asignar después/);
 elements.form.data=[['client_id','11'],['truck','AJENO']];await elements.form.onsubmit({preventDefault(){},target:elements.form});
 assert.equal(requests.some(r=>r.opt.method==='POST'),false);assert.match(alerts[0],/tu flota/);
});
