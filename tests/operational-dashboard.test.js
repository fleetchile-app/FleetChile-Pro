const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/control-ui.js'),'utf8');

function surface({responses={},user={id:1,company_id:10,actor_type:'company'},company='',leaflet=true}={}){
 const elements={},timers=new Map(),events={},requests=[],markers=[],maps=[];let timerId=0;
 const element=()=>({innerHTML:'',classList:{toggle(){}},setAttribute(){}});
 const root=element(),nav={dataset:{v:'controlDashboard'}};
 const document={hidden:false,getElementById:id=>id==='operationalDashboard'&&!root.innerHTML.includes('id="operationalDashboard"')?null:elements[id]||(elements[id]=element()),querySelector:()=>nav,querySelectorAll:()=>[],addEventListener:(event,handler)=>events[event]=handler};
 const context={A:root,Auth:{user},document,localStorage:{getItem:()=>company},AbortController,Date,
  setTimeout:(callback,delay)=>{timers.set(++timerId,{callback,delay});return timerId},clearTimeout:id=>timers.delete(id),
  fetch:async(url,options)=>{requests.push({url,options});const result=responses[url]??[];if(typeof result==='function')return result(url,options);if(result instanceof Error)throw result;return {ok:!result.error,status:result.error?result.status||500:200,json:async()=>result.error?{error:result.error}:result}}};
 if(leaflet)context.L={map(){const map={removed:false,world:false,remove(){this.removed=true},fitWorld(){this.world=true;return this},setView(point){this.center=point;return this},fitBounds(points){this.bounds=points;return this}};maps.push(map);return map},tileLayer:()=>({addTo(map){map.hasBaseLayer=true}}),circleMarker:(point,style)=>{const marker={point,style,popup:'',addTo(){return this},bindPopup(value){this.popup=value;return this}};markers.push(marker);return marker}};
 context.window=context;context.addEventListener=(event,handler)=>events[event]=handler;
 vm.createContext(context);vm.runInContext(source,context);
 return {context,root,elements,nav,requests,timers,events,markers,maps};
}
const recent=()=>new Date(Date.now()-60000).toISOString();
const trip=(id,status,extra={})=>({id,company_id:10,trip_number:'V-'+id,status,truck_id:3,driver_id:4,...extra});

