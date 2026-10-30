(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const identity=()=>String(window.Auth?.token||'')+'|'+String(localStorage.getItem('fleet_company_context')||'')+'|'+String(window.Auth?.user?.company_id||'');
 const api=(id,path='',method='GET',body)=>window.Auth.request('/api/operations/trips/'+id+'/itinerary'+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 const date=v=>v?new Date(v).toLocaleString('es-CL'):'—',hours=s=>(Number(s)/3600).toLocaleString('es-CL',{maximumFractionDigits:2})+' h';
 const local=v=>{const d=v?new Date(v):new Date();return new Date(+d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 const types=[['pickup','Recogida'],['delivery','Entrega'],['mixed','Recogida y entrega'],['rest','Descanso'],['toll','Peaje'],['weigh','Pesaje'],['other','Otra parada']];
 const eventLabels={arrive:'Llegada',depart:'Salida',failed:'Entrega fallida',partial:'Entrega parcial',reschedule:'Reprogramación solicitada',delay:'Demora / incidente',pending:'Pendiente',delivered:'Entregada'};
 const options=(rows,v,empty='Seleccionar')=>`<option value="">${esc(empty)}</option>`+rows.map(r=>`<option value="${esc(r[0])}" ${String(r[0])===String(v)?'selected':''}>${esc(r[1])}</option>`).join('');
 const select=(n,label,rows,v,empty)=>`<label>${esc(label)}<select name="${esc(n)}" required>${options(rows,v,empty)}</select></label>`;
 const input=(n,label,value='',type='text',attrs='')=>`<label>${esc(label)}<input name="${esc(n)}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
 const key=()=>window.crypto?.randomUUID?.()||'s'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
 let timer=null;
 const locationText=l=>l?[l.name,l.commune,l.region,l.address].filter(Boolean).join(' · '):'Ubicación pendiente';
 function mapPreview(node,stops,legs=[]){
  if(!window.L||!node)return null;
  const points=stops.filter(s=>s.location?.lat!=null&&s.location?.lng!=null);
  if(!points.length)return null;
  const map=L.map(node),bounds=[];
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:19}).addTo(map);
  for(const stop of points){const p=[Number(stop.location.lat),Number(stop.location.lng)];bounds.push(p);L.marker(p,{icon:L.divIcon({className:'itinerary-pin',html:String(stops.indexOf(stop)+1),iconSize:[26,26],iconAnchor:[13,13]})}).addTo(map).bindPopup(esc(locationText(stop.location))+'<br>'+esc(p.join(', ')));}
  for(const leg of legs)if(leg.geometry){const line=L.geoJSON(leg.geometry).addTo(map),area=line.getBounds();if(area.isValid())bounds.push(area.getSouthWest(),area.getNorthEast());}
  map.fitBounds(bounds,{padding:[25,25],maxZoom:15});setTimeout(()=>{if(node.isConnected)map.invalidateSize();},0);return map;
 }
 function modal(title,html,save){
  const token=identity(),form=document.getElementById('form');document.getElementById('mt').textContent=title;
  form.innerHTML=`<div class="itinerary"><p role="alert" id="it-error" hidden></p>${html}<div class="it-actions"><button type="submit" class="primary">${save?'Guardar':'Cerrar'}</button></div></div>`;
  document.getElementById('modal').classList.remove('hidden');
  form.onsubmit=async e=>{e.preventDefault();if(identity()!==token)return;const button=form.querySelector('[type=submit]');button.disabled=true;try{if(save)await save(Object.fromEntries(new FormData(form)));else document.getElementById('modal').classList.add('hidden');}catch(e){if(identity()===token){const error=form.querySelector('#it-error');error.hidden=false;error.textContent=e.message;}}finally{if(identity()===token&&button.isConnected)button.disabled=false;}};
  return form;
 }
 async function edit(id,data,opts){
  const token=identity(),old=data.revision?.plan,trip=opts.trip||window.loadedOperationalTrip||{},stops=old?old.stops.map(s=>({...s})):Array.from({length:2},(_,i)=>({key:key(),location_id:trip[(i?'destination':'origin')+'_location_id']||'',purpose:i?'delivery':'pickup',service_minutes:0,wait_minutes:0,rest_minutes:0}));
  if(!old)for(const load of opts.loads)for(const [field,purpose] of [['origin','pickup'],['destination','delivery']]){
   const id=load[field+'_location_id'];if(!id)continue;let stop=stops.find(s=>String(s.location_id)===String(id));
   if(!stop&&stops.length<12){stop={key:key(),location_id:id,purpose,service_minutes:0,wait_minutes:0,rest_minutes:0};stops.splice(stops.length-1,0,stop);}
   if(stop&&stop.purpose!==purpose)stop.purpose='mixed';
  }
  let draft={departure:local(old?.departure||trip.planned_departure),contingency_minutes:old?.contingency_minutes||0,reason:'',review:old?.vehicle_review.notes||'',loads:old?.loads.map(l=>({...l}))||opts.loads.map(l=>({load_id:Number(l.id),pickup:l.origin_location_id?stops.find(s=>String(s.location_id)===String(l.origin_location_id))?.key||'':stops[0].key,delivery:l.destination_location_id?stops.find(s=>String(s.location_id)===String(l.destination_location_id))?.key||'':stops.at(-1).key}))};
  let form;
  const capture=()=>{
   if(!form)return;const b=Object.fromEntries(new FormData(form));draft={...draft,departure:b.departure,contingency_minutes:b.contingency_minutes,reason:b.reason,review:b.review,endpoint_ack:b.endpoint_change_ack==='true',load_ack:b.load_locations_ack==='true'};
   stops.forEach((s,i)=>{for(const f of ['location_id','purpose','service_minutes','wait_minutes','rest_minutes'])s[f]=b['s'+i+'_'+f];});
   draft.loads=opts.loads.map(l=>({load_id:Number(l.id),pickup:b['l'+l.id+'_pickup'],delivery:b['l'+l.id+'_delivery']}));
  };
  let previewMap=null;
  function coherence(){
   const endpointChange=['origin','destination'].some((f,i)=>trip[f+'_location_id']!=null&&String(trip[f+'_location_id'])!==String((i?stops.at(-1):stops[0]).location_id));
   const changes=opts.loads.flatMap(load=>{
    if(load.status==='Entregada'||load.delivered_at)return [];
    const mapping=draft.loads.find(m=>String(m.load_id)===String(load.id));
    return [['origin','pickup'],['destination','delivery']].flatMap(([field,which])=>{
     const stop=stops.find(s=>s.key===mapping?.[which]);
     if(!stop||String(load[field+'_location_id']??'')===String(stop.location_id))return [];
     const next=opts.locations.find(l=>String(l.id)===String(stop.location_id));
     return [`${load.cargo} · ${field==='origin'?'Recogida':'Entrega'}: ${load[field]||'Sin punto confirmado'} → ${locationText(next)}`];
    });
   });
   return `<h4>Revisión de coherencia</h4><p class="it-help">El domicilio comercial del cliente no es automáticamente el lugar de entrega. Revisa los accesos de cada carga.</p>${endpointChange?'<p class="it-warning">Cambiarás los puntos confirmados del viaje.</p><label><span><input type="checkbox" name="endpoint_change_ack" value="true" required> Confirmo el cambio de origen o destino del viaje, con el motivo indicado.</span></label>':''}${changes.length?'<div class="it-warning">'+changes.map(c=>'<p>'+esc(c)+'</p>').join('')+'</div><label><span><input type="checkbox" name="load_locations_ack" value="true" required> Confirmo estas recogidas y entregas; se actualizarán las fichas de las cargas de este viaje y quedará auditoría.</span></label>':'<p>Las cargas con puntos registrados corresponden a sus paradas.</p>'}<p class="it-help">Comuna y región son datos declarados: el marcador debe revisarse en el mapa; no se certifica su pertenencia mediante límites territoriales.</p>`;
  }
  function refreshPreview(){
   if(previewMap){previewMap.remove();previewMap=null;}
   const current=stops.map(s=>({...s,location:opts.locations.find(l=>String(l.id)===String(s.location_id))}));
   const node=form.querySelector('#it-map-preview');node.hidden=!window.L||!current.some(s=>s.location?.lat!=null&&s.location?.lng!=null);previewMap=mapPreview(node,current);
  }
  let savedRows=[],savedPage=1,savedQuery='',savedSequence=0;
  const error=e=>{if(identity()===token&&form?.isConnected){const box=form.querySelector('#it-error');box.hidden=false;box.textContent=e.message;}};
  async function browse(page=1){
   capture();const target=form.querySelector('#it-saved-routes'),sequence=++savedSequence,owner=form;
   target.innerHTML='<p role="status">Consultando recorridos guardados…</p>';
   try{
    const result=await api(id,'/saved-routes?page='+page+'&q='+encodeURIComponent(savedQuery));
    if(identity()!==token||form!==owner||!target.isConnected||sequence!==savedSequence)return;
    savedRows=result.rows;savedPage=result.page;
    target.innerHTML=`<p>${Number(result.total)} recorridos · Página ${Number(result.page)}</p>${result.rows.map(r=>`<div class="it-stop"><strong>${esc(r.origin)} → ${esc(r.destination)}</strong><small>${r.can_use?'Reutiliza sólo origen y destino. Los tramos y tiempos se calculan al guardar el viaje.':'Registro histórico sin accesos confirmados. Selecciona sus ubicaciones manualmente en el planificador.'}</small><button type="button" class="secondary" data-it-use="${Number(r.id)}" ${r.can_use?'':'disabled'}>Usar origen y destino</button></div>`).join('')||'<p>No hay recorridos guardados para esta búsqueda.</p>'}<div class="it-actions">${page>1?'<button type="button" class="secondary" data-it-saved-page="'+(page-1)+'">Anterior</button>':''}${page*result.page_size<result.total?'<button type="button" class="secondary" data-it-saved-page="'+(page+1)+'">Siguientes recorridos</button>':''}</div>`;
   }catch(e){if(identity()===token&&target.isConnected&&form===owner)target.textContent=e.message;}
  }
  async function saveEndpoints(){
   capture();const owner=form,a=stops[0].location_id,b=stops.at(-1).location_id;
   if(!a||!b)throw Error('Selecciona origen y destino antes de guardar el recorrido.');
   const saved=await api(id,'/saved-routes','POST',{origin_location_id:Number(a),destination_location_id:Number(b)});
   if(identity()!==token||form!==owner||!form.isConnected)return;
   form.querySelector('#it-saved-status').textContent=saved.reused?'Este origen y destino ya estaban guardados. No se duplicó el recorrido.':'Origen y destino guardados. No se asignaron recursos ni se activó el viaje.';
  }
  function useEndpoints(routeId){
   capture();const r=savedRows.find(r=>Number(r.id)===Number(routeId));
   if(!r?.can_use)throw Error('Confirma las ubicaciones de este recorrido antes de reutilizarlo.');
   if(data.progress.some(s=>s.actual_arrival||s.actual_departure))throw Error('El itinerario ya comenzó. Modifica sólo las paradas pendientes; no se reemplaza el recorrido completo.');
   const first=opts.locations.find(l=>String(l.id)===String(r.origin_location_id)),last=opts.locations.find(l=>String(l.id)===String(r.destination_location_id));
   if(!first||!last)throw Error('Las ubicaciones ya no están disponibles. Vuelve a abrir el planificador.');
   const changed=String(stops[0].location_id)!==String(first.id)||String(stops.at(-1).location_id)!==String(last.id);
   if(changed&&(stops[0].location_id||stops.at(-1).location_id)&&!window.confirm('¿Reemplazar sólo el origen y destino? Se conservan las paradas intermedias, cargas y horarios. Deberás revisar y recalcular el plan antes de guardarlo.'))return;
   stops[0].location_id=first.id;stops.at(-1).location_id=last.id;draft.review='';savedSequence++;paint();
   form.querySelector('#it-saved-status').textContent='Puntos incorporados al borrador. Revisa las cargas, accesos y restricciones; aún no se modificó el viaje.';
  }
  function paint(){
   const stopOptions=stops.map((s,i)=>[s.key,(i+1)+'. '+(opts.locations.find(l=>String(l.id)===String(s.location_id))?.name||'Parada')]);
   form=modal('Planificar itinerario y tiempos',`<p class="it-help">Ordena las paradas. Al guardar se calculan los tramos por carretera y se conserva una nueva versión. Los tiempos de atención, espera y descanso se suman una sola vez. Máximo 12 paradas.</p><p class="it-current-route"><strong>Puntos registrados en este viaje:</strong> ${esc(trip.origin||'Origen pendiente')} → ${esc(trip.destination||'Destino pendiente')}. ${old?'Se carga el itinerario vigente.':'Se precargan sus puntos confirmados y los de las cargas; revisa el orden antes de guardar.'}</p>
    <details class="it-stop"><summary>Recorridos guardados (opcional)</summary><p class="it-help">Catálogo de la empresa, no recorrido seleccionado de este viaje. Usar una plantilla requiere revisar sus diferencias. No copia camión, conductor, avance ni estado.</p><label>Buscar origen o destino<input id="it-saved-query" type="search" maxlength="120" value="${esc(savedQuery)}"></label><div class="it-actions"><button type="button" class="secondary" id="it-saved-browse">Ver recorridos guardados</button><button type="button" class="secondary" id="it-saved-save">Guardar origen y destino como recorrido</button></div><div class="it-saved-list" id="it-saved-routes"></div></details><p role="status" id="it-saved-status"></p>
    <div class="it-grid">${input('departure','Salida',draft.departure,'datetime-local','required')}${input('contingency_minutes','Margen de contingencia (min)',draft.contingency_minutes,'number','min="0" max="10080" required')}${input('reason','Motivo de este plan o cambio',draft.reason,'text','required maxlength="2000"')}</div>
    ${stops.map((s,i)=>`<div class="it-stop"><h4>Parada ${i+1}</h4><small>${esc(locationText(opts.locations.find(l=>String(l.id)===String(s.location_id))))}</small><div class="it-grid">${select('s'+i+'_location_id','Ubicación',opts.locations.map(l=>[l.id,locationText(l)]),s.location_id)}${select('s'+i+'_purpose','Propósito',types,s.purpose)}${input('s'+i+'_service_minutes','Carga / descarga / atención (min)',s.service_minutes,'number','min="0" max="10080" required')}${input('s'+i+'_wait_minutes','Espera prevista (min)',s.wait_minutes,'number','min="0" max="10080" required')}${input('s'+i+'_rest_minutes','Descanso (min)',s.rest_minutes,'number','min="0" max="10080" required')}</div><div class="it-actions"><button type="button" class="secondary" data-it-move="${i}" data-direction="-1" ${!i?'disabled':''}>Subir</button><button type="button" class="secondary" data-it-move="${i}" data-direction="1" ${i===stops.length-1?'disabled':''}>Bajar</button><button type="button" class="secondary" data-it-remove="${i}" ${stops.length<=2?'disabled':''}>Quitar</button></div></div>`).join('')}
    <div class="it-actions"><button type="button" class="secondary" id="it-add" ${stops.length>=12?'disabled':''}>Agregar parada</button><button type="button" class="secondary" id="it-location">Registrar ubicación en mapa</button></div>
    <h4>Recogida y entrega de cada carga</h4>${opts.loads.map(l=>{const v=draft.loads.find(x=>x.load_id===Number(l.id))||{};return `<div class="it-stop"><strong>${esc(l.cargo)} · ${esc(l.client_name)} · ${esc(l.weight_kg??'Sin peso')} kg</strong><div class="it-grid">${select('l'+l.id+'_pickup','Se recoge en',stopOptions,v.pickup)}${select('l'+l.id+'_delivery','Se entrega en',stopOptions,v.delivery)}</div></div>`;}).join('')||'<p>No hay cargas registradas. Puedes planificar el recorrido; agrega y vincula las cargas antes de operar.</p>'}
    <p class="it-warning">Ruta genérica: no certifica peso máximo de la vía, altura, dimensiones, accesos ni restricciones para camiones. Verifica estos puntos para el equipo asignado.</p>
    <label><span><input name="acknowledged" type="checkbox" value="true" required style="width:auto;min-height:0"> Confirmo la revisión operacional de la ruta.</span></label>${input('review','Detalle de la revisión y restricciones comprobadas',draft.review,'text','required maxlength="2000"')}<p class="it-help">Un pinchazo u otra incidencia se registra cuando ocurre. El margen de contingencia no representa una incidencia real.</p>`,async()=>{
     if(String(window.currentTripId)!==String(id))throw Error('El viaje abierto cambió. Vuelve a abrir su planificador.');capture();const payload={version:data.version,resource_version:data.resource_version,endpoint_change_ack:draft.endpoint_ack,load_locations_ack:draft.load_ack,load_locations_token:opts.load_locations_token,departure:new Date(draft.departure).toISOString(),contingency_minutes:Number(draft.contingency_minutes),reason:draft.reason,vehicle_review:{acknowledged:true,notes:draft.review},stops:stops.map(s=>({key:s.key,purpose:s.purpose,location_id:Number(s.location_id),service_minutes:Number(s.service_minutes),wait_minutes:Number(s.wait_minutes),rest_minutes:Number(s.rest_minutes)})),loads:draft.loads};
     form.querySelector('[type=submit]').textContent='Calculando ruta y guardando…';await api(id,'','PUT',payload);if(identity()!==token)return;document.getElementById('modal').classList.add('hidden');await window.openTrip(id);
    });
   form.querySelector('[type=submit]').textContent='Calcular ruta y guardar versión';
   const review=document.createElement('section');review.id='it-coherence';review.innerHTML=coherence();
   form.querySelector('[type=submit]').parentElement?.before?.(review);
   const map=document.createElement('div');map.id='it-map-preview';map.className='it-map';review.before?.(map);refreshPreview();
   form.onchange=e=>{if(e.target.name==='endpoint_change_ack'||e.target.name==='load_locations_ack')return;if(/^(s\d+_location_id|l\d+_(pickup|delivery))$/.test(e.target.name||'')){capture();draft.review='';form.querySelector('[name=review]').value='';review.innerHTML=coherence();refreshPreview();}};
   form.onclick=async e=>{const b=e.target.closest?.('button');if(!b||b.disabled)return;
    if(b.id==='it-saved-browse'||b.id==='it-saved-save'||b.dataset.itUse!=null||b.dataset.itSavedPage!=null){
     b.disabled=true;try{
      if(b.id==='it-saved-browse'){savedQuery=form.querySelector('#it-saved-query').value.trim();await browse();}
      else if(b.id==='it-saved-save')await saveEndpoints();
      else if(b.dataset.itSavedPage!=null)await browse(Number(b.dataset.itSavedPage));
      else useEndpoints(b.dataset.itUse);
     }catch(e){error(e);}finally{if(identity()===token&&b.isConnected)b.disabled=false;}return;
    }
    if(b.id==='it-add'){capture();stops.push({key:key(),location_id:'',purpose:'delivery',service_minutes:0,wait_minutes:0,rest_minutes:0});paint();}
    else if(b.dataset.itMove!=null){capture();const i=Number(b.dataset.itMove),j=i+Number(b.dataset.direction);[stops[i],stops[j]]=[stops[j],stops[i]];paint();}
    else if(b.dataset.itRemove!=null){capture();stops.splice(Number(b.dataset.itRemove),1);paint();}
    else if(b.id==='it-location'){
     if(window.LocationPicker){capture();await window.LocationPicker.pick({title:'Ubicación de parada',returnFocus:b,onSelect:l=>{if(identity()!==token)return;opts.locations.push(l);paint();}});return;}
     const address=prompt('Dirección completa, comuna y región de la ubicación:');if(!address)return;capture();b.disabled=true;
     try{const l=await window.Auth.request('/api/geography/locations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:address,name:address})});if(identity()!==token)return;opts.locations.push(l);paint();}catch(e){if(identity()===token){form.querySelector('#it-error').hidden=false;form.querySelector('#it-error').textContent=e.message;b.disabled=false;}}
    }
   };
  }paint();
 }
 async function record(id,data,kind,stopKey){
  const token=identity(),eventKey=key(),plan=data.revision.plan,exception=['failed','partial','reschedule'].includes(kind),loads=data.loads.filter(l=>plan.loads.some(m=>String(m.load_id)===String(l.id)&&m.delivery===stopKey));
  modal('Registrar '+({arrive:'llegada',depart:'salida',failed:'entrega fallida',partial:'entrega parcial',reschedule:'solicitud de reprogramación',delay:'demora / incidente'}[kind]),`<p class="it-help">Registro independiente. No completa el viaje ni las demás cargas. Una reprogramación debe concretarse editando y guardando una nueva versión del itinerario.</p><div class="it-grid">${exception?select('load_id','Carga afectada',loads.map(l=>[l.id,l.cargo+' · '+l.status]),''):''}${kind==='partial'?input('delivered_kg','Peso entregado parcialmente (kg)','','number','required min="0.001" step="0.001"'):''}${kind==='delay'?input('minutes','Demora adicional estimada (min)','','number','required min="1" max="10080"'):''}${['failed','partial','reschedule','delay'].includes(kind)?input('reason','Motivo','','text','required maxlength="2000"'):''}</div>`,async b=>{
   await api(id,'/events','POST',{version:data.version,event_key:eventKey,kind,stop_key:stopKey||null,...b});if(identity()!==token)return;document.getElementById('modal').classList.add('hidden');await window.openTrip(id);
  });
 }
 async function history(id,panel,page=1){
  const token=identity(),data=await api(id,'/history?page='+page);if(identity()!==token||!panel.isConnected||String(window.currentTripId)!==String(id))return;
  panel.innerHTML=`<h4>Historial de planes</h4>${data.rows.map(r=>`<div class="it-stop"><strong>Versión ${Number(r.version)} · ${esc(date(r.recorded_at))}</strong><small>${esc(r.actor_name)} · Usuario #${esc(r.actor_user_id)}</small><p>${esc(r.reason)}</p><p>${r.plan.stops.map(s=>esc(s.location.name)).join(' → ')}</p><small>Llegada planificada: ${esc(date(r.plan.arrival))} · ${esc(hours(r.plan.total_seconds))}</small>${r.plan.impact?.remaining_deliveries?.map(d=>`<small>Carga #${esc(d.load_id)} · Nueva llegada: ${esc(date(d.planned_arrival))} · Variación: ${d.delta_seconds==null?'Primera planificación':esc(d.delta_seconds/60)+' min'}</small>`).join('')||''}</div>`).join('')}<div class="it-actions">${page>1?'<button type="button" data-page="'+(page-1)+'" class="secondary">Anterior</button>':''}${page*10<data.total?'<button type="button" data-page="'+(page+1)+'" class="secondary">Más versiones</button>':''}</div>`;
  panel.onclick=e=>{const b=e.target.closest?.('[data-page]');if(b)history(id,panel,Number(b.dataset.page)).catch(e=>{panel.textContent=e.message;});};
 }
 async function attach(id){
  const token=identity(),body=document.getElementById('drawerBody'),summary=body?.querySelector('#tripPanelSummary');if(!summary)return;
  const panel=document.createElement('section');panel.className='itinerary';panel.innerHTML='<p role="status">Consultando itinerario…</p>';summary.prepend(panel);
  try{
   const data=await api(id);if(identity()!==token||!panel.isConnected||String(window.currentTripId)!==String(id))return;
   const p=data.revision?.plan,closed=['Completado','Cancelado'].includes(data.trip_status),next=data.progress.find(s=>!s.actual_departure);
   const etaLabel={gps_estimate:'Estimación con GPS reciente',stale_gps:'GPS ausente o desactualizado: estimación del plan',off_route:'Fuera del trazado: requiere revisión',finished:'Última parada finalizada'};
   panel.innerHTML=`<h3>Itinerario, cargas y tiempos ${p?'· v'+Number(data.version):''}</h3><div class="it-actions">${!closed?'<button type="button" class="primary" data-action="edit">'+(p?'Modificar itinerario':'Planificar paradas y ruta')+'</button>':''}${p?'<button type="button" class="secondary" data-action="history">Historial de planes</button><button type="button" class="secondary" data-action="refresh">Actualizar ETA</button>':''}${p&&!closed?'<button type="button" class="secondary" data-action="delay">Registrar demora / incidente</button>':''}</div>
    ${!p?'<p class="it-help">Vincula las cargas a sus recogidas y entregas. El cálculo vial se realiza al guardar el plan, sin estimar kilómetros por nombres de ciudades.</p>':`
     <div class="it-grid"><p>Distancia vial<strong>${esc((p.distance_meters/1000).toLocaleString('es-CL'))} km</strong></p><p>Conducción<strong>${esc(hours(p.driving_seconds))}</strong></p><p>Atención, espera y descanso<strong>${esc(hours(p.stop_seconds))}</strong></p><p>Contingencia<strong>${esc(p.contingency_minutes)} min</strong></p><p>Total planificado<strong>${esc(hours(p.total_seconds))}</strong></p><p>Llegada estimada<strong id="it-eta-value">${esc(date(data.eta.estimated_arrival))}</strong><small id="it-eta-state">${esc(etaLabel[data.eta.state])}</small></p></div>
     <p class="it-help">Fuente: ${[...new Set(p.legs.map(l=>l.provider))].map(esc).join(', ')} · Cálculo: ${esc(date(p.legs[0]?.calculated_at))}. Ruta genérica, sin certificación de restricciones para camiones. Revisión: ${esc(p.vehicle_review.notes)}</p>${p.legs.some(l=>String(l.provider).startsWith('openrouteservice/'))?'<small>© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors.</small>':''}
     ${data.stale_loads||data.review_required||!data.capacity.verified||data.capacity.overloaded?'<p class="it-warning">'+[data.stale_loads?'Las cargas cambiaron: vuelve a vincularlas.':'',data.review_required?'El equipo cambió: revisa la aptitud de la ruta.':'',!data.capacity.verified?'Faltan capacidad o pesos para verificar los tramos.':'',data.capacity.overloaded?'Hay un tramo sobrecargado.':''].filter(Boolean).join(' ')+'</p>':''}
     ${data.progress.map((s,i)=>`<div class="it-stop"><strong>${i+1}. ${esc(s.location.name)} · ${esc(types.find(t=>t[0]===s.purpose)?.[1])}</strong><small>Previsto: ${esc(date(s.planned_arrival))} → ${esc(date(s.planned_departure))}</small><small>Real: ${esc(date(s.actual_arrival))} → ${esc(date(s.actual_departure))}</small><p>${p.loads.filter(l=>l.pickup===s.key||l.delivery===s.key).map(l=>{const row=data.loads.find(r=>String(r.id)===String(l.load_id));return esc(l.pickup===s.key?'Recoger: ':'Entregar: ')+esc(row?.cargo||'#'+l.load_id)+' · '+esc(eventLabels[row?.itinerary_state]||row?.status||'Pendiente')+(row?.partial_kg?' · Saldo: '+esc(row.remaining_kg)+' kg':'');}).join('<br>')||'Sin movimiento de cargas'}</p><div class="it-actions">${!closed&&next?.key===s.key?'<button type="button" class="secondary" data-action="'+(s.actual_arrival?'depart':'arrive')+'" data-stop="'+esc(s.key)+'">Registrar '+(s.actual_arrival?'salida':'llegada')+'</button>':''}${!closed&&p.loads.some(l=>l.delivery===s.key)?['failed','partial','reschedule'].map(k=>'<button type="button" class="secondary" data-action="'+k+'" data-stop="'+esc(s.key)+'">'+({failed:'Entrega fallida',partial:'Entrega parcial',reschedule:'Reprogramar'})[k]+'</button>').join(''):''}</div></div>`).join('')}
     <div class="it-table"><table><thead><tr><th>Tramo</th><th>A bordo (kg)</th><th>Capacidad (kg)</th><th>Verificación</th></tr></thead><tbody>${data.capacity.segments.map((s,i)=>`<tr><td>${i+1} → ${i+2}</td><td>${esc(s.weight_kg)}${s.unknown_weights?' + pesos pendientes':''}</td><td>${esc(s.capacity_kg??'No informada')}</td><td>${s.overloaded?'Sobrecarga':s.unknown_weights||s.capacity_kg==null?'Pendiente':'Dentro de capacidad'}</td></tr>`).join('')}</tbody></table></div>
     <h4>Incidencias y ejecución</h4>${data.events.slice(-30).reverse().map(e=>`<small>${esc(date(e.occurred_at))} · ${esc(e.actor_name)} · ${esc(eventLabels[e.kind]||e.kind)}${e.load_id?' · Carga #'+esc(e.load_id):''}${e.delivered_kg?' · '+esc(e.delivered_kg)+' kg parciales':''}${e.minutes?' · '+esc(e.minutes)+' min':''} · ${esc(e.reason||'')}</small>`).join('')||'<p>Sin registros.</p>'}
    `}${data.coherence&&!data.coherence.ready?'<p class="it-warning" role="alert">'+data.coherence.issues.map(esc).join(' ')+'</p>':''}<div id="it-route-map" class="it-map" hidden></div><div id="it-history"></div>`;
   if(p&&window.L){const node=panel.querySelector('#it-route-map');node.hidden=false;mapPreview(node,p.stops,p.legs);}if(p&&!closed&&window.setInterval){const currentTimer=window.setInterval(async()=>{
    if(identity()!==token||!panel.isConnected||String(window.currentTripId)!==String(id)){window.clearInterval(currentTimer);if(timer===currentTimer)timer=null;return;}
    if(document.hidden)return;
    try{const fresh=await api(id);if(identity()!==token||!panel.isConnected||String(window.currentTripId)!==String(id))return;
     panel.querySelector('#it-eta-value').textContent=date(fresh.eta?.estimated_arrival);
     panel.querySelector('#it-eta-state').textContent=fresh.version!==data.version?'El plan cambió: vuelve a abrir el viaje.':etaLabel[fresh.eta?.state]||'Sin estimación';
    }catch{if(panel.isConnected)panel.querySelector('#it-eta-state').textContent='No se pudo actualizar: estimación desactualizada';}
   },60000);timer=currentTimer;}
   panel.onclick=async e=>{const b=e.target.closest?.('[data-action]');if(!b||b.disabled)return;b.disabled=true;try{
    const a=b.dataset.action;if(a==='edit'){const opts=await api(id,'/options');if(identity()===token&&String(window.currentTripId)===String(id)&&panel.isConnected)await edit(id,data,opts);}else if(a==='history')await history(id,panel.querySelector('#it-history'));else if(a==='refresh')await window.openTrip(id);else await record(id,data,a,b.dataset.stop);
   }catch(e){if(identity()===token)alert(e.message);}finally{if(b.isConnected)b.disabled=false;}};
  }catch(e){if(identity()===token&&panel.isConnected)panel.innerHTML='<p role="alert">'+esc(e.message)+'</p>';}
 }
 window.openTripPlanner=()=>{
  const panel=document.querySelector('#tripPanelSummary .itinerary'),edit=panel?.querySelector('[data-action="edit"]');
  if(edit)return edit.click();
  if(panel){panel.scrollIntoView?.({block:'start'});return;}
  alert('Espera a que cargue el planificador del viaje y vuelve a intentarlo.');
 };
 const open=window.openTrip;
 if(open)window.openTrip=async function(id){if(timer){window.clearInterval(timer);timer=null;}await open(id);if(String(window.currentTripId)===String(id))await attach(id);};
})();
