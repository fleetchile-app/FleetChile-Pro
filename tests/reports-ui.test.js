const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
const renderer=source.slice(source.indexOf('async function reports()'),source.indexOf('\nconst forms='));
const base={trip_number:'00123',status:'En carga',client_id:2,truck_id:5,driver_id:6,origin:'Concepción',destination:'Santiago',planned_departure:'2026-10-22T10:00:00.000Z'};
async function surface({report='trips',rows=[base],filters={},clients=[{id:2,name:'Forestal prueba'}],trucks=[{id:5,patente:'TEST-55'}],drivers=[{id:6,name:'Conductor prueba'}],user={role_code:'company_admin',company_id:10}}={}){
  const calls=[],elements={},A={innerHTML:''};
  const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const sandbox={A,Auth:{user},URLSearchParams,Intl,esc,k:(label,value)=>label+':'+value,document:{getElementById:id=>elements[id]},render:view=>calls.push(view),
    get:async url=>{calls.push(url);return url.startsWith('economics/reports?')?{report,rows,count:rows.length}:{clients,trucks,drivers}[url];}};
  sandbox.window=sandbox;sandbox.currentReportFilters={report,...filters};
  vm.createContext(sandbox);vm.runInContext(renderer,sandbox);await sandbox.reports();
  return {sandbox,A,calls,elements};
}

test('reporte muestra nombres y patente, preserva código de viaje y convierte UTC a hora de Chile',async()=>{
  const s=await surface();const html=s.A.innerHTML;
  for(const label of ['Forestal prueba','TEST-55','Conductor prueba','00123','1 registro','hora de Chile'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/2026-10-22T10:00:00/);assert.match(html,/07:00/);
  assert.match(html,/<td>00123<\/td>/);
});

test('sin asignación o relación disponible no presenta IDs como nombres',async()=>{
  const s=await surface({rows:[{...base,client_id:99,truck_id:null,driver_id:88}],clients:[],drivers:[]});
  assert.match(s.A.innerHTML,/<td>Cliente no disponible<\/td>/);
  assert.match(s.A.innerHTML,/<td>Sin asignar<\/td>/);
  assert.match(s.A.innerHTML,/<td>Conductor no disponible<\/td>/);
});

test('filtros conservan selección y los mismos valores enviados a la API',async()=>{
  const s=await surface({filters:{client_id:'2',truck_id:'5',driver_id:'6',status:'En carga'}});
  for(const id of [2,5,6])assert.ok(s.A.innerHTML.includes('value="'+id+'" selected'));
  const query=new URLSearchParams(s.calls[0].split('?')[1]);
  assert.equal(query.get('client_id'),'2');assert.equal(query.get('truck_id'),'5');assert.equal(query.get('driver_id'),'6');
  for(const [id,value] of Object.entries({reportType:'trips',reportClient:'2',reportTruck:'5',reportDriver:'6',reportStatus:'En carga'}))s.elements[id]={value};
  s.sandbox.applyReportFilters();assert.equal(s.sandbox.currentReportFilters.driver_id,'6');assert.equal(s.calls.at(-1),'reports');
});

test('presentación económica traduce estados y fuente sin recalcular ni convertir faltantes en cero',async()=>{
  const s=await surface({report:'economic',rows:[{trip_number:'V-1',revenue_recognized:10000,direct_costs_recognized:2000,delta:7654,delta_per_km:null,delta_status:'reconciled',distance_source:'trip_route_snapshot'}]});
  assert.match(s.A.innerHTML,/<td>7\.654<\/td>/);assert.match(s.A.innerHTML,/<td>N\/D<\/td>/);
  assert.match(s.A.innerHTML,/Reconciliado/);assert.match(s.A.innerHTML,/Ruta registrada del viaje/);
  assert.doesNotMatch(s.A.innerHTML,/>reconciled<|>trip_route_snapshot<|Missing data/);
});

test('datos de catálogos, texto y enums no inyectan HTML',async()=>{
  const s=await surface({clients:[{id:2,name:'<img src=x onerror=alert(1)>'}],rows:[{...base,origin:'<script>bad()</script>'}]});
  assert.doesNotMatch(s.A.innerHTML,/<img|<script/);assert.match(s.A.innerHTML,/&lt;img/);
  const e=await surface({report:'economic',rows:[{delta_status:'<img src=x>',distance_source:'<script>'}]});
  assert.doesNotMatch(e.A.innerHTML,/<img|<script/);
});

test('fechas ausentes o inválidas indican N/D y fechas sin hora no retroceden de día',async()=>{
  for(const value of [null,'no-fecha','2026-02-30']){
    const s=await surface({rows:[{...base,planned_departure:value}]});assert.match(s.A.innerHTML,/<td>N\/D<\/td>/);
  }
  const s=await surface({rows:[{...base,planned_departure:'2026-10-22'}]});assert.match(s.A.innerHTML,/<td>22-10-2026<\/td>/);
});

test('reporte vacío conserva aviso y alcance legacy explícito, sin pedir otra empresa',async()=>{
  const s=await surface({rows:[],user:{role_code:'admin',company_id:10}});
  assert.match(s.A.innerHTML,/No hay registros/);assert.match(s.calls[0],/company_id=10/);
  assert.deepEqual(s.calls.slice(1),['clients','trucks','drivers']);
});

test('reporte operacional conserva ceros y números legibles',async()=>{
  const s=await surface({report:'operational',rows:[{trip_number:'V-1',status:'Completado',loads_registered:2,loads_delivered:0,weight_kg:12500,volume_m3:4.5,duration_minutes:null}]});
  assert.match(s.A.innerHTML,/<td>0<\/td>/);assert.match(s.A.innerHTML,/<td>12\.500<\/td>/);assert.match(s.A.innerHTML,/<td>4,5<\/td>/);
});

test('fecha de invierno respeta America/Santiago independientemente de la zona del navegador',async()=>{
  const s=await surface({rows:[{...base,planned_departure:'2026-07-22T10:00:00.000Z'}]});
  assert.match(s.A.innerHTML,/06:00/);
});

test('exportación conserva contrato CSV y filtros aplicados sin transformar sus datos',async()=>{
  const s=await surface({filters:{client_id:'2',truck_id:'5',driver_id:'6',from:'2026-10-01',to:'2026-10-31',status:'En carga'},user:{role_code:'admin',company_id:10}});
  let requested,clicked=false,revoked;
  const blob={csv:'original'};
  s.sandbox.fetch=async url=>{requested=url;return {ok:true,blob:async()=>blob};};
  s.sandbox.URL={createObjectURL:value=>{assert.equal(value,blob);return 'blob:report';},revokeObjectURL:value=>{revoked=value;}};
  const anchor={click(){clicked=true;}};
  s.sandbox.document.createElement=()=>anchor;
  await s.sandbox.downloadReportCsv();
  const query=new URLSearchParams(requested.split('?')[1]);
  for(const [key,value] of Object.entries({report:'trips',format:'csv',company_id:'10',client_id:'2',truck_id:'5',driver_id:'6',from:'2026-10-01',to:'2026-10-31',status:'En carga'}))assert.equal(query.get(key),value);
  assert.equal(clicked,true);assert.equal(anchor.download,'fleetchile-trips.csv');assert.equal(revoked,'blob:report');
});
