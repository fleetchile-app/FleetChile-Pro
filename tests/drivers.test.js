const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {registerCoreRoutes}=require('../core-api');

function fakeApp(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(route,...handlers)=>routes.push({method,route,handlers});routes.route=(method,route)=>{const found=routes.find(x=>x.method===method&&x.route===route);assert.ok(found,`Ruta no registrada: ${method.toUpperCase()} ${route}`);return found};return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}
async function invoke(route,overrides={}){const req={user:{id:5,role_code:'operations',company_id:10,permissions:['drivers.manage']},body:{},ip:'127.0.0.1',...overrides};const res=response();let index=0;const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};await next();return res}
function poolWith(resolver){const calls=[];let releases=0;const client={async query(sql,values=[]){calls.push({source:'client',sql,values});return resolver(sql,values)},release(){releases++}};return {calls,get releases(){return releases},async connect(){return client},async query(sql,values=[]){calls.push({source:'pool',sql,values});return resolver(sql,values)}}}

test('POST /api/drivers crea el conductor company-scoped y audita antes de COMMIT',async()=>{
 const created={id:21,company_id:10,name:'Ana Pérez',rut:'12.345.678-5',license:'A5',expiry:'2027-09-21',status:'Activo'};
 const pool=poolWith(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith('insert into drivers')){assert.deepEqual(values,[10,'Ana Pérez','12.345.678-5','A5','2027-09-21','Activo']);return {rows:[created]}}if(sql.startsWith('insert into audit_logs')){assert.equal(values[0],10);assert.equal(values[2],'create');assert.equal(values[3],'driver');assert.deepEqual(values[6],created);return {rows:[]}}throw Error(`Consulta inesperada: ${sql}`)});
 const app=fakeApp();registerCoreRoutes(app,pool);const res=await invoke(app.route('post','/api/drivers'),{body:{name:' Ana Pérez ',rut:'12.345.678-5',license:'A5',expiry:'2027-09-21'}});
 assert.equal(res.statusCode,201);assert.deepEqual(res.payload,created);assert.deepEqual(pool.calls.map(x=>x.sql==='BEGIN'||x.sql==='COMMIT'?x.sql:x.sql.startsWith('insert into drivers')?'INSERT_DRIVER':'AUDIT'),['BEGIN','INSERT_DRIVER','AUDIT','COMMIT']);assert.ok(pool.calls.every(x=>x.source==='client'));assert.equal(pool.releases,1);
});

test('POST /api/drivers exige permiso, empresa explícita para admin y fecha válida',async()=>{
 const pool=poolWith(async()=>{throw Error('No debe consultar PostgreSQL')});const app=fakeApp();registerCoreRoutes(app,pool);const route=app.route('post','/api/drivers');
 assert.equal((await invoke(route,{user:{id:8,role_code:'viewer',company_id:10,permissions:[]},body:{name:'Ana'}})).statusCode,403);
 assert.equal((await invoke(route,{user:{id:1,role_code:'admin',company_id:null,permissions:[]},body:{name:'Ana'}})).statusCode,400);
 assert.equal((await invoke(route,{body:{name:'Ana',expiry:'2026-02-30'}})).statusCode,400);
 assert.equal(pool.calls.length,0);
});

function browserContext(){
 const elements={app:{innerHTML:''},nav:{innerHTML:'',querySelectorAll(){return[]}},title:{textContent:''},mt:{textContent:''},form:{innerHTML:'',onsubmit:null,data:[]},modal:{classList:{hidden:true,add(){this.hidden=true},remove(){this.hidden=false}}},x:{},dx:{},newBtn:{},health:{textContent:''}};
 const requests=[];const alerts=[];
 const document={getElementById(id){return elements[id]||(elements[id]={innerHTML:'',classList:{add(){},remove(){}}})},querySelectorAll(){return[]},querySelector(){return null}};
 const context={console,document,Auth:{user:{id:1,role_code:'admin',company_id:null,permissions:[]}},alert:message=>alerts.push(message),setInterval(){},setTimeout(){},clearTimeout(){},URLSearchParams,FormData:class{constructor(target){return target.data}},fetch:async(url,opt={})=>{requests.push({url,opt});let data=[];if(url==='/api/companies')data=[{id:10,legal_name:'Empresa A'}];else if(url==='/api/dashboard')data={trucks:0,enroute:0,loads:0,alerts:0,fuel:0,km:0};else if(url==='/api/core/summary')data={};else if(url==='/api/drivers'&&!opt.method)data=[{id:21,company_id:10,name:'Ana Pérez',rut:'12.345.678-5',license:'A5',expiry:'2027-09-21T00:00:00.000Z',status:'Activo'}];else if(url==='/api/trucks'&&!opt.method)data=[{id:31,company_id:10,patente:'ABCD12',tipo:'Camión',capacidad_t:12,driver:'Ana Pérez',status:'Disponible',location:'Base'}];else if(url==='/api/drivers'&&opt.method==='POST')data={id:21,...JSON.parse(opt.body)};else if(/^\/api\/(drivers|trucks)\/\d+$/.test(url)&&opt.method==='PATCH')data={id:Number(url.split('/').pop()),...JSON.parse(opt.body)};return {ok:true,status:200,async json(){return data}}}};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8'),context);return {context,elements,requests,alerts};
}

