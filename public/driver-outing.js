(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const states={in_service:'Servicio en curso',waiting:'Espera instrucciones de operaciones',returning:'Retorno a base',arrived_base:'Llegada a base confirmada',released:'Equipo liberado fuera de base'};
 let stopTracking=()=>{};
 function pause(){stopTracking();stopTracking=()=>{};}
 async function mount(trip,detail){
  pause();const identity=Auth.user,token=Auth.token,host=document.createElement('section');host.className='driver-card';host.dataset.driverOuting='';detail.append(host);
  const valid=()=>host.isConnected&&Auth.user===identity&&Auth.token===token;
  const base='/api/driver/trips/'+encodeURIComponent(trip.id)+'/outing';
  async function api(suffix='',body){
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
   try{return await Auth.request(base+suffix,{signal:controller.signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});}
   finally{clearTimeout(timeout);}
  }
  async function refresh(){
   pause();try{
    const data=await api();if(!valid())return;const o=data.outing;
    if(!o){host.innerHTML='<h3>Salida del equipo</h3><p>Operaciones aún no ha registrado una salida y su base de retorno para este servicio.</p>';return;}
    host.innerHTML=`<h3>Salida del equipo #${Number(o.id)}</h3><p><strong>${esc(states[o.status]||o.status)}</strong></p><p>Base de retorno: ${esc(o.base_name||data.base?.name||'Ubicación #'+o.base_location_id)}.</p>${trip.status==='Completado'&&!o.closed_at?'<p>Servicio entregado. La salida del equipo continúa abierta; sigue las instrucciones de operaciones.</p>':''}${o.status==='returning'?'<button class="driver-button" data-return-gps>Activar ubicación durante el retorno</button><p>El seguimiento funciona mientras la aplicación está activa. No garantiza posiciones con pantalla apagada.</p><form data-return-arrival><label>Observación de llegada<input name="reason" required maxlength="2000"></label><button class="driver-button" type="submit">Confirmar llegada a base</button></form>':''}<p data-return-message role="status" aria-live="polite"></p><button class="driver-link" data-outing-refresh>Actualizar instrucciones</button>`;
    host.querySelector('[data-outing-refresh]').onclick=refresh;
    host.querySelector('[data-return-arrival]')?.addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button'),message=host.querySelector('[data-return-message]');button.disabled=true;try{await api('/action',{version:o.version,action:'arrive_base',reason:e.target.elements.reason.value});if(valid())await refresh();}catch(err){if(valid())message.textContent=err.message;}finally{if(button.isConnected)button.disabled=false;}});
    host.querySelector('[data-return-gps]')?.addEventListener('click',e=>{
     const button=e.target,message=host.querySelector('[data-return-message]');
     if(!navigator.geolocation){message.textContent='Ubicación no disponible en este dispositivo.';return;}
     pause();button.disabled=true;message.textContent='Solicitando ubicación…';let sending=false,last=0,stopped=false,watch;
     const onVisibility=()=>{if(document.hidden){pause();if(valid()){message.textContent='Ubicación pausada. Regresa a la app y actívala nuevamente.';button.disabled=false;}}};
     const stop=()=>{stopped=true;if(watch!==undefined)navigator.geolocation.clearWatch(watch);document.removeEventListener('visibilitychange',onVisibility);clearInterval(timer);};
     const timer=setInterval(()=>{if(!valid())pause();},2000);stopTracking=stop;document.addEventListener('visibilitychange',onVisibility);
     watch=navigator.geolocation.watchPosition(async position=>{
      if(stopped||!valid()||document.hidden||sending||Date.now()-last<15000)return;sending=true;
      try{await api('/positions',{version:o.version,lat:position.coords.latitude,lng:position.coords.longitude,accuracy_m:position.coords.accuracy,recorded_at:new Date(position.timestamp).toISOString()});last=Date.now();if(valid()&&!stopped)message.textContent='Posición recibida por el sistema · '+new Date(last).toLocaleTimeString('es-CL');}
      catch(err){pause();if(valid()){message.textContent=err.message;button.disabled=false;}}
      finally{sending=false;}
     },err=>{pause();if(valid()){message.textContent=err.code===1?'Permiso de ubicación denegado. Revisa los permisos de la aplicación.':'No se pudo obtener ubicación. Reintenta.';button.disabled=false;}},{enableHighAccuracy:true,maximumAge:15000,timeout:20000});
     if(stopped)navigator.geolocation.clearWatch(watch);
    });
   }catch(e){if(valid())host.innerHTML='<h3>Salida del equipo</h3><p role="alert">'+esc(e.message)+'</p>';}
  }
  await refresh();
 }
 window.DriverOuting={mount,pause};
})();
