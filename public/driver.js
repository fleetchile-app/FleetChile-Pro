(function(){
 const root=document.getElementById('driverApp');
 const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
 const date=v=>v?new Date(v).toLocaleString('es-CL'):'No informado';
 let gpsWatch=null,gpsTripId=null,gpsLastSent=0,gpsGeneration=0,sessionVersion=0,viewVersion=0,signingOut=false;
 const status=v=>`<span class="driver-status">${esc(v||'Sin estado')}</span>`;
 function expireSession(){
  stopGps();sessionVersion++;viewVersion++;Auth.token='';Auth.user=null;
  localStorage.removeItem('fleet_token');localStorage.removeItem('fleet_company_context');
  login('Tu sesión venció. Inicia sesión nuevamente.');
 }
 async function api(path,options){
  if(signingOut)throw new Error('La sesión se está cerrando.');
  const version=sessionVersion;
  const r=await fetch(path,options),data=await r.json().catch(()=>({}));
  if(version!==sessionVersion)throw new Error('La sesión cambió.');
  if(r.status===401)expireSession();
  if(!r.ok)throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{status:r.status});
  return data;
 }
 function accountHeader(){
  const user=Auth.user||{},canTravel=user.role_code==='driver'&&user.driver_id&&!user.must_change_password;
  return `<header class="driver-header"><div class="driver-brand">FleetChile · Conductor</div><details class="driver-account"><summary>Mi cuenta</summary><div class="driver-account-panel"><strong>${esc(user.name||'Usuario')}</strong><span>${esc(user.company_name||'Empresa no identificada')}</span><span>${esc(user.email||'')}</span>${canTravel?'<button type="button" class="driver-link" data-driver-home>Mis viajes</button><button type="button" class="driver-link" data-driver-refresh>Actualizar viajes</button>':''}<button type="button" class="driver-link" data-driver-password>Cambiar contraseña</button><button type="button" class="driver-button driver-logout" data-driver-logout>Cerrar sesión</button><p class="driver-account-error" role="alert" hidden></p></div></details></header>`;
 }
 function leaveForm(){return !root.querySelector('.driver-delivery-form')||confirm('Hay una entrega abierta. Los datos sin guardar se perderán. ¿Continuar?')}
 function authenticatedScreen(content){
  root.innerHTML=`<section class="driver-shell">${accountHeader()}${content}</section>`;
  root.querySelector('[data-driver-logout]').onclick=logoutDriver;
  root.querySelector('[data-driver-password]').onclick=()=>{if(leaveForm())changePassword()};
  for(const selector of ['[data-driver-home]','[data-driver-refresh]']){
   const button=root.querySelector(selector);
   if(button)button.onclick=()=>{if(leaveForm())loadTrips()};
  }
  const account=root.querySelector('.driver-account');
  account.onkeydown=event=>{if(event.key==='Escape'){account.open=false;account.querySelector('summary').focus()}};
 }
 async function logoutDriver(){
  if(signingOut||!confirm('¿Cerrar sesión? Se detendrá el GPS en este dispositivo y se perderán los datos sin guardar.'))return;
  signingOut=true;stopGps();sessionVersion++;viewVersion++;
  root.innerHTML='<section class="driver-shell"><div class="driver-card" role="status"><h1>Cerrando sesión…</h1><p>GPS detenido. Espera la confirmación antes de dejar el dispositivo.</p></div></section>';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  try{
   const result=await Auth.logout({signal:controller.signal});
   pendingDeliverySubmissions.clear();
   login(result?.remoteRevoked===false?'Sesión cerrada en este dispositivo; no fue posible confirmar el cierre en el servidor.':'Sesión cerrada en este dispositivo.',true);
  }catch{
   authenticatedScreen('<div class="driver-card driver-error" role="alert"><h1>No se pudo cerrar la sesión</h1><p>El GPS está detenido. Reintenta desde Mi cuenta antes de dejar el dispositivo.</p></div>');
  }finally{clearTimeout(timeout);signingOut=false}
 }
 function changePassword(){
  stopGps();viewVersion++;
  authenticatedScreen(`<div class="driver-card"><h1>Cambiar contraseña</h1><p>${Auth.user.must_change_password?'Debes reemplazar tu contraseña temporal para continuar.':'Usa al menos 10 caracteres para tu nueva contraseña.'}</p><form class="driver-login" id="driverPassword"><label>Contraseña actual<input name="current_password" type="password" autocomplete="current-password" required></label><label>Nueva contraseña<input name="new_password" type="password" autocomplete="new-password" minlength="10" required></label><label>Repetir nueva contraseña<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required></label><p class="driver-password-error driver-error" role="alert" hidden></p><button class="driver-button" type="submit">Guardar contraseña</button></form></div>`);
  const form=root.querySelector('#driverPassword');
  form.onsubmit=async event=>{
   event.preventDefault();const version=sessionVersion,view=viewVersion,button=form.querySelector('button'),error=form.querySelector('.driver-password-error');
   const data=Object.fromEntries(new FormData(form));error.hidden=true;
   if(data.new_password.length<10||data.new_password!==data.confirm_password){error.textContent='La nueva contraseña debe tener al menos 10 caracteres y coincidir.';error.hidden=false;return}
   button.disabled=true;let changed=false;
   try{
    await Auth.changePassword(data.current_password,data.new_password,data.confirm_password);
    changed=true;
    if(version!==sessionVersion||view!==viewVersion)return;
    const identity=await Auth.request('/api/auth/me');
    if(version!==sessionVersion||view!==viewVersion)return;
    Auth.user=identity.user;
    await window.driverBoot({authenticated:true});
   }catch(e){if(version===sessionVersion&&view===viewVersion){if(e.status===401)return expireSession();error.textContent=changed?'La contraseña fue cambiada, pero no se pudo actualizar la sesión. Cierra sesión e ingresa con tu nueva contraseña.':e.message;error.hidden=false}}
   finally{button.disabled=false}
  };
 }
 function login(error='',notice=false){root.innerHTML=`<section class="driver-shell"><div class="driver-card"><div class="driver-brand">FleetChile · Conductor</div><h1>Iniciar sesión</h1>${error?`<p class="${notice?'driver-success':'driver-error'}" role="${notice?'status':'alert'}">${esc(error)}</p>`:''}<form class="driver-login" id="driverLogin"><label>Correo<input name="email" type="email" autocomplete="username" required></label><label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label><button class="driver-button">Ingresar</button></form></div></section>`;root.querySelector('form').onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));try{await Auth.login(data.email,data.password);window.driverBoot({authenticated:true})}catch(error){login(error.message)}}}
 async function changeStatus(id,button){const version=sessionVersion,view=viewVersion;button.disabled=true;try{await api(`/api/driver/trips/${encodeURIComponent(id)}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:button.dataset.status})});if(version===sessionVersion&&view===viewVersion)await loadDetail(id)}catch(error){const box=root.querySelector('.driver-actions');box?.insertAdjacentHTML('beforeend',`<p class="driver-error">${esc(error.message)}</p>`)}finally{button.disabled=false}}
 function stopGps(){gpsGeneration++;if(gpsWatch!==null&&navigator.geolocation)navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;gpsTripId=null}
 function startGps(trip){const box=root.querySelector('.driver-gps');if(!['En tránsito','Detenido'].includes(trip.status)){stopGps();box.innerHTML='<h3>GPS</h3><p>Captura no activa para este estado.</p>';return}if(!navigator.geolocation){box.innerHTML='<h3>GPS</h3><p class="driver-error">Este navegador no soporta geolocalización.</p>';return}if(gpsWatch!==null&&gpsTripId===trip.id)return;stopGps();const generation=++gpsGeneration;gpsTripId=trip.id;box.innerHTML='<h3>GPS</h3><p>Solicitando posición…</p>';gpsWatch=navigator.geolocation.watchPosition(async position=>{if(generation!==gpsGeneration||gpsTripId!==trip.id||!['En tránsito','Detenido'].includes(trip.status))return;const now=Date.now();if(now-gpsLastSent<10000)return;gpsLastSent=now;if(generation!==gpsGeneration||gpsTripId!==trip.id)return;try{const sent=await api(`/api/driver/trips/${encodeURIComponent(trip.id)}/positions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:position.coords.latitude,lng:position.coords.longitude,speed_kmh:position.coords.speed===null?0:position.coords.speed*3.6,recorded_at:new Date(position.timestamp).toISOString()})});if(generation!==gpsGeneration||gpsTripId!==trip.id)return;box.innerHTML=`<h3>GPS</h3><p class="driver-gps-active">Captura activa · última posición ${date(sent.recorded_at)}</p>`}catch(error){if(generation!==gpsGeneration||gpsTripId!==trip.id)return;box.innerHTML=`<h3>GPS</h3><p class="driver-error">Sin conexión: ${esc(error.message)}</p>`}},error=>{if(generation!==gpsGeneration||gpsTripId!==trip.id)return;box.innerHTML=`<h3>GPS</h3><p class="driver-error">${esc(error.code===1?'Permiso de ubicación denegado':error.code===2?'Posición no disponible':'Tiempo de espera agotado')}</p>`},{enableHighAccuracy:true,maximumAge:10000,timeout:15000})}
 async function loadChecklist(id){const box=root.querySelector('.driver-checklist');try{const data=await api(`/api/driver/trips/${encodeURIComponent(id)}/checklist`);const current=data.checklists?.[0];box.innerHTML=`<h3>Checklist preoperacional</h3>${current?`<p>${status(current.status)} ${current.status==='Rechazado'?'<span class="driver-error">Incidencia generada para gestión operacional.</span>':''}</p><textarea class="driver-checklist-items" ${current.status!=='Pendiente'?'disabled':''}>${esc(JSON.stringify(current.items||[],null,2))}</textarea><textarea class="driver-checklist-notes" placeholder="Observaciones" ${current.status!=='Pendiente'?'disabled':''}>${esc(current.observations||'')}</textarea>${current.status==='Pendiente'?'<button class="driver-button" data-check-action="Aprobado">Cerrar aprobado</button><button class="driver-button driver-reject" data-check-action="Rechazado">Cerrar rechazado</button>':''}`:'<p>No hay checklist registrado.</p><button class="driver-button" id="startChecklist">Iniciar checklist</button>'}`;root.querySelector('#startChecklist')?.addEventListener('click',async()=>{try{await api(`/api/driver/trips/${encodeURIComponent(id)}/checklist`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[]})});await loadChecklist(id)}catch(e){box.insertAdjacentHTML('beforeend',`<p class="driver-error">${esc(e.message)}</p>`)}});root.querySelectorAll('[data-check-action]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const items=JSON.parse(root.querySelector('.driver-checklist-items').value||'[]');await api(`/api/driver/checklists/${encodeURIComponent(current.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:button.dataset.checkAction,items,observations:root.querySelector('.driver-checklist-notes').value})});await loadChecklist(id)}catch(e){box.insertAdjacentHTML('beforeend',`<p class="driver-error">${esc(e.message)}</p>`);button.disabled=false}}))}catch(e){box.innerHTML=`<p class="driver-error">${esc(e.message)}</p>`}}
 function signatureCanvas(){const canvas=document.createElement('canvas');canvas.width=900;canvas.height=360;canvas.className='driver-signature-canvas';const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#173b5d';ctx.lineWidth=4;ctx.lineCap='round';let drawing=false,empty=true;const point=e=>{const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}};canvas.addEventListener('pointerdown',e=>{drawing=true;empty=false;canvas.setPointerCapture(e.pointerId);const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y)});canvas.addEventListener('pointermove',e=>{if(!drawing)return;const p=point(e);ctx.lineTo(p.x,p.y);ctx.stroke()});canvas.addEventListener('pointerup',()=>{drawing=false});canvas.addEventListener('pointercancel',()=>{drawing=false});canvas.clear=()=>{ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#173b5d';empty=true};canvas.value=()=>empty?'':canvas.toDataURL('image/png');return canvas}
 const pendingDeliverySubmissions=new Map();
 function deliverySubmissionKey(tripId,loadId){
  const user=typeof Auth==='undefined'?null:Auth.user;
  return ['fleet_pod_submission',user?.id||'',user?.company_id||'',user?.driver_id||'',tripId,loadId].join(':');
 }
 function readDeliverySubmission(key){
  try{return sessionStorage.getItem(key)||pendingDeliverySubmissions.get(key)||null}catch{return pendingDeliverySubmissions.get(key)||null}
 }
 function rememberDeliverySubmission(key,value){
  pendingDeliverySubmissions.set(key,value);
  try{sessionStorage.setItem(key,value)}catch{}
 }
 function clearDeliverySubmission(key){
  pendingDeliverySubmissions.delete(key);
  try{sessionStorage.removeItem(key)}catch{}
 }
 function deliveryForm(tripId,load){
  const draft=load.deliveries?.find(proof=>proof.status==='DRAFT');
  const draftSubmission=typeof draft?.client_submission_id==='string'?draft.client_submission_id.trim():'';
  const hasSignature=Boolean(draft?.evidence?.some(file=>file.type==='signature'&&file.exists===true));
  const hasPhoto=Boolean(draft?.evidence?.some(file=>file.type==='photo'&&file.exists===true));
  const key=deliverySubmissionKey(tripId,load.id);
  const submission=draft?draftSubmission:readDeliverySubmission(key)||crypto.randomUUID();
  let sending=false,completed=false;
  const card=document.createElement('div');
  card.className='driver-card driver-delivery-form';
  card.innerHTML=`<h3>Registrar entrega</h3><p><b>${esc(load.cargo)}</b></p><label>Receptor<input class="delivery-recipient" required maxlength="160"></label><label>RUT (opcional)<input class="delivery-rut" maxlength="30"></label><label>Observaciones<textarea class="delivery-notes" maxlength="2000"></textarea></label><label>Firma manuscrita del receptor <span class="driver-hint">obligatoria</span></label><div class="signature-host"></div><button type="button" class="driver-link clear-signature">Limpiar firma</button><label>Fotografía opcional<input class="delivery-photo" type="file" accept="image/*" capture="environment"></label><img class="delivery-preview" alt="Vista previa de evidencia" hidden><p class="delivery-error driver-error" hidden></p><button type="button" class="driver-button submit-delivery">Confirmar entrega</button>`;
  const canvas=signatureCanvas();
  card.querySelector('.signature-host').append(canvas);
  const photo=card.querySelector('.delivery-photo'),preview=card.querySelector('.delivery-preview');
  const button=card.querySelector('.submit-delivery'),error=card.querySelector('.delivery-error');
  if(draft){
   card.querySelector('.delivery-recipient').value=draft.recipient_name||'';
   card.querySelector('.delivery-rut').value=draft.recipient_rut||'';
   card.querySelector('.delivery-notes').value=draft.notes||'';
   button.textContent='Confirmar borrador';
  }
  if(hasSignature)card.querySelector('.driver-hint').textContent='registrada; se verificará al confirmar';
  if(hasPhoto)card.insertAdjacentHTML('afterbegin','<p class="driver-success">Fotografía registrada en el borrador; se verificará al confirmar.</p>');
  if(draft&&!draftSubmission){
   error.textContent='No se puede reanudar este borrador: falta su identificador. Solicita revisión a administración.';
   error.hidden=false;
   button.disabled=true;
  }
  photo.onchange=()=>{
   const file=photo.files?.[0];
   if(!file){preview.hidden=true;return}
   preview.src=URL.createObjectURL(file);preview.hidden=false;
  };
  card.querySelector('.clear-signature').onclick=()=>canvas.clear();
  button.onclick=async()=>{
   if(sending||completed||!submission)return;
   const version=sessionVersion,view=viewVersion;
   const signature=canvas.value(),recipient=card.querySelector('.delivery-recipient').value.trim();
   if(!signature&&!hasSignature){error.textContent='La firma del receptor es obligatoria.';error.hidden=false;return}
   if(!recipient){error.textContent='El nombre del receptor es obligatorio.';error.hidden=false;return}
   sending=true;button.disabled=true;error.hidden=true;
   try{
    rememberDeliverySubmission(key,submission);
    let position=null;
    if(navigator.geolocation)await new Promise(resolve=>navigator.geolocation.getCurrentPosition(p=>{position=p;resolve()},()=>resolve(),{maximumAge:10000,timeout:3000}));
    if(version!==sessionVersion||view!==viewVersion)return;
    const file=photo.files?.[0];
    const payload={load_id:load.id,client_submission_id:submission,recipient_name:recipient,recipient_rut:card.querySelector('.delivery-rut').value.trim()||undefined,notes:card.querySelector('.delivery-notes').value.trim()||undefined};
    if(signature)payload.signature=signature;
    if(file)payload.photo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});
    if(version!==sessionVersion||view!==viewVersion)return;
    if(position){payload.latitude=position.coords.latitude;payload.longitude=position.coords.longitude}
    await api('/api/driver/trips/'+encodeURIComponent(tripId)+'/deliveries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    completed=true;
    clearDeliverySubmission(key);
    card.innerHTML='<p class="driver-success">Entrega registrada correctamente.</p>';
    if(view===viewVersion)await loadDeliveries(tripId);
   }catch(e){
    error.textContent=e.message||'No se pudo registrar la entrega.';
    error.hidden=false;button.disabled=false;button.textContent='Reintentar entrega';
   }finally{sending=false}
  };
  return card;
 }
 async function loadDeliveries(tripId){const detail=root.querySelector('.driver-detail');if(!detail)return;let box=detail.querySelector('.driver-deliveries');if(!box){box=document.createElement('div');box.className='driver-card driver-deliveries';detail.append(box)}box.innerHTML='<h3>Entregas</h3><p>Cargando cargas…</p>';try{const data=await api(`/api/driver/trips/${encodeURIComponent(tripId)}/deliveries`);box.innerHTML=`<h3>Entregas</h3>${data.deliveries?.length?data.deliveries.map(load=>`<div class="driver-delivery-row"><div><b>${esc(load.cargo)}</b><span>${esc(load.status)}</span></div>${load.status==='Entregada'?'<span class="driver-success">Completada</span>':'<button class="driver-button delivery-start">Entregar</button>'}</div>`).join(''):'<p>No hay cargas registradas.</p>'}`;const rows=[...box.querySelectorAll('.driver-delivery-row')];data.deliveries?.forEach((load,index)=>rows[index]?.querySelector('.delivery-start')?.addEventListener('click',()=>{const old=box.querySelector('.driver-delivery-form');old?.remove();box.append(deliveryForm(tripId,load))}))}catch(e){box.innerHTML=`<h3>Entregas</h3><p class="driver-error">${esc(e.message)}</p>`}}
 const _driverLoadChecklist=loadChecklist;loadChecklist=async id=>{const version=sessionVersion,view=viewVersion;await _driverLoadChecklist(id);if(version===sessionVersion&&view===viewVersion)await loadDeliveries(id)};
 function renderActions(allowed=[]){return `<div class="driver-actions">${allowed.map(s=>`<button class="driver-button driver-status-action" data-status="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
 function renderDetail(trip,allowed){root.querySelector('.driver-detail').innerHTML=`<button class="driver-link" id="backTrips">← Volver a viajes</button><div class="driver-card"><h2>${esc(trip.trip_number)}</h2>${status(trip.status)}${renderActions(allowed)}<div class="driver-meta"><div><small>Origen</small><b>${esc(trip.origin)}</b></div><div><small>Destino</small><b>${esc(trip.destination)}</b></div><div><small>Salida</small><b>${date(trip.planned_departure)}</b></div><div><small>Camión</small><b>${esc(trip.patente||'No asignado')}</b></div><div><small>Cliente</small><b>${esc(trip.client_name||'No informado')}</b></div><div><small>Ruta</small><b>${esc(trip.route_origin||trip.origin)} → ${esc(trip.route_destination||trip.destination)}</b></div></div><h3>Cargas</h3>${trip.loads?.length?`<ul class="driver-list">${trip.loads.map(load=>`<li><b>${esc(load.cargo)}</b><span>${esc(load.status)} · ${esc(load.weight_kg)} kg</span></li>`).join('')}</ul>`:'<p>No hay cargas registradas.</p>'}</div><div class="driver-card driver-gps"></div><div class="driver-card driver-checklist"><p>Cargando checklist…</p></div>`;root.querySelector('#backTrips').onclick=()=>{stopGps();loadTrips()};root.querySelectorAll('.driver-status-action').forEach(button=>button.onclick=()=>changeStatus(trip.id,button));startGps(trip);loadChecklist(trip.id)}
 async function loadDetail(id){
  const view=++viewVersion,version=sessionVersion,box=root.querySelector('.driver-detail');
  if(!box||signingOut)return;
  box.innerHTML='<p>Cargando detalle…</p>';
  try{
   const trip=await api(`/api/driver/trips/${encodeURIComponent(id)}`);
   if(version!==sessionVersion||view!==viewVersion)return;
   const allowed=(await api(`/api/driver/trips/${encodeURIComponent(id)}/allowed-statuses`)).allowed_statuses;
   if(version===sessionVersion&&view===viewVersion)renderDetail(trip,allowed);
  }catch(e){if(version===sessionVersion&&view===viewVersion)box.innerHTML=`<p class="driver-error">${esc(e.message)}</p>`}
 }
 async function loadTrips(){
  if(signingOut)return;
  stopGps();const view=++viewVersion,version=sessionVersion;
  authenticatedScreen('<div class="driver-card"><small>Conductor</small><h1>'+esc(Auth.user.name)+'</h1><p>'+esc(Auth.user.company_name||'Empresa no identificada')+'</p></div><div class="driver-detail"><div class="driver-card"><h2>Mis viajes</h2><p>Cargando viajes asignados…</p></div></div>');
  const list=root.querySelector('.driver-detail');
  try{
   const trips=await api('/api/driver/trips');
   if(version!==sessionVersion||view!==viewVersion)return;
   list.innerHTML=`<div class="driver-card"><h2>Mis viajes</h2>${trips.length?`<ul class="driver-list">${trips.map(t=>`<li><button class="driver-trip" data-id="${esc(t.id)}"><b>${esc(t.trip_number)}</b>${status(t.status)}<span>${esc(t.origin)} → ${esc(t.destination)}</span><small>${date(t.planned_departure)}</small></button></li>`).join('')}</ul>`:'<p>No tienes viajes asignados.</p>'}</div>`;
   root.querySelectorAll('.driver-trip').forEach(button=>button.onclick=()=>loadDetail(button.dataset.id));
  }catch(e){if(version===sessionVersion&&view===viewVersion)list.innerHTML=`<div class="driver-card"><p class="driver-error" role="alert">${esc(e.message)}</p><button class="driver-button" id="retryDriverTrips">Reintentar</button></div>`;root.querySelector('#retryDriverTrips')?.addEventListener('click',loadTrips)}
 }
 window.driverBoot=({authenticated=false,error=null,setupRequired=false}={})=>{
  stopGps();sessionVersion++;viewVersion++;
  if(setupRequired)return login('La configuración inicial debe realizarse desde la aplicación administrativa.');
  if(!authenticated||!Auth.user)return login(error?.message||'Inicia sesión para acceder.');
  if(Auth.user.must_change_password)return changePassword();
  if(Auth.user.role_code!=='driver')return authenticatedScreen('<div class="driver-card driver-error"><h1>Acceso no disponible</h1><p>Esta superficie está reservada para usuarios con rol conductor. Puedes cerrar sesión e ingresar con otra cuenta.</p></div>');
  if(!Auth.user.driver_id)return authenticatedScreen('<div class="driver-card driver-error"><h1>Conductor no asociado</h1><p>Tu cuenta todavía no tiene un conductor asociado. Solicita a administración que revise la asociación.</p></div>');
  return loadTrips();
 };
 const loadDetailWithDeliveries=loadDetail;loadDetail=async id=>{const version=sessionVersion,view=viewVersion+1;await loadDetailWithDeliveries(id);if(version===sessionVersion&&view===viewVersion&&root.querySelector('.driver-detail'))await loadDeliveries(id)};
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js',{scope:'/driver'});
})();