test('botón de Conductores abre el formulario real y guarda mediante POST /api/drivers',async()=>{
 const {context,elements,requests,alerts}=browserContext();await vm.runInContext('drivers()',context);assert.match(elements.app.innerHTML,/onclick="openForm\('drivers'\)"/);
 await vm.runInContext('openForm("drivers")',context);assert.equal(elements.modal.classList.hidden,false);assert.match(elements.form.innerHTML,/name="company_id"/);assert.match(elements.form.innerHTML,/name="expiry" type="date"/);assert.equal(typeof elements.form.onsubmit,'function');
 elements.form.data=[['company_id','10'],['name','Ana Pérez'],['rut','12.345.678-5'],['license','A5'],['expiry','2027-09-21'],['status','Activo']];await elements.form.onsubmit({preventDefault(){},target:elements.form});
 const request=requests.find(x=>x.url==='/api/drivers'&&x.opt.method==='POST');assert.ok(request,'El formulario no hizo POST /api/drivers');assert.deepEqual(JSON.parse(request.opt.body),{company_id:10,name:'Ana Pérez',rut:'12.345.678-5',license:'A5',expiry:'2027-09-21',status:'Activo'});assert.deepEqual(alerts,[]);
});

test('PATCH de conductores y camiones bloquea por empresa, actualiza y audita en la misma transacción',async()=>{
 for(const entity of ['drivers','trucks']){const before=entity==='drivers'?{id:21,company_id:10,name:'Ana',status:'Activo'}:{id:31,company_id:10,patente:'ABCD12',tipo:'Camión',capacidad_t:12,status:'Disponible',location:'Base'};const after=entity==='drivers'?{...before,name:'Ana Pérez'}:{...before,location:'Taller'};const pool=poolWith(async(sql,values)=>{if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};if(sql.startsWith(`select * from ${entity}`))return {rows:[before],rowCount:1};if(sql.startsWith(`update ${entity}`))return {rows:[after],rowCount:1};if(sql.startsWith('insert into audit_logs'))return {rows:[]};throw Error(`Consulta inesperada: ${sql}`)});const app=fakeApp();registerCoreRoutes(app,pool);const body=entity==='drivers'?{name:'Ana Pérez',rut:'',license:'A5',expiry:'2027-09-21',status:'Activo'}:{patente:'ABCD12',tipo:'Camión',capacidad_t:12,driver:'Ana',status:'Disponible',location:'Taller'};const user={id:5,role_code:'operations',company_id:10,permissions:[entity==='drivers'?'drivers.manage':'fleet.manage']};const res=await invoke(app.route('patch',`/api/${entity}/:id`),{params:{id:String(before.id)},body,user});assert.equal(res.statusCode,200);assert.deepEqual(res.payload,after);assert.deepEqual(pool.calls.map(x=>x.sql==='BEGIN'||x.sql==='COMMIT'?x.sql:x.sql.startsWith('select *')?'SELECT':x.sql.startsWith('update')?'UPDATE':'AUDIT'),['BEGIN','SELECT','UPDATE','AUDIT','COMMIT']);assert.deepEqual(pool.calls[1].values,[String(before.id),10]);assert.match(pool.calls[1].sql,/company_id=\$2 for update/);assert.deepEqual(pool.calls[3].values.slice(0,7),[10,5,'update',entity==='drivers'?'driver':'truck',String(before.id),before,after]);assert.equal(pool.releases,1)}
});

test('Editar conductor y camión carga datos y usa PATCH del recurso correcto',async()=>{
 const {context,elements,requests,alerts}=browserContext();await vm.runInContext('drivers()',context);assert.match(elements.app.innerHTML,/openDriverForm\(21\)/);await vm.runInContext('openDriverForm(21)',context);assert.match(elements.form.innerHTML,/value="Ana Pérez"/);assert.match(elements.form.innerHTML,/value="2027-09-21"/);elements.form.data=[['company_id','10'],['name','Ana Actualizada'],['rut','12.345.678-5'],['license','A5'],['expiry','2027-09-21'],['status','Activo']];await elements.form.onsubmit({preventDefault(){},target:elements.form});
 await vm.runInContext('trucks()',context);assert.match(elements.app.innerHTML,/openTruckForm\(31\)/);await vm.runInContext('openTruckForm(31)',context);assert.match(elements.form.innerHTML,/value="ABCD12"/);elements.form.data=[['company_id','10'],['patente','ABCD12'],['tipo','Camión'],['capacidad_t','12'],['driver','Ana Pérez'],['status','Disponible'],['location','Taller']];await elements.form.onsubmit({preventDefault(){},target:elements.form});
 const patches=requests.filter(x=>x.opt.method==='PATCH');assert.deepEqual(patches.map(x=>x.url),['/api/drivers/21','/api/trucks/31']);assert.equal(JSON.parse(patches[0].opt.body).name,'Ana Actualizada');assert.equal(JSON.parse(patches[1].opt.body).location,'Taller');assert.deepEqual(alerts,[]);
});
