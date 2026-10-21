const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function surface({trip={},permissions=['trips.manage'],trips=[]}={}){
  const record={id:7,company_id:10,status:'Planificado',client_id:11,origin:'Origen de prueba',destination:'Destino de prueba',planned_departure:'2026-10-22T10:00:00Z',planned_arrival:'2026-10-22T12:00:00Z',loads:[],...trip};
  const options={routes:[],clients:[],trucks:[{id:8,patente:'PRUEBA',tipo:'Camión',status:'Disponible'}],drivers:[{id:9,name:'Conductor de prueba',status:'Activo'}]};
  const elements={};
  const requests=[];
  const alerts=[];
  const element=()=>({innerHTML:'',classList:{add(){},remove(){}},data:[]});
  const document={getElementById:id=>elements[id]||(elements[id]=element()),querySelector:()=>null};
  const context={document,Auth:{user:{role_code:'operations',permissions}},money:()=>'',badge:()=>'',alert:message=>alerts.push(message),FormData:class{constructor(form){return form.data}},fetch:async(url,opt={})=>{
    requests.push({url,opt});
    const payload=url==='/api/trips'?trips:url.endsWith('/clients')?[{id:11,name:'Mi cliente',rut:'RUT prueba'}]:url==='/api/operations/options'?options:record;
    return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
  }};
  context.window=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/operations-ui.js'),'utf8'),context);
  return {context,elements,requests,alerts};
}

function guide(html){return html.slice(html.indexOf('<section class="trip-preparation"'),html.indexOf('</section>')+10)}

test('guía muestra faltantes comprobables y abrir el viaje solo consulta datos existentes',async()=>{
  const {context,elements,requests}=surface({trip:{origin:'',planned_departure:null,planned_arrival:null}});
  await context.openTrip(7);
  const html=guide(elements.drawerBody.innerHTML);
  assert.match(html,/Revisa el cliente, el origen y el destino/);
  assert.match(html,/Revisa las fechas/);
  assert.match(html,/Todavía no hay cargas/);
  assert.match(html,/Selecciona el camión y el conductor/);
  assert.match(html,/onclick="assignTrip\(7\)"/);
  assert.match(html,/onclick="addTripLoad\(7\)"/);
  assert.equal(requests.length,2);
  assert.ok(requests.every(request=>!request.opt.method));
});

test('guía diferencia datos registrados de disponibilidad y acceso móvil sin verificar',async()=>{
  const {context,elements}=surface({trip:{truck_id:8,driver_id:9,loads:[{cargo:'Carga de prueba'}]}});
  await context.openTrip(7);
  const html=guide(elements.drawerBody.innerHTML);
  assert.equal((html.match(/>Registrado</g)||[]).length,4);
  assert.match(html,/Camión y conductor asignados/);
  assert.match(html,/1 carga\(s\) registrada\(s\)/);
  assert.match(html,/Esa asociación no se verifica desde esta guía/);
  assert.match(html,/solapamientos/);
  assert.match(html,/no confirma que el viaje esté autorizado para salir/);
  assert.doesNotMatch(html,/Listo para despachar|Disponibilidad confirmada/);
});

test('guía advierte fechas invertidas y carga desconocida sin inventar un resultado',async()=>{
  const {context,elements}=surface({trip:{planned_arrival:'2026-10-22T09:00:00Z',loads:null}});
  await context.openTrip(7);
  const html=guide(elements.drawerBody.innerHTML);
  assert.match(html,/la llegada no debe ser anterior/);
  assert.match(html,/No se pudo determinar la información de cargas/);
});

test('guía identifica el recurso que falta y explica el cierre sin retorno a base',async()=>{
  const {context,elements}=surface({trip:{truck_id:8}});
  await context.openTrip(7);
  assert.match(guide(elements.drawerBody.innerHTML),/Falta seleccionar el conductor/);
  assert.match(elements.drawerBody.innerHTML,/aria-describedby="tripStatusHelp"/);
  assert.match(elements.drawerBody.innerHTML,/no registra automáticamente el regreso del camión a base/);
});

for(const status of ['Completado','Cancelado'])test(`guía de viaje ${status} conserva información sin proponer nuevas asignaciones`,async()=>{
  const {context,elements}=surface({trip:{status}});
  await context.openTrip(7);
  const html=guide(elements.drawerBody.innerHTML);
  assert.match(html,/Guía de preparación del viaje/);
  assert.doesNotMatch(html,/onclick=/);
});

test('guía no agrega acciones de gestión para quien carece de trips.manage',async()=>{
  const {context,elements}=surface({permissions:[]});
  await context.openTrip(7);
  assert.doesNotMatch(guide(elements.drawerBody.innerHTML),/onclick=/);
});

