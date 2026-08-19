const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {registerCoreRoutes}=require('../core-api');

function fakeApp(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(route,...handlers)=>routes.push({method,route,handlers});routes.route=(method,route)=>{const found=routes.find(x=>x.method===method&&x.route===route);assert.ok(found,`Ruta no registrada: ${method.toUpperCase()} ${route}`);return found};return routes}
function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;this.payload=undefined;return this}}}
async function invoke(route,overrides={}){const req={user:{id:5,role_code:'maintenance',company_id:10,permissions:['documents.manage']},params:{id:'7'},query:{},body:{},...overrides};const res=response();await route.handlers.at(-1)(req,res);return res}
function appWith(pool){const app=fakeApp();registerCoreRoutes(app,pool);return app}
function queryPool(handler){const calls=[];return {calls,async query(sql,values=[]){calls.push({sql,values});return handler(sql,values)}}}

test('GET consulta todos los documentos con company scope, sin limitarse a 30 días y con orden determinista',async()=>{const pool=queryPool(async(sql,values)=>{assert.match(sql,/from vehicle_documents vd join trucks t/);assert.match(sql,/union all/);assert.match(sql,/t\.company_id=\$1/);assert.match(sql,/d\.company_id=\$1/);assert.doesNotMatch(sql,/where vd\.expires_at is not null and vd\.expires_at <= current_date \+ interval '30 days'/);assert.match(sql,/order by expires_at asc nulls last,resource_type asc,id asc/);assert.deepEqual(values,[10]);return {rows:[{id:1,resource_type:'vehicle',expires_at:'2027-12-01',situation:'Vigente'}]}});const res=await invoke(appWith(pool).route('get','/api/documents'));assert.equal(res.statusCode,200);assert.equal(res.payload[0].expires_at,'2027-12-01')});

const filterCases=[
 ['vehículo',{resource_type:'vehicle',truck_id:'3'},/vd\.truck_id=\$2/,3],
 ['conductor',{resource_type:'driver',driver_id:'4'},/dd\.driver_id=\$2/,4],
 ['tipo',{document_type:'Revisión técnica'},/document_type=\$2/,'Revisión técnica'],
 ['estado',{status:'Vigente'},/status=\$2/,'Vigente'],
 ['período',{from:'2026-08-01',to:'2026-08-31'},/expires_at >= \$2.*expires_at <= \$3/s,'2026-08-01'],
 ['próximos',{upcoming:'true'},/expires_at between current_date and current_date\+30/,undefined],
 ['vencidos',{overdue:'true'},/expires_at<current_date/,undefined]
];
for(const[title,query,pattern,value]of filterCases)test(`GET aplica filtro por ${title}`,async()=>{const pool=queryPool(async(sql,values)=>{assert.match(sql,pattern);assert.equal(values[0],10);if(value!==undefined)assert.ok(values.includes(value));return {rows:[]}});const res=await invoke(appWith(pool).route('get','/api/documents'),{query});assert.equal(res.statusCode,200);assert.deepEqual(res.payload,[])});

test('GET permite resultado vacío y opciones de recursos permanecen company-scoped',async()=>{const pool=queryPool(async(sql,values)=>{if(sql.startsWith('select id,company_id,patente')){assert.match(sql,/t\.company_id=\$1/);assert.deepEqual(values,[10]);return {rows:[]}}if(sql.startsWith('select id,company_id,name')){assert.match(sql,/d\.company_id=\$1/);assert.deepEqual(values,[10]);return {rows:[]}}throw new Error(`Consulta inesperada: ${sql}`)});const res=await invoke(appWith(pool).route('get','/api/documents/options'));assert.deepEqual(res.payload,{trucks:[],drivers:[]})});

test('POST crea documento de vehículo validando primero el recurso company-scoped',async()=>{const calls=[];const pool=queryPool(async(sql,values)=>{calls.push(sql);if(sql.startsWith('select id from trucks')){assert.deepEqual(values,[3,10]);return {rowCount:1,rows:[{id:3}]}}if(sql.startsWith('insert into vehicle_documents')){assert.deepEqual(values,[3,'Revisión técnica','RT-1','2026-01-01','2027-01-01','Vigente',null,'Control anual']);return {rowCount:1,rows:[{id:21,truck_id:3}]}}throw new Error(`Consulta inesperada: ${sql}`)});const res=await invoke(appWith(pool).route('post','/api/vehicle-documents'),{body:{truck_id:3,document_type:'Revisión técnica',document_number:'RT-1',issued_at:'2026-01-01',expires_at:'2027-01-01',status:'Vigente',notes:'Control anual'}});assert.equal(res.statusCode,201);assert.equal(res.payload.id,21);assert.match(calls[0],/company_id=\$2/);assert.match(calls[1],/^insert/)});

