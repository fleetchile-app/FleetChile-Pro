(function(){
 const root=document.getElementById('driverApp');
 const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
 const date=v=>v?new Date(v).toLocaleString('es-CL'):'No informado';
 let gpsWatch=null,gpsTripId=null,gpsLastSent=0,gpsGeneration=0,sessionVersion=0,viewVersion=0,signingOut=false;
 let gpsTrip=null,gpsConsent=false,gpsTimer=null,gpsPermission=null,gpsNeedsReview=false;
 const gpsRequests=new Set();
 let gpsMessage='Abre un viaje En tránsito o Detenido para activar la ubicación.',gpsMode='paused',gpsConfirmed=null;
 const status=v=>`<span class="driver-status">${esc(v||'Sin estado')}</span>`;
 function expireSession(){
  stopGps();window.DriverMobile?.pause();sessionVersion++;viewVersion++;Auth.token='';Auth.user=null;
  localStorage.removeItem('fleet_token');localStorage.removeItem('fleet_company_context');
  login('Tu sesión venció. Inicia sesión nuevamente.');
 }
 async function api(path,options){
  if(signingOut)throw new Error('La sesión se está cerrando.');
  const version=sessionVersion;
  const r=await fetch(path,options),data=await r.json().catch(()=>({}));
  if(version!==sessionVersion)throw new Error('La sesión cambió.');
  if(r.status===401)expireSession();
  if(data.code==='PERSONNEL_ACCESS_BLOCKED'){
   stopGps('Acceso suspendido. Solicita a administración revisar tu habilitación.');
   gpsNeedsReview=true;viewVersion++;
   authenticatedScreen('<div class="driver-card driver-error" role="alert"><h1>Acceso temporalmente restringido</h1><p>Administración debe revisar tu habilitación. El GPS se ha detenido. Puedes cerrar sesión desde Mi cuenta.</p></div>');
  }
  if(!r.ok)throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{status:r.status,code:data.code});
  return data;
 }
 function accountHeader(){
  const user=Auth.user||{},canTravel=user.role_code==='driver'&&user.driver_id&&!user.must_change_password;
  return `<header class="driver-header"><div class="driver-brand">FleetChile · Conductor</div><details class="driver-account"><summary>Mi cuenta</summary><div class="driver-account-panel"><strong>${esc(user.name||'Usuario')}</strong><span>${esc(user.company_name||'Empresa no identificada')}</span><span>${esc(user.email||'')}</span>${canTravel?'<button type="button" class="driver-link" data-driver-home>Mis viajes</button><button type="button" class="driver-link" data-driver-refresh>Actualizar viajes</button>':''}<button type="button" class="driver-link" data-driver-password>Cambiar contraseña</button><button type="button" class="driver-button driver-logout" data-driver-logout>Cerrar sesión</button><p class="driver-account-error" role="alert" hidden></p></div></details></header>`;
 }
 function leaveForm(){return !root.querySelector('.driver-delivery-form')||confirm('Hay una entrega abierta. Los datos sin guardar se perderán. ¿Continuar?')}
 function authenticatedScreen(content){
  root.innerHTML=`<section class="driver-shell">${accountHeader()}${Auth.user?.role_code==='driver'&&Auth.user.driver_id&&!Auth.user.must_change_password?gpsPanel():''}${content}</section>`;
  renderGps();
  window.CompanyBranding?.load();
  window.DriverMobile?.mountOutbox();
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
  try{if(window.DriverMobile&&!await window.DriverMobile.logout())return;}catch(e){alert('No se pudo revisar el almacenamiento local: '+e.message);return;}
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
 function gpsEligible(trip){return Boolean(trip?.truck_id)&&['En tránsito','Detenido'].includes(trip.status)}
 function gpsPanel(){
  return '<section class="driver-card driver-location-panel" aria-label="Ubicación del viaje"><h2>Ubicación del viaje</h2><p data-gps-summary role="status" aria-live="polite" tabindex="-1"></p><p data-gps-identity></p><p data-gps-last></p><p class="driver-gps-help">La ubicación de este teléfono se enviará para el viaje indicado mientras uses FleetChile. Se pausa al cambiar de app o bloquear la pantalla. Al volver se comprueban sesión y viaje antes de reanudar. Si está bloqueada, revisa Ubicación en los permisos de FleetChile o del sitio en el navegador y activa la ubicación de Android.</p><div class="driver-gps-controls"><button type="button" class="driver-button" data-gps-start>Activar ubicación</button><button type="button" class="driver-link" data-gps-stop>Detener ubicación</button></div></section>';
 }
 function renderGps(){
  const panel=root.querySelector('.driver-location-panel');if(!panel)return;
  panel.className='driver-card driver-location-panel is-'+gpsMode;
  panel.querySelector('[data-gps-summary]').textContent=gpsMessage;
  panel.querySelector('[data-gps-identity]').textContent=gpsTrip?[(Auth.user?.name||'Conductor'),gpsTrip.trip_number||'Viaje #'+gpsTrip.id,gpsTrip.patente||'Camión asignado'].join(' · '):'Sin viaje seleccionado para compartir ubicación.';
  panel.querySelector('[data-gps-last]').textContent=gpsConfirmed?'Última posición confirmada para este viaje: '+date(gpsConfirmed):'Todavía no hay una posición confirmada para este viaje.';
  const start=panel.querySelector('[data-gps-start]'),stop=panel.querySelector('[data-gps-stop]');
  start.hidden=gpsConsent;start.disabled=!gpsEligible(gpsTrip)||signingOut||gpsNeedsReview;
  start.textContent=gpsMode==='error'?'Reintentar ubicación':'Activar ubicación';
  start.onclick=()=>{const pending=startGps(gpsTrip);panel.querySelector('[data-gps-summary]').focus();return pending};
  stop.hidden=!gpsConsent;stop.onclick=()=>{stopGps('Ubicación detenida por el conductor.');start.focus()};
 }
 function stopGps(message='Ubicación detenida.',preserveConsent=false){
  gpsGeneration++;
  if(gpsWatch!==null&&navigator.geolocation)navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch=null;gpsTripId=null;gpsLastSent=0;
  if(gpsTimer!==null)clearTimeout(gpsTimer);gpsTimer=null;
  for(const controller of gpsRequests)controller.abort();gpsRequests.clear();
  if(gpsPermission)gpsPermission.onchange=null;gpsPermission=null;
  if(!preserveConsent)gpsConsent=false;
  gpsMessage=message;gpsMode='paused';renderGps();
 }
 function prepareGps(trip){
  if(gpsConsent&&String(gpsTrip?.id)!==String(trip.id))return renderGps();
  const changed=String(gpsTrip?.id)!==String(trip.id)||String(gpsTrip?.truck_id)!==String(trip.truck_id)||gpsTrip?.status!==trip.status;
  if(gpsConsent&&(!gpsEligible(trip)||String(gpsTrip.truck_id)!==String(trip.truck_id)))stopGps('El estado o camión del viaje cambió. Revisa la asignación antes de activar ubicación.');
  gpsTrip=trip;gpsNeedsReview=false;
  if(changed)gpsConfirmed=null;
  if(!gpsConsent&&(changed||gpsMode!=='error')){gpsMessage=gpsEligible(trip)?'Ubicación desactivada. Pulsa Activar ubicación para este viaje.':'La ubicación solo se activa con camión asignado y viaje En tránsito o Detenido.';gpsMode='paused'}
  renderGps();
 }
 function gpsFailure(error,generation){
  if(generation!==gpsGeneration)return;
  const message=error.status===403?'No tienes autorización para registrar ubicación. Solicita revisión a administración.':
   error.status===404?'El viaje ya no está disponible o fue reasignado. Selecciona tu viaje vigente.':
   error.status===409?'El viaje cambió de estado o ya no tiene camión. Revisa su asignación.':
   error.status?'El servidor rechazó la posición (HTTP '+error.status+'). Reintenta o solicita revisión.':
   error.name==='AbortError'?'El servidor no respondió a tiempo. Reintenta cuando tengas conexión.':
   'No se pudo comunicar con el servidor. Comprueba tu conexión y reintenta.';
  stopGps(message);gpsNeedsReview=[403,404,409].includes(error.status);gpsMode='error';
  if(gpsNeedsReview)gpsMessage+=' Actualiza y abre el viaje vigente antes de activar ubicación.';
  renderGps();
 }
 async function gpsRead(path){
  const controller=new AbortController();gpsRequests.add(controller);
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{return await api(path,{signal:controller.signal})}
  finally{clearTimeout(timeout);gpsRequests.delete(controller)}
 }
 async function gpsValidate(trip,generation,checkIdentity=false){
  if(checkIdentity){
   const identity=await gpsRead('/api/auth/me');
   if(generation!==gpsGeneration)return null;
   const user=identity.user;
   if(user?.role_code!=='driver'||!user.driver_id||user.must_change_password||
      String(user.id)!==String(Auth.user?.id)||String(user.company_id)!==String(Auth.user?.company_id)||String(user.driver_id)!==String(Auth.user?.driver_id)){
    stopGps('La identidad o asociación de conductor cambió. Cierra sesión e ingresa nuevamente.');gpsNeedsReview=true;renderGps();return null;
   }
  }
  const current=await gpsRead('/api/driver/trips/'+encodeURIComponent(trip.id));
  if(generation!==gpsGeneration)return null;
  if(String(current.id)!==String(trip.id)||!gpsEligible(current)||String(current.truck_id)!==String(trip.truck_id)){
   stopGps('El viaje terminó, cambió de estado o de camión. Actualiza y abre el viaje vigente antes de activar ubicación.');gpsNeedsReview=true;renderGps();return null;
  }
  gpsTrip=current;return current;
 }
 function scheduleGpsValidation(trip,generation){
  gpsTimer=setTimeout(async()=>{
   gpsTimer=null;if(generation!==gpsGeneration||!gpsConsent)return;
   try{const current=await gpsValidate(trip,generation);if(current&&generation===gpsGeneration)scheduleGpsValidation(current,generation)}
   catch(error){gpsFailure(error,generation)}
  },30000);
 }
 async function startGps(trip,resume=false){
  if(!trip||signingOut||gpsNeedsReview)return;
  if(gpsConsent&&!resume)return;
  stopGps('Comprobando ubicación y asignación…');gpsTrip=trip;
  if(!gpsEligible(trip)){gpsMessage='El viaje debe estar En tránsito o Detenido y tener camión asignado.';return renderGps()}
  if(window.isSecureContext===false){gpsMode='error';gpsMessage='Abre FleetChile desde su dirección HTTPS para usar ubicación.';return renderGps()}
  if(!navigator.geolocation){gpsMode='error';gpsMessage='Este navegador no ofrece ubicación. Revisa que uses un navegador compatible en Android.';return renderGps()}
  gpsConsent=true;gpsMode='sending';renderGps();
  const generation=gpsGeneration;
  try{
   if(navigator.permissions?.query){
    let permission=null;try{permission=await navigator.permissions.query({name:'geolocation'})}catch{}
    if(generation!==gpsGeneration)return;
    gpsPermission=permission;
    if(gpsPermission?.state==='denied'){stopGps('Ubicación bloqueada. Habilítala en los permisos de FleetChile o del sitio en tu navegador y pulsa Reintentar.');gpsMode='error';return renderGps()}
   }
   const current=await gpsValidate(trip,generation,resume);
   if(!current||generation!==gpsGeneration)return;
   if(document.hidden){stopGps('Ubicación pausada: vuelve a FleetChile para revalidar y reanudar.',true);return}
   gpsTripId=trip.id;gpsMessage='Solicitando permiso o primera posición…';renderGps();
   if(gpsPermission)gpsPermission.onchange=()=>{if(generation===gpsGeneration&&gpsPermission?.state==='denied'){stopGps('El permiso de ubicación fue retirado. Habilítalo y reintenta.');gpsMode='error';renderGps()}};
   let sending=false;
   gpsWatch=navigator.geolocation.watchPosition(async position=>{
    if(generation!==gpsGeneration||gpsTripId!==trip.id||!gpsConsent||document.hidden||sending)return;
    const now=Date.now();if(gpsLastSent&&now-gpsLastSent<10000)return;
    if(!Number.isFinite(position.coords.latitude)||!Number.isFinite(position.coords.longitude)||!Number.isFinite(position.timestamp))return;
    gpsLastSent=now;sending=true;gpsMode='sending';gpsMessage='Enviando posición…';renderGps();
    const controller=new AbortController();gpsRequests.add(controller);
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
     const sent=await api('/api/driver/trips/'+encodeURIComponent(trip.id)+'/positions',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:position.coords.latitude,lng:position.coords.longitude,speed_kmh:position.coords.speed==null?0:Math.max(0,position.coords.speed*3.6),recorded_at:new Date(position.timestamp).toISOString()})});
     if(generation!==gpsGeneration||gpsTripId!==trip.id)return;
     gpsConfirmed=sent.recorded_at;gpsMode='active';gpsMessage='Ubicación activa · posición recibida por FleetChile.';renderGps();
    }catch(error){gpsFailure(error,generation)}
    finally{clearTimeout(timeout);gpsRequests.delete(controller);sending=false}
   },error=>{
    if(generation!==gpsGeneration)return;
    const message=error.code===1?'Permiso de ubicación denegado. Habilítalo en Android y en los permisos del sitio; luego reintenta.':
     error.code===2?'No se pudo obtener la posición. Comprueba ubicación de Android y señal; luego reintenta.':
     'Se agotó el tiempo para obtener ubicación. Comprueba la señal y reintenta.';
    stopGps(message);gpsMode='error';renderGps();
   },{enableHighAccuracy:true,maximumAge:10000,timeout:15000});
   // Some providers may invoke an error synchronously before returning the watch id.
   if(generation!==gpsGeneration){navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;return}
   scheduleGpsValidation(current,generation);
  }catch(error){gpsFailure(error,generation)}
 }
 function pauseGps(){
  if(gpsConsent)stopGps('Ubicación pausada al salir de la app. Se revalidará al volver a FleetChile.',true);
 }
 function resumeGps(){if(gpsConsent&&gpsTrip&&gpsWatch===null&&!document.hidden&&!signingOut)return startGps(gpsTrip,true)}
 document.addEventListener?.('visibilitychange',()=>{if(document.hidden)pauseGps();else resumeGps()});
 window.addEventListener?.('pagehide',pauseGps);
 window.addEventListener?.('pageshow',resumeGps);
 window.addEventListener?.('online',resumeGps);
 window.addEventListener?.('storage',event=>{
  if(event.key==='fleet_token'&&event.newValue!==Auth.token){
   stopGps('La sesión cambió en otra ventana.');sessionVersion++;viewVersion++;Auth.token='';Auth.user=null;
   login('La sesión cambió en otra ventana. Inicia sesión para continuar.');
  }
 });
 async function loadChecklist(id){const box=root.querySelector('.driver-checklist');if(window.DriverMobile)return window.DriverMobile.checklist(id,box);box.innerHTML='<h3>Checklist preoperacional</h3><p>Actualiza la app para completar los seis controles. No se registrará una aprobación sin respuestas.</p>'; }
 function signatureCanvas(){const canvas=document.createElement('canvas');canvas.width=900;canvas.height=360;canvas.className='driver-signature-canvas';const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#173b5d';ctx.lineWidth=4;ctx.lineCap='round';let drawing=false,empty=true;const point=e=>{const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}};canvas.addEventListener('pointerdown',e=>{drawing=true;empty=false;canvas.setPointerCapture(e.pointerId);const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y)});canvas.addEventListener('pointermove',e=>{if(!drawing)return;const p=point(e);ctx.lineTo(p.x,p.y);ctx.stroke()});canvas.addEventListener('pointerup',()=>{drawing=false;canvas.onSignatureChange?.();});canvas.addEventListener('pointercancel',()=>{drawing=false});canvas.clear=()=>{ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#173b5d';empty=true;canvas.onSignatureChange?.();};canvas.restore=data=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{ctx.drawImage(image,0,0,canvas.width,canvas.height);empty=false;resolve();};image.onerror=()=>reject(Error('No se pudo recuperar la firma guardada'));image.src=data;});canvas.value=()=>empty?'':canvas.toDataURL('image/png');return canvas}
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
  let submission=draft?draftSubmission:readDeliverySubmission(key)||crypto.randomUUID();
  let sending=false,completed=false;
  const card=document.createElement('div');
  card.className='driver-card driver-delivery-form';
  card.innerHTML=`<h3>Registrar entrega</h3><p><b>${esc(load.cargo)}</b></p><label>Receptor<input class="delivery-recipient" required maxlength="160"></label><label>RUT (opcional)<input class="delivery-rut" maxlength="30"></label><label>Observaciones<textarea class="delivery-notes" maxlength="2000"></textarea></label><label>Firma manuscrita del receptor <span class="driver-hint">obligatoria</span></label><div class="signature-host"></div><button type="button" class="driver-link clear-signature">Limpiar firma</button><label>Fotografía opcional<input class="delivery-photo" type="file" accept="image/*" capture="environment"></label><img class="delivery-preview" alt="Vista previa de evidencia" hidden><p class="delivery-error driver-error" hidden></p><button type="button" class="driver-button submit-delivery">Confirmar entrega</button>`;
  const canvas=signatureCanvas();
  card.querySelector('.signature-host').append(canvas);
  const photo=card.querySelector('.delivery-photo'),preview=card.querySelector('.delivery-preview');
  const button=card.querySelector('.submit-delivery'),error=card.querySelector('.delivery-error');
  const draftKey='draft-delivery-'+tripId+'-'+load.id;
  const localSession=sessionVersion,localView=viewVersion;
  let savedPhoto='',restoring=true,draftContext=window.DriverMobile?.context(tripId),localRevision=0,photoBusy=false;
  let localNotice=null;
  if(window.DriverMobile){localNotice=document.createElement('p');localNotice.setAttribute('role','status');card.append(localNotice);}
  function fields(){return {recipient_name:card.querySelector('.delivery-recipient').value,recipient_rut:card.querySelector('.delivery-rut').value,notes:card.querySelector('.delivery-notes').value,signature:canvas.value(),photo:savedPhoto};}
  async function saveLocal(){
   if(!window.DriverMobile||restoring||completed||sending||localSession!==sessionVersion||localView!==viewVersion)return;
   const revision=++localRevision;
   try{await window.DriverMobile.draft(draftKey,{id:draftKey,tripId,kind:'delivery',state:'draft',submission,payload:fields(),context:draftContext});if(revision===localRevision)localNotice.textContent='Borrador guardado en este teléfono; todavía no es una entrega confirmada.';}
   catch(e){localNotice.textContent='No guardado: '+e.message;}
  }
  if(window.DriverMobile){
   canvas.onSignatureChange=saveLocal;
   for(const selector of ['.delivery-recipient','.delivery-rut','.delivery-notes'])card.querySelector(selector).addEventListener('input',saveLocal);
   window.DriverMobile.draft(draftKey).then(async saved=>{
    if(localSession!==sessionVersion||localView!==viewVersion)return;
    if(saved?.payload){
     for(const [selector,field] of [['.delivery-recipient','recipient_name'],['.delivery-rut','recipient_rut'],['.delivery-notes','notes']])card.querySelector(selector).value=saved.payload[field]||'';
     if(saved.payload.signature)await canvas.restore(saved.payload.signature);
     savedPhoto=saved.payload.photo||'';if(savedPhoto){preview.src=savedPhoto;preview.hidden=false;}
     draftContext=saved.context;submission=saved.submission;rememberDeliverySubmission(key,submission);
     localNotice.textContent='Borrador recuperado del teléfono. Revisa los datos antes de enviarlo.';
    }
   }).catch(e=>{localNotice.textContent=e.message;}).finally(()=>{restoring=false;});
  }else restoring=false;
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
  photo.onchange=async()=>{
   const file=photo.files?.[0];
   if(!file){savedPhoto='';preview.hidden=true;await saveLocal();return}
   photoBusy=true;
   try{if(window.DriverMobile){savedPhoto=await window.DriverMobile.photoData(file);preview.src=savedPhoto;await saveLocal();}else preview.src=URL.createObjectURL(file);preview.hidden=false;}
   catch(e){photo.value='';error.textContent=e.message;error.hidden=false;}
   finally{photoBusy=false;}
  };
  card.querySelector('.clear-signature').onclick=()=>canvas.clear();
  button.onclick=async()=>{
   if(sending||completed||!submission)return;
   if(restoring||photoBusy){error.textContent='Espera mientras se recupera el borrador o se prepara la foto.';error.hidden=false;return;}
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
    if(window.DriverMobile&&savedPhoto)payload.photo=savedPhoto;
    else if(file)payload.photo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});
    if(version!==sessionVersion||view!==viewVersion)return;
    if(position){payload.latitude=position.coords.latitude;payload.longitude=position.coords.longitude}
    let pending=false;
    if(window.DriverMobile){
     if(!draftContext)throw Error('Actualiza el viaje con conexión antes de preparar esta entrega.');
     payload.resource_version=draftContext.resource_version;payload.version=draftContext.version;
     const result=await window.DriverMobile.delivery(tripId,payload);pending=result.pending;
    }else await api('/api/driver/trips/'+encodeURIComponent(tripId)+'/deliveries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    completed=true;
    clearDeliverySubmission(key);
    card.innerHTML=pending?'<p role="status">Entrega guardada en este teléfono. Falta confirmación del servidor: revisa Pendientes del teléfono.</p>':'<p class="driver-success">Entrega registrada correctamente.</p>';
    if(!pending&&view===viewVersion)await loadDeliveries(tripId);
   }catch(e){
    error.textContent=e.message||'No se pudo registrar la entrega.';
    error.hidden=false;button.disabled=false;button.textContent='Reintentar entrega';
   }finally{sending=false}
  };
  return card;
 }
 async function loadDeliveries(tripId){const detail=root.querySelector('.driver-detail');if(!detail)return;let box=detail.querySelector('.driver-deliveries');if(!box){box=document.createElement('div');box.className='driver-card driver-deliveries';detail.append(box)}box.innerHTML='<h3>Entregas</h3><p>Cargando cargas…</p>';const version=sessionVersion,view=viewVersion;try{const context=window.DriverMobile?await window.DriverMobile.ensureContext(tripId):null;const data=await api(`/api/driver/trips/${encodeURIComponent(tripId)}/deliveries`);if(version!==sessionVersion||view!==viewVersion)return;box.innerHTML=`<h3>Entregas</h3>${context?.version?'<p>Solo puedes entregar las cargas de la parada actual después de registrar tu llegada.</p>':''}${data.deliveries?.length?data.deliveries.map(load=>`<div class="driver-delivery-row"><div><b>${esc(load.cargo)}</b><span>${esc(load.status)}</span></div>${load.status==='Entregada'?'<span class="driver-success">Completada</span>':`<button class="driver-button delivery-start" ${context?.version&&(!context.next_stop?.actual_arrival||!context.loads.some(l=>String(l.id)===String(load.id)&&l.delivery===context.next_stop.key))?'disabled':''}>Entregar</button>`}</div>`).join(''):'<p>No hay cargas registradas.</p>'}`;if(['Completado','Cancelado'].includes(context?.status)){box.insertAdjacentHTML('afterbegin','<p>El viaje está cerrado. Los pendientes del teléfono se conservan para comprobar su recepción con operaciones.</p>');box.querySelectorAll('.delivery-start').forEach(b=>b.disabled=true);return;}const rows=[...box.querySelectorAll('.driver-delivery-row')];data.deliveries?.forEach((load,index)=>rows[index]?.querySelector('.delivery-start')?.addEventListener('click',()=>{const old=box.querySelector('.driver-delivery-form');old?.remove();box.append(deliveryForm(tripId,load))}))}catch(e){if(version!==sessionVersion||view!==viewVersion)return;box.innerHTML=`<h3>Entregas</h3><p class="driver-error">${esc(e.message)}</p>`}}
 const _driverLoadChecklist=loadChecklist;loadChecklist=async id=>{const version=sessionVersion,view=viewVersion;if(window.DriverMobile)await window.DriverMobile.checklist(id,root.querySelector('.driver-checklist'));else await _driverLoadChecklist(id);if(version===sessionVersion&&view===viewVersion)await loadDeliveries(id)};
 function renderActions(allowed=[]){return `<div class="driver-actions">${allowed.map(s=>`<button class="driver-button driver-status-action" data-status="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
 function renderDetail(trip,allowed){root.querySelector('.driver-detail').innerHTML=`<button class="driver-link" id="backTrips">← Volver a viajes</button><div class="driver-card"><h2>${esc(trip.trip_number)}</h2>${status(trip.status)}${renderActions(allowed)}<div class="driver-meta"><div><small>Origen</small><b>${esc(trip.origin)}</b></div><div><small>Destino</small><b>${esc(trip.destination)}</b></div><div><small>Salida</small><b>${date(trip.planned_departure)}</b></div><div><small>Camión</small><b>${esc(trip.patente||'No asignado')}</b></div>${trip.composition_snapshot?.trailer?`<div><small>Remolque / semirremolque</small><b>${esc(trip.composition_snapshot.trailer.patente)}</b></div>`:''}<div><small>Cliente</small><b>${esc(trip.client_name||'No informado')}</b></div><div><small>Ruta</small><b>${esc(trip.origin)} → ${esc(trip.destination)}</b></div></div><h3>Cargas</h3>${trip.loads?.length?`<ul class="driver-list">${trip.loads.map(load=>`<li><b>${esc(load.cargo)}</b><span>${esc(load.status)} · ${esc(load.weight_kg)} kg</span></li>`).join('')}</ul>`:'<p>No hay cargas registradas.</p>'}</div><div class="driver-card driver-checklist"><p>Cargando checklist…</p></div>`;root.querySelector('#backTrips').onclick=()=>{if(leaveForm())loadTrips()};root.querySelectorAll('.driver-status-action').forEach(button=>button.onclick=()=>changeStatus(trip.id,button));prepareGps(trip);window.DriverMobile?.workflow(trip,root.querySelector('.driver-detail'),()=>{if(!root.querySelector('.driver-delivery-form'))return loadDeliveries(trip.id);});loadChecklist(trip.id)}
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
  const view=++viewVersion,version=sessionVersion;
  authenticatedScreen('<div class="driver-card"><small>Conductor</small><h1>'+esc(Auth.user.name)+'</h1><p>'+esc(Auth.user.company_name||'Empresa no identificada')+'</p></div><div class="driver-detail"><div class="driver-card"><h2>Mis viajes</h2><p>Cargando viajes asignados…</p></div></div>');
  const list=root.querySelector('.driver-detail');
  try{
   const trips=await api('/api/driver/trips');
   if(version!==sessionVersion||view!==viewVersion)return;
   if(gpsConsent&&gpsTrip){
    const current=trips.find(trip=>String(trip.id)===String(gpsTrip.id));
    if(!current||!gpsEligible(current)||String(current.truck_id)!==String(gpsTrip.truck_id))stopGps('El viaje ya no está disponible para este seguimiento. Revisa su estado o asignación.');
   }
   list.innerHTML=`<div class="driver-card"><h2>Mis viajes</h2>${trips.length?`<ul class="driver-list">${trips.map(t=>`<li><button class="driver-trip" data-id="${esc(t.id)}"><b>${esc(t.trip_number)}</b>${status(t.status)}<span>${esc(t.origin)} → ${esc(t.destination)}</span><small>${date(t.planned_departure)}</small></button></li>`).join('')}</ul>`:'<p>No tienes viajes asignados.</p>'}</div>`;
   root.querySelectorAll('.driver-trip').forEach(button=>button.onclick=()=>loadDetail(button.dataset.id));
  }catch(e){if(version===sessionVersion&&view===viewVersion)list.innerHTML=`<div class="driver-card"><p class="driver-error" role="alert">${esc(e.message)}</p><button class="driver-button" id="retryDriverTrips">Reintentar</button></div>`;root.querySelector('#retryDriverTrips')?.addEventListener('click',loadTrips)}
 }
 window.driverBoot=({authenticated=false,error=null,setupRequired=false}={})=>{
  window.DriverMobile?.pause();stopGps();gpsTrip=null;gpsConfirmed=null;gpsNeedsReview=false;gpsMessage='Abre un viaje En tránsito o Detenido para activar la ubicación.';sessionVersion++;viewVersion++;
  if(setupRequired)return login('La configuración inicial debe realizarse desde la aplicación administrativa.');
  if(!authenticated||!Auth.user)return login(error?.message||'Inicia sesión para acceder.');
  if(Auth.user.must_change_password)return changePassword();
  if(Auth.user.role_code!=='driver')return authenticatedScreen('<div class="driver-card driver-error"><h1>Acceso no disponible</h1><p>Esta superficie está reservada para usuarios con rol conductor. Puedes cerrar sesión e ingresar con otra cuenta.</p></div>');
  if(!Auth.user.driver_id)return authenticatedScreen('<div class="driver-card driver-error"><h1>Conductor no asociado</h1><p>Tu cuenta todavía no tiene un conductor asociado. Solicita a administración que revise la asociación.</p></div>');
  window.DriverMobile?.bind();
  window.DriverMobile?.sync();
  return loadTrips();
 };
 const loadDetailWithDeliveries=loadDetail;loadDetail=async id=>{const version=sessionVersion,view=viewVersion+1;await loadDetailWithDeliveries(id);if(version===sessionVersion&&view===viewVersion&&root.querySelector('.driver-detail'))await loadDeliveries(id)};
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js',{scope:'/driver'});
})();
