const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {registerFleetRoutes}=require('../fleet-api');

function app(){const routes=[];for(const method of ['get','post','patch','delete'])routes[method]=(path,...handlers)=>routes.push({path,method,handlers});return routes}
async function endpoint({permissions=['gps.read','trips.manage'],row={id:1,trip_id:7,associated_trip_id:7,trip_company_id:10,driver_name:'Ana',client_name:'Forestal'},company=10}={}){
 const calls=[],db={query:async(sql,values)=>{calls.push({sql,values});return {rows:row?[row]:[],rowCount:row?1:0}}};
 const a=app();registerFleetRoutes(a,db);
 const route=a.find(r=>r.path==='/api/fleet/trucks/:id/position');
 const req={user:{id:2,role_code:'operations',company_id:company,permissions},params:{id:'3'},query:{}};
 const res={statusCode:200,status(code){this.statusCode=code;return this},json(data){this.data=data;return this},sendStatus(code){this.statusCode=code;return this}};
 let i=0;const next=async()=>{const handler=route.handlers[i++];if(handler)return handler(req,res,next)};await next();
 return {calls,res};
}
test('posición incorpora contexto de su viaje con joins delimitados por empresa',async()=>{
 const s=await endpoint();assert.equal(s.res.statusCode,200);assert.equal(s.res.data.associated_trip_id,7);
 const {sql,values}=s.calls[0];
 assert.match(sql,/p\.id=te\.trip_id and p\.company_id=t\.company_id/);
 assert.match(sql,/d\.id=p\.driver_id and d\.company_id=p\.company_id/);
 assert.match(sql,/c\.id=p\.client_id and c\.company_id=p\.company_id/);
 assert.match(sql,/te\.truck_id=\$1 and t\.company_id=\$2/);
 assert.match(sql,/order by te\.recorded_at desc,te\.id desc limit 1/);
 assert.deepEqual(values,[3,10]);
});
test('solo GPS mantiene contrato original y no consulta datos protegidos del viaje',async()=>{
 const row={id:1,trip_id:7,lat:-36.8,lng:-73};
 const s=await endpoint({permissions:['gps.read'],row});
 assert.equal(s.res.data,row);assert.doesNotMatch(s.calls[0].sql,/join trips|driver_name|client_name|associated_trip_id/);
});
test('sin permiso GPS no consulta aunque tenga permiso de viajes',async()=>{
 const s=await endpoint({permissions:['trips.manage']});assert.equal(s.res.statusCode,403);assert.equal(s.calls.length,0);
});
test('posición sin asociación válida conserva telemetría y falta de posición devuelve 404',async()=>{
 const s=await endpoint({row:{id:1,trip_id:7,associated_trip_id:null,lat:-36.8}});
 assert.equal(s.res.statusCode,200);assert.equal(s.res.data.lat,-36.8);
 assert.equal((await endpoint({row:null})).res.statusCode,404);
 assert.deepEqual((await endpoint({company:20,row:null})).calls[0].values,[3,20]);
});

const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
function card(position){
 const host={innerHTML:''},sandbox={document:{getElementById:()=>host},gpsEscape:value=>String(value).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))};
 vm.createContext(sandbox);
 const start=source.indexOf('function renderGpsTrip('),end=source.indexOf('\nasync function loadTruckGpsHistory',start);
 vm.runInContext(source.slice(start,end),sandbox);sandbox.renderGpsTrip(position);return host.innerHTML;
}
test('ficha presenta conductor cliente estado y enlace seguro separado del mapa',()=>{
 const html=card({associated_trip_id:7,trip_company_id:10,trip_number:'V-7',driver_name:'Ana',client_name:'Forestal',trip_status:'En tránsito'});
 for(const value of ['Ana','Forestal','V-7','En tránsito','asignación actual'])assert.ok(html.includes(value));
 assert.match(html,/href="\/\?trip=7&company=10" target="_blank" rel="noopener noreferrer"/);
});
test('datos vacíos, permisos insuficientes o ID inválido no crean un enlace engañoso',()=>{
 for(const position of [null,{trip_id:7},{associated_trip_id:'7x',trip_company_id:10},{associated_trip_id:7,trip_company_id:0}]){
  assert.doesNotMatch(card(position),/<a /);
 }
 const html=card({associated_trip_id:7,trip_company_id:10});
 assert.match(html,/Sin conductor asignado/);assert.match(html,/Sin cliente asignado/);
});
test('nombres y estados se escapan sin insertar HTML',()=>{
 const html=card({associated_trip_id:7,trip_company_id:10,driver_name:'<img src=x>',client_name:'<script>x</script>',trip_status:'<svg>'});
 assert.doesNotMatch(html,/<img|<script|<svg/);assert.match(html,/&lt;img/);
});
