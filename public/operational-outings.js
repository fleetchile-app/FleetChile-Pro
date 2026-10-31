(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={in_service:'Servicio en curso',waiting:'Disponible para continuidad',returning:'En retorno a base',arrived_base:'Llegada a base confirmada',released:'Liberado fuera de base'};
 const when=v=>v?new Date(v).toLocaleString('es-CL'):'Sin registro';
 async function mount(trip,host){
  const user=Auth.user,context=localStorage.getItem('fleet_company_context')||'',id=trip.id;
  const panel=document.createElement('section');panel.className='section-card outing-panel';host.append(panel);
  const current=()=>panel.isConnected&&Auth.user===user&&(localStorage.getItem('fleet_company_context')||'')===context&&String(window.currentTripId)===String(id);
  const base='/api/operations/trips/'+encodeURIComponent(id)+'/outing';
  async function request(suffix='',body){
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
   try{return await Auth.request(base+suffix,{signal:controller.signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});}
   finally{clearTimeout(timeout);}
  }
  async function refresh(){
   panel.innerHTML='<h3>Salida del equipo y retorno</h3><p>Cargando salida operacional…</p>';
   try{
    const data=await request();if(!current())return;const o=data.outing,open=o&&!o.closed_at,manage=data.can_manage===true;
    panel.innerHTML=`<h3>Salida del equipo y retorno</h3><p>La entrega cierra el servicio del cliente. La salida conserva la ocupación del equipo hasta su llegada a base o liberación autorizada.</p>${!o?`<p>Este servicio aún no pertenece a una salida operacional. Los registros históricos no se modifican automáticamente.</p>${manage?`<form data-create><label>Base de retorno<select name="base_location_id" required><option value="">Seleccionar una ubicación guardada</option>${(data.locations||[]).map(l=>`<option value="${Number(l.id)}">${esc(l.name)} · ${esc(l.address||'')}</option>`).join('')}</select></label><p>La base puede ser diferente del lugar de recogida. Si falta, registra su acceso en el selector de ubicaciones del sistema.</p><label>Motivo<input name="reason" required maxlength="2000"></label><button class="primary" type="submit">Abrir salida con este servicio</button></form>`:''}`:`<div class="detail-grid"><p><small>Salida operacional</small><b>#${Number(o.id)} · ${esc(labels[o.status]||o.status)}</b></p><p><small>Base de retorno</small><b>${esc(o.base_name||data.base?.name||'Ubicación #'+o.base_location_id)}</b></p><p><small>Última posición de retorno</small><b>${data.last_position?when(data.last_position.recorded_at||data.last_position.captured_at):'Sin posición recibida'}</b></p></div><h4>Servicios encadenados</h4>${(data.services||[]).map(t=>`<p>${esc(t.trip_number||'#'+t.trip_id)} · ${esc(t.origin)} → ${esc(t.destination)} · ${esc(t.status)}</p>`).join('')||'<p>Sin servicios registrados.</p>'}${open&&manage?`<form data-action><label>Siguiente decisión<select name="action"><option value="wait">Esperar carga / instrucciones en destino</option><option value="return">Programar / iniciar retorno a base</option><option value="link">Encadenar otro servicio existente</option><option value="arrive_base">Confirmar llegada a base</option><option value="release">Liberar fuera de base</option></select></label><div data-next-service hidden><label>Siguiente servicio<select name="next_trip_id"><option value="">Seleccionar servicio compatible</option>${(data.candidates||[]).map(t=>`<option value="${Number(t.id)}">${esc(t.trip_number||'#'+t.id)} · ${esc(t.origin)} → ${esc(t.destination)}</option>`).join('')}</select></label><p>Se conservan el cliente, las cargas, el POD y la economía propios de cada servicio. El servidor verifica la continuidad de ubicación y recursos.</p><label><span><input name="itinerary_ack" type="checkbox"> Revisé las restricciones de la ruta para el equipo de esta salida</span></label><label>Detalle de revisión (si el siguiente servicio ya tiene itinerario)<input name="itinerary_notes" maxlength="2000"></label></div><label>Motivo<input name="reason" required maxlength="2000"></label><button class="primary" type="submit">Registrar decisión</button></form>`:''}<details><summary>Historial de la salida</summary>${(data.events||[]).map(e=>`<p>${when(e.created_at)} · ${esc(e.kind||e.action)} · ${esc(e.reason)}</p>`).join('')||'<p>Sin eventos.</p>'}</details>`}<p data-outing-message role="status" aria-live="polite"></p><button type="button" class="secondary" data-refresh-outing>Actualizar salida</button>`;
    panel.querySelector('[data-refresh-outing]').onclick=refresh;
    const latest=data.services?.at(-1);
    if(latest&&String(latest.trip_id)!==String(id)&&window.tripWorkspaceLink){
     const next=document.createElement('p');next.innerHTML=window.tripWorkspaceLink(latest.trip_id,trip.company_id,'Abrir el servicio actual de esta salida ↗');panel.querySelector('[data-outing-message]').before(next);
    }
    if(open&&manage&&o.suggested_origin_location_id&&window.prepareContinuationTrip){
     const prepare=document.createElement('button');prepare.type='button';prepare.className='secondary';prepare.textContent='Preparar siguiente servicio desde el destino actual';
     prepare.onclick=async()=>{const message=panel.querySelector('[data-outing-message]');prepare.disabled=true;try{await window.prepareContinuationTrip({company_id:trip.company_id,origin_location_id:o.suggested_origin_location_id,origin:data.services?.at(-1)?.destination});}catch(e){if(current())message.textContent=e.message;}finally{if(prepare.isConnected)prepare.disabled=false;}};
     panel.querySelector('[data-outing-message]').before(prepare);
    }
    if(data.last_position){
     const p=data.last_position,lat=Number(p.lat),lng=Number(p.lng);
     if(Number.isFinite(lat)&&Number.isFinite(lng)){
      const link=document.createElement('a');link.className='secondary';link.textContent='Ver última posición de retorno en mapa';link.target='_blank';link.rel='noopener noreferrer';link.href='https://www.openstreetmap.org/?mlat='+lat+'&mlon='+lng+'#map=15/'+lat+'/'+lng;
      panel.querySelector('[data-outing-message]').before(link);
      const age=Date.now()-Date.parse(p.recorded_at);if(age>120000){const note=document.createElement('p');note.textContent='Posición desactualizada. La última señal no confirma dónde se encuentra el equipo ahora.';panel.querySelector('[data-outing-message]').before(note);}
     }
    }
    const form=panel.querySelector('form');if(!form)return;
    if(!o&&(['Completado','Cancelado'].includes(trip.status)||!trip.truck_id||!trip.driver_id)){
     form.hidden=true;panel.querySelector('[data-outing-message]').textContent='Abre la salida con camión y conductor asignados antes de completar el servicio. Los servicios históricos cerrados se conservan sin crear retornos supuestos.';return;
    }
    const action=form.elements.action;
    if(action){const update=()=>{const linking=action.value==='link';form.querySelector('[data-next-service]').hidden=!linking;form.elements.next_trip_id.required=linking;form.elements.itinerary_notes.required=linking&&form.elements.itinerary_ack.checked;};action.onchange=update;form.elements.itinerary_ack.onchange=update;update();}
    form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('[type=submit]'),message=panel.querySelector('[data-outing-message]');button.disabled=true;message.textContent='Registrando…';
     try{const payload={reason:form.elements.reason.value};if(o){Object.assign(payload,{version:o.version,action:action.value});if(action.value==='link')payload.next_trip_id=Number(form.elements.next_trip_id.value);}else payload.base_location_id=Number(form.elements.base_location_id.value);
      if(o&&action.value==='link'&&form.elements.itinerary_ack.checked)payload.itinerary_review={acknowledged:true,notes:form.elements.itinerary_notes.value};
      await request(o?'/action':'',payload);if(current())await refresh();
     }catch(e){if(current()){message.textContent=e.message;message.setAttribute('role','alert');}}finally{if(button.isConnected)button.disabled=false;}
    };
   }catch(e){if(current())panel.innerHTML='<h3>Salida del equipo y retorno</h3><p role="alert">'+esc(e.message)+'</p>';}
  }
  await refresh();
 }
 window.OperationalOutingsUI={mount};
})();