test('POST crea documento de conductor con validación company-scoped',async()=>{const pool=queryPool(async(sql,values)=>{if(sql.startsWith('select id from drivers')){assert.deepEqual(values,[8,10]);return {rowCount:1,rows:[{id:8}]}}if(sql.startsWith('insert into driver_documents'))return {rowCount:1,rows:[{id:22,driver_id:8}]};throw new Error(`Consulta inesperada: ${sql}`)});const res=await invoke(appWith(pool).route('post','/api/driver-documents'),{body:{driver_id:8,document_type:'Licencia',expires_at:'2027-02-01'}});assert.equal(res.statusCode,201);assert.equal(res.payload.driver_id,8)});

test('POST rechaza recurso cross-company sin insertar',async()=>{const pool=queryPool(async(sql)=>{if(sql.startsWith('select id from trucks'))return {rowCount:0,rows:[]};throw new Error(`No debe ejecutar consulta hija: ${sql}`)});const res=await invoke(appWith(pool).route('post','/api/vehicle-documents'),{body:{truck_id:99,document_type:'Permiso',expires_at:'2027-01-01'}});assert.equal(res.statusCode,404);assert.equal(pool.calls.length,1)});

test('POST rechaza fechas inválidas antes de consultar PostgreSQL',async()=>{const pool=queryPool(async sql=>{throw new Error(`No debe consultar: ${sql}`)});const res=await invoke(appWith(pool).route('post','/api/driver-documents'),{body:{driver_id:8,document_type:'Licencia',expires_at:'2026-02-30'}});assert.equal(res.statusCode,400);assert.equal(pool.calls.length,0)});

test('PATCH actualiza documento autorizado y conserva campos corregibles',async()=>{const before={id:7,truck_id:3,document_type:'Permiso',document_number:'P-1',issued_at:'2026-01-01',expires_at:'2026-12-01',status:'Vigente',file_url:null,notes:null};const pool=queryPool(async(sql,values)=>{if(sql.startsWith('select vd.*')){assert.match(sql,/t\.company_id=\$2/);assert.deepEqual(values,['7',10]);return {rows:[before]}}if(sql.startsWith('update vehicle_documents')){assert.deepEqual(values,['Permiso','P-1','2026-01-01','2027-12-01','Renovado',null,'Renovación',7]);return {rows:[{...before,expires_at:'2027-12-01',status:'Renovado',notes:'Renovación'}]}}throw new Error(`Consulta inesperada: ${sql}`)});const res=await invoke(appWith(pool).route('patch','/api/vehicle-documents/:id'),{body:{expires_at:'2027-12-01',status:'Renovado',notes:'Renovación'}});assert.equal(res.statusCode,200);assert.equal(res.payload.status,'Renovado')});

test('PATCH devuelve 404 para documento inexistente o cross-company sin UPDATE',async()=>{const pool=queryPool(async(sql)=>{if(sql.startsWith('select dd.*'))return {rows:[]};throw new Error(`No debe actualizar: ${sql}`)});const res=await invoke(appWith(pool).route('patch','/api/driver-documents/:id'),{body:{status:'Vigente'}});assert.equal(res.statusCode,404);assert.equal(pool.calls.length,1)});

test('GET /api/documents/due conserva forma, ventana y orden legacy',async()=>{const pool=queryPool(async(sql,values)=>{assert.deepEqual(values,[10]);assert.match(sql,/expires_at <= current_date \+ interval '30 days'/);assert.match(sql,/order by .*expires_at/);if(sql.includes('vehicle_documents'))return {rows:[{id:1,patente:'AA-BB-11'}]};if(sql.includes('driver_documents'))return {rows:[{id:2,driver_name:'Ana'}]};throw new Error(`Consulta inesperada: ${sql}`)});const res=await invoke(appWith(pool).route('get','/api/documents/due'));assert.deepEqual(res.payload,{vehicles:[{id:1,patente:'AA-BB-11'}],drivers:[{id:2,driver_name:'Ana'}]})});

test('gestión documental conserva los condition codes estructurados de alertas 014',()=>{const source=fs.readFileSync(path.join(__dirname,'..','fleet-api.js'),'utf8');for(const code of ['vehicle_document_due','vehicle_document_expired','driver_document_due','driver_document_expired'])assert.match(source,new RegExp(code));assert.match(source,/source_type:'vehicle_document'/);assert.match(source,/source_type:'driver_document'/)});