test('menú operativo queda debajo del ejecutivo y no lo sustituye',()=>{
 const app=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 assert.match(app,/\["dashboard",icons.dashboard,"Dashboard Ejecutivo","CONTROL"\],\["controlDashboard",icons.routes,"Dashboard operativo","CONTROL"\]/);
 assert.match(app,/new Set\(\['dashboard','controlDashboard'/);
 assert.match(app,/function render\(v="dashboard"\)\{window.stopControlDashboard\?\.\(\)/);
 assert.doesNotMatch(source,/window\.dashboard\s*=/);
});

test('selector se aloja en cabecera y conserva su identificador y confirmación',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8'),auth=fs.readFileSync(require.resolve('../public/auth.js'),'utf8');
 assert.doesNotMatch(html.slice(html.indexOf('<aside>'),html.indexOf('</aside>')),/activeCompany/);
 assert.match(html.slice(html.indexOf('<header>'),html.indexOf('</header>')),/id="activeCompany"[\s\S]*id="companyContextControl"/);
 assert.match(auth,/getElementById\('companyContextControl'\)\?\.appendChild\(select\)/);
 assert.match(auth,/select\.id='companyContextSelect'/);
 assert.match(auth,/¿Confirmar cambio de empresa/);
 assert.match(html,/href="operational.css"/);
});

test('muestra viajes abiertos, detenidos y faltantes con filtros sin inventar incidentes',async()=>{
 const s=surface({responses:{'/api/trips':[trip(1,'En tránsito'),trip(2,'Detenido'),trip(3,'Planificado',{driver_id:null}),trip(4,'Completado'),trip(5,'Cancelado')],'/api/alerts':[{id:1,title:'Advertencia',level:'warning',resolved:false},{id:2,title:'Crítica real',level:'critical',resolved:false},{id:3,title:'Resuelta',resolved:true}]}});
 await s.context.controlDashboard();
 assert.match(s.root.innerHTML,/Viajes abiertos<\/span><b>3/);
 assert.match(s.root.innerHTML,/Detenidos<\/span><b>1/);
 assert.match(s.root.innerHTML,/Recursos pendientes<\/span><b>1/);
 assert.match(s.root.innerHTML,/Alarmas abiertas<\/span><b>2/);
 assert.ok(s.root.innerHTML.indexOf('Crítica real')<s.root.innerHTML.indexOf('<b>Advertencia</b>'));
 assert.doesNotMatch(s.root.innerHTML,/V-4|V-5|<b>Resuelta<\/b>/);
 s.context.filterOperationalTrips('stopped');assert.match(s.elements.controlTrips.innerHTML,/V-2/);assert.doesNotMatch(s.elements.controlTrips.innerHTML,/V-1|V-3/);
 s.context.filterOperationalTrips('missing');assert.match(s.elements.controlTrips.innerHTML,/V-3/);assert.doesNotMatch(s.elements.controlTrips.innerHTML,/V-2/);
 assert.deepEqual(s.requests.map(request=>request.url),['/api/fleet/live','/api/trips','/api/alerts']);
 assert.ok(s.requests.every(request=>!request.options.method));
 assert.deepEqual([...s.timers.values()].map(timer=>timer.delay),[30000]);
});

test('GPS distingue reciente, antigua y ausencia; null no se transforma en coordenada cero',async()=>{
 const s=surface({responses:{'/api/fleet/live':[
  {id:1,patente:'Reciente',lat:0,lng:0,recorded_at:recent(),speed_kmh:0},
  {id:2,patente:'Antigua',lat:-33,lng:-70,recorded_at:new Date(Date.now()-3600000).toISOString()},
  {id:3,patente:'Sin GPS',lat:null,lng:null,recorded_at:recent()},
  {id:4,patente:'Fuera rango',lat:91,lng:0,recorded_at:recent()},
  {id:5,patente:'Sin fecha',lat:-32,lng:-71,recorded_at:null}
 ]}});
 await s.context.controlDashboard();
 assert.match(s.root.innerHTML,/GPS reciente \/ flota<\/span><b>1 \/ 5/);
 assert.equal(s.markers.length,2);assert.deepEqual(Array.from(s.markers[0].point),[0,0]);
 assert.notEqual(s.markers[0].style.color,s.markers[1].style.color);
 assert.match(s.root.innerHTML,/Sin posición verificada/);
 assert.doesNotMatch(s.root.innerHTML,/Detenidos<\/span><b>1/);
});

test('no presenta fechas futuras o inválidas como señal reciente',async()=>{
 const s=surface({responses:{'/api/fleet/live':[{id:1,lat:0,lng:0,recorded_at:'inválida'},{id:2,lat:0,lng:0,recorded_at:new Date(Date.now()+3600000).toISOString()}]}});
 await s.context.controlDashboard();
 assert.equal(s.markers.length,0);assert.match(s.root.innerHTML,/Fecha GPS inválida/);
 assert.match(s.elements.controlMapNotice.textContent,/Sin posiciones GPS verificables/);
 assert.equal(s.maps[0].hasBaseLayer,true);
});

test('fallo GPS no oculta viajes ni alarmas ni afirma que no hay vehículos',async()=>{
 const s=surface({responses:{'/api/fleet/live':{error:'Permiso requerido',status:403},'/api/trips':[trip(1,'Detenido')],'/api/alerts':[{title:'Alarma válida',level:'critical',resolved:false}]}});
 await s.context.controlDashboard();
 assert.match(s.root.innerHTML,/Sin permiso/);assert.match(s.root.innerHTML,/GPS reciente \/ flota<\/span><b>N\/D/);
 assert.match(s.root.innerHTML,/V-1/);assert.match(s.root.innerHTML,/Alarma válida/);
 assert.doesNotMatch(s.root.innerHTML,/No hay vehículos registrados/);
 assert.equal(s.markers.length,0);
});

test('fallo de viajes o alarmas no se muestra como cero y deshabilita filtros sin datos',async()=>{
 const s=surface({responses:{'/api/trips':{error:'No disponible'},'/api/alerts':{error:'Sin permiso',status:403}}});
 await s.context.controlDashboard();
 assert.match(s.root.innerHTML,/Viajes abiertos<\/span><b>N\/D/);
 assert.match(s.root.innerHTML,/Alarmas abiertas<\/span><b>N\/D/);
 assert.match(s.root.innerHTML,/aria-pressed="true" disabled/);
 assert.doesNotMatch(s.root.innerHTML,/No hay alarmas pendientes/);
});

test('respuestas malformadas mantienen error visible y no inventan listas vacías',async()=>{
 const s=surface({responses:{'/api/trips':{},'/api/alerts':null}});
 await s.context.controlDashboard();
 assert.match(s.root.innerHTML,/no devolvió una lista válida/);
 assert.match(s.root.innerHTML,/Viajes abiertos<\/span><b>N\/D/);
});

test('sin contexto empresarial no consulta ni mezcla empresas',async()=>{
 for(const user of [{id:1,actor_type:'platform'}, {id:1,role_code:'admin',company_id:null}]){
  const s=surface({user});await s.context.controlDashboard();
  assert.equal(s.requests.length,0);assert.match(s.root.innerHTML,/Selecciona una empresa/);
 }
 const s=surface({user:{id:1,actor_type:'platform'},company:'10'});await s.context.controlDashboard();assert.equal(s.requests.length,3);
});

test('dashboard legacy empresarial filtra respuestas transversales sin cambiar permisos de las APIs',async()=>{
 const s=surface({user:{id:1,role_code:'admin',company_id:10,actor_type:'legacy'},responses:{
  '/api/trips':[trip(1,'Detenido'),trip(2,'Detenido',{company_id:20})],
  '/api/fleet/live':[{id:1,company_id:'10',patente:'Propio',lat:0,lng:0,recorded_at:recent()},{id:2,company_id:20,patente:'Ajeno',lat:1,lng:1,recorded_at:recent()}],
  '/api/alerts':[{id:1,company_id:10,title:'Propia',resolved:false},{id:2,company_id:20,title:'Ajena',resolved:false}]
 }});
 await s.context.controlDashboard();assert.match(s.root.innerHTML,/Propio|Propia|V-1/);assert.doesNotMatch(s.root.innerHTML,/Ajeno|Ajena|V-2/);assert.equal(s.markers.length,1);
});

test('navegar fuera aborta consultas, retira mapa y cancela refresco',async()=>{
 const s=surface({responses:{'/api/fleet/live':[{id:1,lat:0,lng:0,recorded_at:recent()}]}});
 await s.context.controlDashboard();s.context.stopControlDashboard();s.nav.dataset.v='trips';
 assert.equal(s.timers.size,0);assert.equal(s.maps[0].removed,true);assert.ok(s.requests[0].options.signal.aborted);
});

test('respuesta tardía no sobrescribe una pantalla posterior',async()=>{
 let release;
 const s=surface({responses:{'/api/trips':()=>new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>[trip(1,'Detenido')]}))}});
 const pending=s.context.controlDashboard();s.context.stopControlDashboard();s.nav.dataset.v='trips';s.root.innerHTML='Otra pantalla';release();await pending;
 assert.equal(s.root.innerHTML,'Otra pantalla');assert.equal(s.timers.size,0);
});

