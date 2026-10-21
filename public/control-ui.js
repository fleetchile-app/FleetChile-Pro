(function(){
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const terminal=status=>['Completado','Cancelado'].includes(status);
const contextKey=()=>Auth.user?.actor_type==='platform'?localStorage.getItem('fleet_company_context')||'':String(Auth.user?.company_id||'');
const selected=()=>document.querySelector('#nav button.active')?.dataset.v==='controlDashboard';
const active=()=>Boolean(Auth.user)&&selected()&&!document.hidden&&Boolean(contextKey());
const validId=value=>/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const coordinate=value=>value!==null&&value!==undefined&&String(value).trim()!==''&&['number','string'].includes(typeof value)&&Number.isFinite(Number(value));
const hasPosition=truck=>coordinate(truck.lat)&&coordinate(truck.lng)&&Math.abs(Number(truck.lat))<=90&&Math.abs(Number(truck.lng))<=180;
const signalInfo=truck=>{
 if(!hasPosition(truck)||!truck.recorded_at)return {kind:'none',label:'Sin posición verificada',detail:'No hay telemetría con coordenadas y fecha válidas'};
 const time=new Date(truck.recorded_at).getTime(),age=Date.now()-time;
 if(!Number.isFinite(time)||age<0)return {kind:'error',label:'Fecha GPS inválida',detail:'No se puede verificar la antigüedad'};
 const minutes=Math.floor(age/60000);
 return age<=15*60000?{kind:'recent',label:'Señal reciente',detail:minutes<1?'Hace menos de un minuto':`Hace ${minutes} min`}:{kind:'old',label:'Señal antigua',detail:minutes<1440?`Hace ${minutes} min`:`Hace ${Math.floor(minutes/1440)} d`};
};
const formatTime=value=>value?new Date(value).toLocaleString('es-CL'):'Sin fecha';
let timer=null,controller=null,generation=0,filter='all';
window.stopControlDashboard=function(){
 generation++;clearTimeout(timer);timer=null;controller?.abort();controller=null;
 if(window.controlMap){window.controlMap.remove();window.controlMap=null}
};
async function query(path,signal){
 const response=await fetch('/api/'+path,{signal});
 let data;try{data=await response.json()}catch{throw Error('Respuesta del servidor no válida')}
 if(!response.ok)throw Error(response.status===403?'Sin permiso para consultar esta información':data?.error||`Error ${response.status}`);
 if(!Array.isArray(data))throw Error('La consulta no devolvió una lista válida');
 return data;
}
const note=result=>result.status==='fulfilled'?'':`<p class="operational-error" role="status">${esc(result.reason?.message||'Consulta no disponible')}. No se muestra como cero.</p>`;
const counter=(label,value,detail,mode)=>`<button class="control-kpi operational-counter ${filter===mode?'selected':''}" onclick="filterOperationalTrips('${mode}')" aria-pressed="${filter===mode}" ${value===null?'disabled':''}><span>${label}</span><b>${value===null?'N/D':value}</b><small>${detail}</small></button>`;
function tripRows(trips){
 const rows=trips.filter(trip=>filter==='stopped'?trip.status==='Detenido':filter==='transit'?trip.status==='En tránsito':filter==='missing'?!trip.truck_id||!trip.driver_id:true);
 return rows.length?rows.map(trip=>`<button class="control-trip-row" ${validId(trip.id)?`onclick="window.openTrip(${Number(trip.id)})"`:'disabled'}><span class="trip-status-dot ${trip.status==='Detenido'?'stopped':''}"></span><span class="trip-number"><b>${esc(trip.trip_number||'#'+trip.id)}</b><small>${esc(trip.origin||'Origen sin informar')} → ${esc(trip.destination||'Destino sin informar')}</small></span><span><b>${esc(trip.patente||'Sin camión')}</b><small>${esc(trip.driver_name||'Sin conductor')}</small></span><span class="badge ${trip.status==='Detenido'?'red':''}">${esc(trip.status)}</span><span class="chevron">›</span></button>`).join(''):'<div class="empty-state">No hay viajes para este filtro.</div>';
}
let currentTrips=[];
window.filterOperationalTrips=function(mode){
 if(!['all','transit','stopped','missing'].includes(mode))return;
 filter=mode;
 const list=document.getElementById('controlTrips');if(list)list.innerHTML=tripRows(currentTrips);
 document.querySelectorAll('.operational-counter').forEach(button=>{const chosen=button.getAttribute('onclick')===`filterOperationalTrips('${mode}')`;button.classList.toggle('selected',chosen);button.setAttribute('aria-pressed',String(chosen))});
};
window.controlDashboard=async function(){
 window.stopControlDashboard();
 if(!contextKey()){A.innerHTML='<div class="card"><h3>Selecciona una empresa</h3><p>El dashboard operativo no mezcla operaciones de distintas empresas.</p></div>';return}
 if(!active())return;
 const requestGeneration=generation,key=contextKey();
 controller=new AbortController();
 const requestController=controller,timeout=setTimeout(()=>requestController.abort(),10000);
 if(!document.getElementById('operationalDashboard'))A.innerHTML='<div class="card" role="status">Cargando operación…</div>';
 try{
  const [gps,trips,alerts]=await Promise.allSettled(['fleet/live','trips','alerts'].map(path=>query(path,controller.signal)));
  if(requestGeneration!==generation||!active()||key!==contextKey())return;
  // El administrador legacy conserva APIs transversales: esta vista siempre es empresarial.
  const legacyAdmin=Auth.user.role_code==='admin'&&!Auth.user.membership_id&&!Auth.user.platform_membership_id;
  const companyRows=rows=>legacyAdmin?rows.filter(row=>String(row.company_id)===key):rows;
  const fleet=gps.status==='fulfilled'?companyRows(gps.value):null;
  currentTrips=trips.status==='fulfilled'?companyRows(trips.value).filter(trip=>!terminal(trip.status)):[];
  const openAlerts=alerts.status==='fulfilled'?companyRows(alerts.value).filter(alert=>!alert.resolved):null;
  const stopped=trips.status==='fulfilled'?currentTrips.filter(trip=>trip.status==='Detenido').length:null;
  const transit=trips.status==='fulfilled'?currentTrips.filter(trip=>trip.status==='En tránsito').length:null;
  const missing=trips.status==='fulfilled'?currentTrips.filter(trip=>!trip.truck_id||!trip.driver_id).length:null;
  const priorityAlerts=openAlerts?[...openAlerts].sort((a,b)=>(b.level==='critical')-(a.level==='critical')||new Date(b.created_at)-new Date(a.created_at)):[];
  A.innerHTML=`<div id="operationalDashboard"><div class="control-head"><div><div class="eyebrow">CENTRO DE CONTROL</div><h2>Dashboard operativo</h2><p>Consulta automática cada 30 segundos mientras esta vista esté visible. Último intento: ${esc(formatTime(new Date().toISOString()))}.</p><p>Ubicación recibida del GPS: revisa su fecha. Una velocidad cero no significa que el viaje esté detenido.</p></div><button class="secondary" onclick="controlDashboard()">Actualizar ahora</button></div>
   <div class="control-kpis operational-kpis">${counter('Viajes abiertos',trips.status==='fulfilled'?currentTrips.length:null,'Incluye planificación y ejecución','all')}${counter('En tránsito',transit,'Estado declarado del viaje','transit')}${counter('Detenidos',stopped,'Estado Detenido; no inferido por GPS','stopped')}${counter('Recursos pendientes',missing,'Falta camión o conductor','missing')}<div class="control-kpi"><span>Alarmas abiertas</span><b>${openAlerts===null?'N/D':openAlerts.length}</b><small>${openAlerts===null?'Consulta no disponible':priorityAlerts.filter(alert=>alert.level==='critical').length+' críticas'}</small></div><div class="control-kpi"><span>GPS reciente / flota</span><b>${fleet===null?'N/D':fleet.filter(truck=>signalInfo(truck).kind==='recent').length+' / '+fleet.length}</b><small>Última posición de hasta 15 minutos</small></div></div>
   <div class="control-layout"><div class="card control-map-card"><div class="section-head"><div><h3>Ubicación de la flota</h3><span class="muted">Última telemetría registrada; las posiciones antiguas se distinguen en ámbar.</span></div></div>${note(gps)}<p id="controlMapNotice" class="muted" role="status" hidden></p><div id="controlMap" class="control-map"></div></div><div class="card control-status-card"><div class="section-head"><h3>Estado de señal GPS</h3></div><div class="fleet-status-list">${fleet===null?'<p class="muted">Flota GPS no disponible.</p>':fleet.map(truck=>{const signal=signalInfo(truck);return `<button class="fleet-status-row" ${validId(truck.id)?`onclick="openTruck(${Number(truck.id)})"`:'disabled'}><span class="fleet-dot ${signal.kind==='recent'?'moving':'maintenance'}"></span><span class="fleet-main"><b>${esc(truck.patente)}</b><small>${esc(truck.status||'Estado sin informar')} · ${esc(signal.detail)}</small><small>${esc(truck.recorded_at?formatTime(truck.recorded_at):'Sin fecha GPS')}</small></span><span class="gps-signal ${signal.kind}">${esc(signal.label)}</span><span class="chevron">›</span></button>`}).join('')||'<p class="muted">No hay vehículos registrados.</p>'}</div></div></div>
   <div class="control-bottom"><div class="card"><div class="section-head"><div><h3>Viajes abiertos</h3><span class="muted">Filtra con los indicadores superiores y abre la ficha para actuar.</span></div></div>${note(trips)}<div id="controlTrips" class="control-trips">${trips.status==='fulfilled'?tripRows(currentTrips):'<p>Viajes no disponibles.</p>'}</div></div><div class="card"><div class="section-head"><div><h3>Incidentes y alarmas</h3><span class="muted">Alertas registradas; críticas primero. No se generan alarmas ficticias.</span></div><button class="secondary" onclick="render('alerts')">Ver todas</button></div>${note(alerts)}<div class="operational-alerts">${openAlerts===null?'<p>Alarmas no disponibles.</p>':priorityAlerts.map(alert=>`<div class="control-alert"><span class="alert-icon">!</span><div><b>${esc(alert.title)}</b><small>${esc(alert.text)}</small><small>${esc(formatTime(alert.created_at))}</small>${alert.source_type==='trip'&&validId(alert.source_id)&&trips.status==='fulfilled'?`<button class="secondary smallbtn" onclick="window.openTrip(${Number(alert.source_id)})">Ver viaje</button>`:''}</div><span class="badge ${alert.level==='critical'?'red':'amber'}">${alert.level==='critical'?'Crítica':'Advertencia'}</span></div>`).join('')||'<div class="empty-state">No hay alarmas pendientes.</div>'}</div></div></div></div>`;
  makeControlMap(fleet);
 }catch(error){
  if(requestGeneration===generation&&active())A.innerHTML=`<div class="card"><h3>No se pudo actualizar la operación</h3><p>${esc(error.message)}</p><button class="secondary" onclick="controlDashboard()">Reintentar</button></div>`;
 }finally{
  clearTimeout(timeout);
  if(requestGeneration===generation&&active())timer=setTimeout(()=>window.controlDashboard(),30000);
 }
};
function makeControlMap(fleet){
 const element=document.getElementById('controlMap');if(!element)return;
 const positions=(fleet||[]).filter(truck=>hasPosition(truck)&&['recent','old'].includes(signalInfo(truck).kind));
 const notice=document.getElementById('controlMapNotice');
 if(notice){notice.textContent=!fleet?'No se pudo consultar GPS. Mapa base sin posiciones de vehículos.':!positions.length?'Sin posiciones GPS verificables. Se muestra el mapa base, sin ubicar vehículos.':'';notice.hidden=!notice.textContent}
 if(typeof L==='undefined'){element.innerHTML='<div class="empty-state">Mapa no disponible. Consulta la fecha y estado GPS en el listado.</div>';return}
 const map=L.map(element).fitWorld();window.controlMap=map;
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 const points=positions.map(truck=>{
  const signal=signalInfo(truck),point=[Number(truck.lat),Number(truck.lng)];
  L.circleMarker(point,{radius:8,color:signal.kind==='recent'?'#1670b8':'#a9680a',fillOpacity:.8}).addTo(map).bindPopup(`<div class="map-popup"><b>${esc(truck.patente)}</b><span>${esc(truck.status)}</span><small>${esc(signal.label)} · ${esc(signal.detail)}</small><small>${esc(formatTime(truck.recorded_at))}</small><small>${coordinate(truck.speed_kmh)?Number(truck.speed_kmh).toLocaleString('es-CL')+' km/h':'Velocidad sin informar'}</small>${validId(truck.id)?`<button onclick="openTruck(${Number(truck.id)})">Ver ficha</button>`:''}</div>`);
  return point;
 });
 if(points.length===1)map.setView(points[0],13);else if(points.length>1)map.fitBounds(points,{padding:[30,30]});
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)window.stopControlDashboard();else if(selected())window.controlDashboard()});
window.addEventListener('beforeunload',window.stopControlDashboard);
})();
