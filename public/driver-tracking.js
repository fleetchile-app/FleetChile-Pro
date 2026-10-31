(function(){
 'use strict';
 const active=['En carga','En tránsito','Detenido','Llegó a destino','Descargando'];
 // Consent lives only in memory. No additional token or browser persistence.
 let consent=null,current=null,inflight=null,generation=0,poll=null;
 const native=()=>Boolean(window.FleetNative?.backgroundGps&&window.FleetTracking?.start);
 const scope=(trip,ctx)=>[window.Auth?.user?.id,window.Auth?.user?.company_id,window.Auth?.user?.driver_id,trip.id,trip.truck_id,ctx?.resource_version??trip.resource_version,ctx?.version??trip.itinerary_version].join(':');
 const path=id=>'/api/driver/trips/'+encodeURIComponent(id)+'/tracking';
 async function request(url,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{return await window.Auth.request(url,{signal:controller.signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});}
  finally{clearTimeout(timer);}
 }
 async function stop(options={}){
  generation++;if(poll)clearTimeout(poll);poll=null;const previous=current;current=null;consent=null;
  // Stop locally even when logout/revocation cannot reach the backend.
  if(window.FleetTracking?.stop)await window.FleetTracking.stop();
  if(previous?.context?.tracking_session_id&&options.revoke!==false){
   try{await request(path(previous.tripId)+'/stop',{tracking_session_id:previous.context.tracking_session_id});}catch{}
  }
 }
 async function mount(trip,detail,ctx){
  let host=detail.querySelector('[data-driver-tracking]');
  if(!host){host=document.createElement('section');host.className='driver-card';host.dataset.driverTracking='';detail.append(host);
   host.innerHTML='<h2>Seguimiento GPS</h2><p data-tracking-description></p><label><input type="checkbox" data-tracking-consent> Autorizo compartir la ubicación del equipo durante el servicio, la espera y el retorno hasta cerrar la salida.</label><p data-tracking-status role="status" aria-live="polite"></p><button class="driver-button" data-tracking-start>Activar GPS</button>';
  }
  if(!ctx&&!window.DriverMobile){try{ctx=await request('/api/driver/trips/'+encodeURIComponent(trip.id)+'/workflow');}catch{}}
  const key=scope(trip,ctx),token=window.Auth?.token,checkbox=host.querySelector('[data-tracking-consent]'),button=host.querySelector('[data-tracking-start]'),message=host.querySelector('[data-tracking-status]');
  const description=host.querySelector('[data-tracking-description]');
  description.textContent=native()?'Android puede seguir enviando ubicación con la pantalla apagada. El servicio completado mantiene GPS mientras la salida siga abierta.':'GPS en segundo plano requiere la aplicación Android. Esta página web no ofrece seguimiento con la pantalla apagada.';
  // Navigation/remount of the same identity never stops the foreground service.
  if(current&&(current.key!==key||current.token!==token))await stop();
  if(native()&&!current&&!inflight&&window.FleetTracking.status){
   try{
    const status=await window.FleetTracking.status(),saved=status.context;
    if(status.running&&saved){
     const expected=[window.Auth?.user?.id,window.Auth?.user?.company_id,window.Auth?.user?.driver_id,trip.id,trip.truck_id,ctx?.resource_version??trip.resource_version,ctx?.version??trip.itinerary_version];
     const actual=[saved.user_id,saved.company_id,saved.driver_id,saved.trip_id,saved.truck_id,saved.resource_version,saved.itinerary_version];
     if(!expected.every((v,i)=>String(v)===String(actual[i])))await stop();
     else{
      // The standard Bearer must own this exact DB session; no token restoration.
      const verified=await request(path(trip.id)+'/context?tracking_session_id='+encodeURIComponent(saved.tracking_session_id));
      if(verified.state==='closed')await stop();
      else{current={key,token,tripId:trip.id,context:verified};consent={key,token};}
     }
    }
   }catch(e){if([401,403,404].includes(e.status))await stop();else{message.textContent='No se pudo verificar el GPS Android; reintenta con conexión.';return;}}
  }
  if(consent&&(consent.key!==key||consent.token!==token))consent=null;
  checkbox.checked=Boolean(consent);checkbox.disabled=!native();
  const ready=Boolean(ctx?.ready&&ctx.accepted_at&&active.includes(ctx.status||trip.status));
  function paint(){button.disabled=!native()||!checkbox.checked||!ready||Boolean(inflight)||Boolean(current);button.textContent=current?(current.running?'GPS activo':'Preparando GPS'):ready?'Activar GPS':'Pendiente de aceptación y checklist';}
  async function refreshStatus(){
   if(!native()||!window.FleetTracking.status||document.hidden||!host.isConnected)return;
   if(current&&(current.key!==scope(trip,ctx)||current.token!==window.Auth?.token)){await stop();message.textContent='El acceso cambió. Autoriza el seguimiento nuevamente.';paint();return;}
   if(current?.context?.expires_at&&Date.now()>=Date.parse(current.context.expires_at)){await stop({revoke:false});message.textContent='La sesión venció. Vuelve a ingresar para activar GPS.';paint();return;}
   const status=await window.FleetTracking.status();
   const running=status.running===true&&status.state!=='starting';
   if(current)current.running=running;
   const expiry=current?.context?.expires_at;
   message.textContent=`${running?'GPS activo':status.state==='starting'?'Preparando GPS':'GPS detenido'} · Señal: ${status.signal??'sin confirmar'} · Pendientes: ${status.pending??0}${status.reviewPending?' · Revisión requerida':''}${expiry?' · Sesión hasta '+new Date(expiry).toLocaleTimeString()+'. Vuelve a ingresar al vencer.':''}`;
   if(current&&['closed','stopped'].includes(status.state)){current=null;consent=null;checkbox.checked=false;}
   paint();
  }
  checkbox.onchange=()=>{consent=checkbox.checked?{key,token}:null;paint();if(!checkbox.checked&&current)stop().then(()=>{message.textContent='Seguimiento detenido';paint();});};
  async function start(){
   if(inflight||current||!consent||consent.key!==key||!native()||!ready||document.hidden)return;
   const epoch=generation;
   inflight=(async()=>{
    try{
     const context=await request(path(trip.id),{});
     if(epoch!==generation||!consent||consent.key!==key||consent.token!==token)return;
     if(context.state==='closed'){message.textContent=context.review_required?'La asignación cambió. Revisión requerida antes de iniciar otro seguimiento.':'Sesión GPS cerrada';return;}
     current={key,token,tripId:trip.id,context};
     await window.FleetTracking.start({tripId:trip.id,token});
     if(epoch!==generation){await window.FleetTracking.stop();return;}
     await refreshStatus();
    }catch(e){current=null;message.textContent=e.message||'No se pudo activar GPS';}
    finally{inflight=null;paint();}
   })();paint();await inflight;
  }
  button.onclick=start;paint();
  if(current&&window.FleetTracking?.status){
   try{await refreshStatus();}catch{message.textContent='No se pudo consultar la señal GPS';}
  }else message.textContent=consent&&!ready?'Consentimiento recibido. Falta aceptación vigente, checklist aprobado y estado habilitado.':'Activa GPS para consultar señal y pendientes.';
  if(consent&&ready&&!current)await start();
  if(poll)clearTimeout(poll);
  async function tick(){if(!host.isConnected)return;try{await refreshStatus();}catch{message.textContent='No se pudo consultar la señal GPS';}poll=setTimeout(tick,5000);}
  if(native())poll=setTimeout(tick,5000);
 }
 window.DriverTracking={mount,stop};
})();