test('pestaña oculta detiene consultas y reanuda solo con el dashboard seleccionado',async()=>{
 const s=surface();await s.context.controlDashboard();s.context.document.hidden=true;s.events.visibilitychange();assert.equal(s.timers.size,0);
 s.context.document.hidden=false;await s.events.visibilitychange();assert.equal(s.requests.length,6);
 s.nav.dataset.v='trips';await s.events.visibilitychange();assert.equal(s.requests.length,6);
});

test('mapa externo no disponible no borra la información operacional',async()=>{
 const s=surface({leaflet:false,responses:{'/api/fleet/live':[{id:1,lat:0,lng:0,recorded_at:recent()}],'/api/trips':[trip(1,'Detenido')]}});
 await s.context.controlDashboard();assert.match(s.elements.controlMap.innerHTML,/Mapa no disponible/);assert.match(s.root.innerHTML,/V-1/);
});

test('mapa base se dibuja sin flota ni coordenadas y no agrega vehículos ficticios',async()=>{
 for(const fleet of [[],[{id:1,lat:null,lng:null,recorded_at:null}]]){
  const s=surface({responses:{'/api/fleet/live':fleet}});await s.context.controlDashboard();
  assert.equal(s.maps.length,1);assert.equal(s.maps[0].world,true);assert.equal(s.maps[0].hasBaseLayer,true);
  assert.equal(s.maps[0].bounds,undefined);assert.equal(s.markers.length,0);
  assert.match(s.elements.controlMapNotice.textContent,/mapa base, sin ubicar vehículos/);assert.equal(s.elements.controlMapNotice.hidden,false);
 }
});