test('hints de recursos explican la cuenta asociada y conservan el contrato de asignación',async()=>{
  const {context,elements,requests,alerts}=surface();
  await context.assignTrip(7);
  assert.match(elements.form.innerHTML,/cuenta asociada en Administración → Usuarios/);
  for(const id of ['tripRouteHelp','tripTruckHelp','tripDriverHelp','tripClientHelp']){
    assert.ok(elements.form.innerHTML.includes('aria-describedby="'+id+'"'));
    assert.ok(elements.form.innerHTML.includes('id="'+id+'"'));
  }
  elements.form.data=[['truck_id','8'],['driver_id','9'],['route_id',''],['client_id','11']];
  await elements.form.onsubmit({preventDefault(){},target:elements.form});
  const saves=requests.filter(request=>request.opt.method);
  assert.equal(saves.length,1);
  assert.equal(saves[0].url,'/api/operations/trips/7/assign');
  assert.deepEqual(JSON.parse(saves[0].opt.body),{truck_id:8,driver_id:9,route_id:null,client_id:11});
  assert.deepEqual(alerts,[]);
});

test('hints de carga explican múltiples entregas y conservan el POST actual',async()=>{
  const {context,elements,requests,alerts}=surface();
  context.currentTripId=7;
  await context.addTripLoad(7);
  assert.match(elements.form.innerHTML,/varias cargas al mismo viaje/);
  assert.match(elements.form.innerHTML,/Punto de retiro/);
  assert.match(elements.form.innerHTML,/kilogramos/);
  elements.form.data=[['cargo','Carga de prueba'],['weight_kg','1200'],['volume_m3','3'],['value_clp','0'],['client_id','11'],['origin','Retiro'],['destination','Entrega']];
  await elements.form.onsubmit({preventDefault(){},target:elements.form});
  const saves=requests.filter(request=>request.opt.method);
  assert.equal(saves.length,1);
  assert.equal(saves[0].url,'/api/operations/trips/7/loads');
  assert.equal(JSON.parse(saves[0].opt.body).weight_kg,1200);
  assert.deepEqual(alerts,[]);
});

test('viaje incompleto mantiene un aviso visible y permite diferir recursos desde el formulario',async()=>{
  const {context,elements}=surface();
  await context.openTrip(7);
  assert.match(elements.drawerBody.innerHTML,/role="alert"/);
  assert.match(elements.drawerBody.innerHTML,/No se puede activar sin camión y conductor/);
  await context.assignTrip(7);
  assert.match(elements.form.innerHTML,/Asignar conductor después/);
  assert.match(elements.form.innerHTML,/name="reason"/);
  assert.doesNotMatch(elements.form.innerHTML,/name="driver_id" required/);
});

test('historial de reasignación muestra antes y después y escapa el motivo',async()=>{
  const {context,elements}=surface({trip:{truck_id:8,driver_id:9,events:[{event_type:'Reasignación de recursos',notes:'<script>peligro</script>',details:{before:{truck_id:2,driver_id:3},after:{truck_id:8,driver_id:9}}}]}});
  await context.openTrip(7);
  assert.match(elements.drawerBody.innerHTML,/Camión: #2 → #8/);
  assert.match(elements.drawerBody.innerHTML,/Conductor: #3 → #9/);
  assert.doesNotMatch(elements.drawerBody.innerHTML,/<script>/);
  assert.doesNotMatch(elements.drawerBody.innerHTML,/Servicio pendiente de recursos/);
});

test('transferencia en interfaz ofrece otros viajes abiertos de la misma empresa y envía motivo',async()=>{
  const {context,elements,requests}=surface({permissions:['trips.manage','loads.manage'],trips:[
    {id:7,company_id:10,trip_number:'ACTUAL',status:'Asignado'},
    {id:20,company_id:'10',trip_number:'DESTINO',status:'Planificado',origin:'Origen',destination:'Destino'},
    {id:30,company_id:20,trip_number:'AJENO',status:'Asignado'},
    {id:40,company_id:10,trip_number:'TERMINADO',status:'Completado'}
  ]});
  await context.openTrip(7);
  await context.transferTripLoad(7,31);
  assert.match(elements.form.innerHTML,/DESTINO/);
  assert.doesNotMatch(elements.form.innerHTML,/AJENO|TERMINADO|ACTUAL/);
  assert.match(elements.form.innerHTML,/name="reason" required/);
  elements.form.data=[['target_trip_id','20'],['reason','Reemplazo de equipo']];
  await elements.form.onsubmit({preventDefault(){},target:elements.form});
  const save=requests.find(request=>request.opt.method==='POST');
  assert.equal(save.url,'/api/operations/trips/7/loads/31/transfer');
  assert.deepEqual(JSON.parse(save.opt.body),{target_trip_id:20,reason:'Reemplazo de equipo'});
});
