const test=require('node:test');
const assert=require('node:assert/strict');
const {registerOperationsRoutes}=require('../operations-api');

function app(){const routes=[];for(const method of ['get','post','patch'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(method,path)=>routes.find(r=>r.method===method&&r.path===path);return routes}
function response(){return {statusCode:200,payload:undefined,status(c){this.statusCode=c;return this},json(v){this.payload=v;return this},sendStatus(c){this.statusCode=c;return this}}}
async function invoke(route,req,pool){const res=response();let i=0;const next=async()=>{const h=route.handlers[i++];if(h)return h(req,res,next)};await next();return res}
const trips=[
 {id:101,company_id:10,driver_id:4,trip_number:'A-101',status:'Asignado',origin:'A origen',destination:'A destino',planned_departure:null,planned_arrival:null,actual_departure:null,actual_arrival:null,distance_km:10,patente:'AAA111',truck_type:'Camión',client_name:'Cliente A'},
 {id:102,company_id:10,driver_id:5,trip_number:'A-102',status:'Asignado',origin:'A2 origen',destination:'A2 destino',planned_departure:null,planned_arrival:null,actual_departure:null,actual_arrival:null,distance_km:20,patente:'AAA222',truck_type:'Camión',client_name:'Cliente A'},
 {id:201,company_id:20,driver_id:6,trip_number:'B-201',status:'Asignado',origin:'B origen',destination:'B destino',planned_departure:null,planned_arrival:null,actual_departure:null,actual_arrival:null,distance_km:30,patente:'BBB111',truck_type:'Camión',client_name:'Cliente B'},
 {id:299,company_id:10,driver_id:null,trip_number:'A-299',status:'Planificado',origin:'Sin driver',destination:'Destino',planned_departure:null,planned_arrival:null,actual_departure:null,actual_arrival:null,distance_km:0,patente:null,truck_type:null,client_name:null}
];
function pool(){return {async query(sql,values=[]){if(sql.includes('from trips t')){if(sql.includes('t.id=$1')){const trip=trips.find(t=>String(t.id)===String(values[0])&&t.company_id===values[1]&&t.driver_id===values[2]);return {rows:trip?[trip]:[],rowCount:trip?1:0}}return {rows:trips.filter(t=>t.company_id===values[0]&&t.driver_id===values[1]),rowCount:1}}if(sql.includes('from trip_loads'))return {rows:[{id:1,cargo:'Carga',status:'Planificada'}],rowCount:1};if(sql.includes('from trip_events')||sql.includes('from trip_status_history')||sql.includes('from trip_route_snapshots'))return {rows:[],rowCount:0};throw new Error(`Consulta inesperada: ${sql}`)}}}
const driverA={role_code:'driver',company_id:10,driver_id:4};
const driverB={role_code:'driver',company_id:20,driver_id:6};
async function list(user,query={}){const a=app();registerOperationsRoutes(a,pool());return invoke(a.route('get','/api/driver/trips'),{user,query},pool())}
async function detail(user,id){const a=app();registerOperationsRoutes(a,pool());return invoke(a.route('get','/api/driver/trips/:id'),{user,params:{id:String(id)}},pool())}

test('Driver A obtiene solo su viaje y excluye otro driver, otra empresa y driver NULL',async()=>{const res=await list(driverA,{driver_id:6,company_id:20});assert.equal(res.statusCode,200);assert.deepEqual(res.payload.map(t=>t.id),[101])});
test('Driver B obtiene su viaje de Empresa B',async()=>{const res=await list(driverB);assert.deepEqual(res.payload.map(t=>t.id),[201])});
test('Driver A no obtiene viajes de Driver B ni de Empresa B',async()=>{assert.equal((await detail(driverA,102)).statusCode,404);assert.equal((await detail(driverA,201)).statusCode,404)});
test('Driver B no obtiene viaje de Empresa A',async()=>{assert.equal((await detail(driverB,101)).statusCode,404)});
test('driver sin asociación, usuario no driver y admin reciben 403',async()=>{for(const user of [{role_code:'driver',company_id:10,driver_id:null},{role_code:'viewer',company_id:10,driver_id:null},{role_code:'admin',company_id:null,driver_id:null}])assert.equal((await list(user)).statusCode,403)});
test('detalle propio devuelve cargas, ruta y no campos económicos',async()=>{const res=await detail(driverA,101);assert.equal(res.statusCode,200);assert.equal(res.payload.loads[0].cargo,'Carga');assert.equal('revenue_clp' in res.payload,false);assert.equal('fuel_cost_clp' in res.payload,false)});
test('detalle respeta planned_route_snapshot_id cuando existe',async()=>{const original=pool;const custom={async query(sql,values=[]){if(sql.includes('from trips t'))return {rows:[{...trips[0],planned_route_snapshot_id:77}],rowCount:1};if(sql.includes('from trip_route_snapshots'))return {rows:[{id:77,distance_km:12}],rowCount:1};if(sql.includes('from trip_loads')||sql.includes('from trip_events')||sql.includes('from trip_status_history'))return {rows:[],rowCount:0};throw new Error('unexpected')}};const a=app();registerOperationsRoutes(a,custom);const res=await invoke(a.route('get','/api/driver/trips/:id'),{user:driverA,params:{id:'101'}},custom);assert.equal(res.payload.planned_route.id,77);void original});