test('error GPS conserva mapa base y advierte que las posiciones no están disponibles',async()=>{
 const s=surface({responses:{'/api/fleet/live':{error:'GPS no disponible',status:503}}});await s.context.controlDashboard();
 assert.equal(s.maps[0].hasBaseLayer,true);assert.equal(s.markers.length,0);
 assert.match(s.elements.controlMapNotice.textContent,/No se pudo consultar GPS/);
});

test('posición válida centra el mapa en el vehículo y oculta aviso de ausencia de datos',async()=>{
 const s=surface({responses:{'/api/fleet/live':[{id:1,lat:-33,lng:-70,recorded_at:recent()}]}});await s.context.controlDashboard();
 assert.deepEqual(Array.from(s.maps[0].center),[-33,-70]);assert.equal(s.markers.length,1);
 assert.equal(s.elements.controlMapNotice.hidden,true);
});

test('sin Leaflet ni GPS muestra error cartográfico en vez de fallar silenciosamente',async()=>{
 const s=surface({leaflet:false});await s.context.controlDashboard();
 assert.equal(s.maps.length,0);assert.match(s.elements.controlMap.innerHTML,/Mapa no disponible/);
 assert.match(s.elements.controlMapNotice.textContent,/Sin posiciones GPS verificables/);
});

test('textos de API se escapan y no se interpolan identificadores ejecutables',async()=>{
 const s=surface({responses:{'/api/trips':[trip('1);alert(1)','Detenido',{trip_number:'<script>ataque</script>'})],'/api/alerts':[{title:'<img onerror=ataque>',text:'<script>ataque</script>',resolved:false}]}});
 await s.context.controlDashboard();assert.doesNotMatch(s.root.innerHTML,/<script>|<img onerror|onclick="window.openTrip\(1\);/);assert.match(s.root.innerHTML,/&lt;script&gt;/);
});

test('cada indicador abre su detalle; cero conserva una lista vacía verificable',async()=>{
 const s=surface();await s.context.controlDashboard();
 assert.equal((s.root.innerHTML.match(/aria-controls="operationalDetail"/g)||[]).length,6);
 for(const mode of ['all','transit','stopped','missing','alerts','gps']){
  s.context.openOperationalIndicator(mode);assert.equal(s.elements.operationalDetail.hidden,false);assert.match(s.elements.operationalDetail.innerHTML,/Volver al resumen/);
 }
 assert.match(s.elements.operationalDetail.innerHTML,/0 con señal reciente de 0/);
 s.context.closeOperationalDetail();assert.equal(s.elements.operationalDetail.hidden,true);
});

test('detalle no consulta de nuevo ni permite abrir una fuente denegada',async()=>{
 const s=surface({responses:{'/api/trips':{error:'Sin permiso',status:403},'/api/fleet/live':{error:'Sin permiso',status:403},'/api/alerts':{error:'Sin permiso',status:403}}});await s.context.controlDashboard();
 for(const mode of ['all','transit','stopped','missing','alerts','gps','invalido'])s.context.openOperationalIndicator(mode);
 assert.equal(s.elements.operationalDetail.hidden,true);assert.equal(s.requests.length,3);
});

test('refresco conserva selección y muestra fallo explícito sin reutilizar datos anteriores',async()=>{
 const responses={'/api/trips':[trip(1,'Detenido')]},s=surface({responses});await s.context.controlDashboard();s.context.openOperationalIndicator('stopped');assert.match(s.elements.operationalDetail.innerHTML,/V-1/);
 responses['/api/trips']={error:'No disponible',status:503};await s.context.controlDashboard();assert.match(s.elements.operationalDetail.innerHTML,/Viajes no disponibles/);assert.doesNotMatch(s.elements.operationalDetail.innerHTML,/V-1/);
});

test('detalle de alarmas escapa texto y descarta identificadores ejecutables',async()=>{
 const s=surface({responses:{'/api/alerts':[{title:'<script>ataque</script>',text:'<img onerror=ataque>',source_type:'truck',source_id:'1);alert(1)',resolved:false}]}});await s.context.controlDashboard();s.context.openOperationalIndicator('alerts');
 assert.match(s.elements.operationalDetail.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(s.elements.operationalDetail.innerHTML,/<script>|<img|onclick="openTruck/);
});
