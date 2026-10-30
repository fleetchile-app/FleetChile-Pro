(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let vault=null,identity='',generation=0,syncing=null,storageError='';
 const contexts=new Map();
 const actionLabels={accept:'Aceptación',events:'Evento del recorrido',checklist:'Checklist',delivery:'Entrega',fuel:'Combustible'};
 const purposeLabels={pickup:'Recogida',delivery:'Entrega',mixed:'Recogida y entrega',rest:'Descanso',toll:'Peaje',weigh:'Pesaje',other:'Otra parada'};
 const checks=window.FleetChecklist?.controls||[['brakes','Frenos y dirección'],['tires','Neumáticos'],['lights','Luces y señalización'],['visibility','Espejos, vidrios y visibilidad'],['safety','Elementos de seguridad'],['documents','Documentación del vehículo']];
 async function request(path,body){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{return await Auth.request(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}:{signal:controller.signal});}
  finally{clearTimeout(timeout);}
 }
 const base=id=>'/api/driver/trips/'+encodeURIComponent(id)+'/workflow';
 function bind(){
  const next=DriverVault.owner(Auth.user);
  if(next===identity&&vault)return;
  generation++;identity=next;contexts.clear();storageError='';
  try{vault=DriverVault.create(Auth.user);}catch(e){vault=null;storageError=e.message;}
 }
 function active(stamp){try{return stamp===generation&&Auth.user&&DriverVault.owner(Auth.user)===identity;}catch{return false;}}
 function requireVault(){if(!vault)throw Error(storageError||'El almacenamiento local no está disponible');return vault;}
 async function queue(tripId,kind,payload,id=crypto.randomUUID()){
  const store=requireVault(),context=contexts.get(String(tripId)),stamp=generation;
  if(!context)throw Error('Abre el viaje con conexión antes de registrar pendientes');
  const row={id,tripId,kind,state:'queued',created_at:new Date().toISOString(),payload:{resource_version:context.resource_version,version:context.version,...payload}};
  // A retry uses the same immutable submission. Never replace it with new versions.
  const old=await store.get(id);if(!active(stamp))throw Error('La sesión cambió');if(old&&old.state!=='draft'){await sync();return old;}
  await store.put(id,row);if(!active(stamp))return row;await renderOutbox();await sync();return row;
 }
 async function sync(){
  if(syncing)return syncing;
  if(!vault||!Auth.user||navigator.onLine===false)return;
  const stamp=generation,store=vault,owner=identity;
  syncing=(async()=>{
   try{
    const me=await request('/api/auth/me');if(!active(stamp)||me.user?.must_change_password||DriverVault.owner(me.user)!==owner)throw Error('La identidad cambió. Vuelve a iniciar sesión.');
    storageError='';
    const blocked=new Set();
    for(const row of await store.list()){
     if(!active(stamp))return;
     if(row.state==='draft')continue;
     if(row.state==='review'){if(row.kind!=='fuel')blocked.add(String(row.tripId));continue;}
     if(blocked.has(String(row.tripId))&&row.kind!=='fuel')continue;
     try{
      // Server checks ownership and versions under its transaction lock. Avoid a
      // preflight version rewrite: a lost success response must replay its key.
      const path=['delivery','fuel'].includes(row.kind)?'/api/driver/trips/'+encodeURIComponent(row.tripId)+'/'+(row.kind==='fuel'?'fuel':'deliveries'):base(row.tripId)+'/'+row.kind;
      await request(path,row.payload);
      if(!active(stamp))return;
      await store.remove(row.id);
      if(row.kind==='delivery')await store.remove('draft-delivery-'+row.tripId+'-'+row.payload.load_id);
      if(row.kind==='fuel')await store.remove('draft-fuel-'+row.tripId);
     }catch(e){
      if(!active(stamp))return;
      if(e.status===401||e.status===403){storageError='Acceso no validado. Conservamos tus pendientes; inicia sesión o consulta a administración.';return;}
      if(e.status&&e.status<500){row.state='review';row.error=e.message;await store.put(row.id,row);if(row.kind!=='fuel')blocked.add(String(row.tripId));}
      else{storageError='Sin confirmación del servidor. Conservamos el envío para reintentar con la misma identificación.';return;}
     }
    }
   }catch(e){if(active(stamp))storageError=e.message;}
  })().finally(async()=>{syncing=null;if(active(stamp))await renderOutbox();});
  return syncing;
 }
 async function renderOutbox(){
  const host=document.querySelector('[data-mobile-outbox]');if(!host)return;
  const stamp=generation;let rows=[];
  try{if(vault)rows=await vault.list();}catch(e){storageError=e.message;}
  if(!active(stamp)||!host.isConnected)return;
  host.innerHTML=`<h2>Pendientes del teléfono (${rows.length})</h2><p>Guardado local no significa recibido por FleetChile. Sincroniza antes de cerrar sesión. El navegador puede borrar sus datos; no es un respaldo.</p>${storageError?`<p class="driver-error" role="alert">${esc(storageError)}</p>`:''}<button class="driver-button" data-sync>Sincronizar pendientes</button><div>${rows.map(r=>`<div class="driver-mobile-pending"><b>${esc(actionLabels[r.kind]||r.kind)} · Viaje #${esc(r.tripId)}</b><span>${r.state==='draft'?'Borrador local':r.state==='review'?'Requiere revisión con operaciones':'Pendiente de confirmación'}</span>${r.error?`<p>${esc(r.error)}</p>`:''}${r.state==='draft'?'<small>Abre el viaje para recuperar este borrador en su formulario.</small>':''}<button class="driver-link" data-discard="${esc(r.id)}">Descartar del teléfono</button></div>`).join('')}</div>`;
  host.querySelector('[data-sync]').onclick=async e=>{e.target.disabled=true;storageError='';await sync();e.target.disabled=false;};
  host.querySelectorAll('[data-discard]').forEach(b=>b.onclick=async()=>{if(confirm('¿Descartar este registro local? No elimina lo ya recibido por el servidor y no podrá recuperarse aquí.')){await vault.remove(b.dataset.discard);await renderOutbox();}});
  for(const row of rows.filter(r=>r.state==='review'&&['delivery','fuel'].includes(r.kind))){
   const discard=[...host.querySelectorAll('[data-discard]')].find(b=>b.dataset.discard===row.id);
   const button=document.createElement('button');button.className='driver-link';button.textContent='Comprobar recepción';discard.before(button);
   button.onclick=async()=>{button.disabled=true;try{await reconcile(row.id);}catch(e){storageError=e.message;await renderOutbox();}finally{button.disabled=false;}};
  }
 }
 async function reconcile(id){
  const store=requireVault(),stamp=generation,row=await store.get(id);if(!row||!active(stamp))return false;
  const path='/api/driver/trips/'+encodeURIComponent(row.tripId)+'/'+(row.kind==='fuel'?'fuel':'deliveries');
  if(!['fuel','delivery'].includes(row.kind))return false;
  const data=await request(path);if(!active(stamp))return false;
  const received=row.kind==='fuel'?data.rows?.some(r=>r.client_key===row.payload.client_key&&r.result?.photo_received):data.deliveries?.some(l=>String(l.id)===String(row.payload.load_id)&&l.deliveries?.some(p=>p.client_submission_id===row.payload.client_submission_id&&p.status==='CLOSED'&&p.evidence?.some(f=>f.type==='signature'&&f.exists)&&(row.payload.photo?p.evidence?.some(f=>f.type==='photo'&&f.exists):true)));
  if(!received)throw Error('El servidor no confirmó este envío. Se conserva íntegro en el teléfono; consulta a operaciones. No se reabre ni modifica el viaje.');
  await store.remove(row.id);await store.remove(row.kind==='fuel'?'draft-fuel-'+row.tripId:'draft-delivery-'+row.tripId+'-'+row.payload.load_id);
  storageError='Recepción comprobada en el servidor.';await renderOutbox();return true;
 }
 function mountOutbox(){
  if(!vault&&!storageError)return;
  if(!document.querySelector('[data-mobile-outbox]')){const host=document.createElement('section');host.className='driver-card driver-mobile';host.dataset.mobileOutbox='';document.querySelector('.driver-header')?.after(host);}
  renderOutbox();
 }
 async function workflow(trip,detail,onChange=()=>{}){
  bind();mountOutbox();const stamp=generation,host=document.createElement('section');host.className='driver-card driver-mobile';detail.prepend(host);
  async function refresh(){
   host.innerHTML='<p>Cargando próxima parada…</p>';
   try{
    const ctx=await request(base(trip.id));if(!active(stamp)||!host.isConnected)return;
    contexts.set(String(trip.id),ctx);
    if(window.DriverFuel&&!detail.querySelector('[data-driver-fuel]'))await window.DriverFuel.mount(trip,detail,ctx);
    const stop=ctx.next_stop,at=Boolean(stop?.actual_arrival),closed=['Completado','Cancelado'].includes(ctx.status);
    host.innerHTML=`<h2>Mi recorrido</h2><p>${ctx.accepted_at?'Asignación aceptada y confirmada':'La aceptación no inicia el viaje ni reemplaza el checklist.'}</p>${!ctx.accepted_at&&!closed?'<button class="driver-button" data-accept>Aceptar viaje</button>':''}${stop?`<h3>Próxima parada: ${esc(stop.location?.name||stop.key)}</h3><p>${esc(stop.location?.address||'')} · ${esc(purposeLabels[stop.purpose]||stop.purpose)}</p><p>Previsto: ${esc(new Date(stop.planned_arrival).toLocaleString('es-CL'))}</p><button class="driver-button" data-action="${at?'depart':'arrive'}" ${closed?'disabled':''}>${at?'Registrar salida':'Registrar llegada'}</button><div>${ctx.loads.filter(l=>l.pickup===stop.key||l.delivery===stop.key).map(l=>`<div class="driver-mobile-load"><b>${esc(l.cargo)} · ${esc(l.client_name)}</b><span>${l.pickup===stop.key?'Recogida':'Entrega'} · ${esc(l.remaining_kg??l.weight_kg??'Peso pendiente')} kg pendientes</span>${l.pickup===stop.key&&!l.picked_up&&at?`<button class="driver-button" data-pickup="${esc(l.id)}">Confirmar recogida</button>`:''}${l.delivery===stop.key&&l.status!=='Entregada'?`<p>La entrega con firma se registra en Entregas, más abajo.</p>${at?`<button class="driver-link" data-exception="${esc(l.id)}">Entrega parcial, fallida o solicitar reprogramación</button>`:''}`:''}</div>`).join('')}</div>`:ctx.version?'<p>Paradas finalizadas. Revisa las cargas antes de completar el viaje.</p>':'<p>Este viaje no tiene itinerario multientrega. Conserva el circuito de entregas habitual.</p>'}${!closed&&ctx.version?'<button class="driver-link" data-delay>Registrar incidente o demora</button>':''}<div data-mobile-message role="status" aria-live="polite"></div><div data-event-form></div>`;
    const refreshButton=document.createElement('button');refreshButton.className='driver-link';refreshButton.textContent='Actualizar recorrido';refreshButton.onclick=refresh;host.prepend(refreshButton);
    host.querySelector('[data-accept]')?.addEventListener('click',()=>send('accept',{client_key:crypto.randomUUID()}));
    host.querySelector('[data-action]')?.addEventListener('click',e=>send('events',{kind:e.target.dataset.action,stop_key:stop.key,event_key:crypto.randomUUID()}));
    host.querySelectorAll('[data-pickup]').forEach(b=>b.onclick=()=>send('events',{kind:'pickup',load_id:Number(b.dataset.pickup),stop_key:stop.key,event_key:crypto.randomUUID()}));
    host.querySelectorAll('[data-exception]').forEach(b=>b.onclick=()=>eventForm(Number(b.dataset.exception),stop));
    host.querySelector('[data-delay]')?.addEventListener('click',()=>eventForm(null,stop));
    await onChange();
   }catch(e){if(active(stamp)&&host.isConnected)host.innerHTML=`<p class="driver-error">${esc(e.message)}. Conserva esta pantalla para registrar pendientes si ya cargaste el viaje.</p>`;}
  }
  async function send(kind,payload){
   const message=host.querySelector('[data-mobile-message]');host.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{const row=await queue(trip.id,kind,{...payload,reported_at:new Date().toISOString()});if(!active(stamp)||!host.isConnected)return;
    if(!await vault.get(row.id))await refresh();else{message.textContent='Guardado en este teléfono; falta confirmación del servidor. Sincroniza y pulsa Actualizar recorrido antes de continuar.';const refreshButton=host.querySelector('.driver-link');if(refreshButton)refreshButton.disabled=false;}
   }catch(e){if(message)message.textContent=e.message;host.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }
  function eventForm(loadId,stop){
   const box=host.querySelector('[data-event-form]');box.innerHTML=`<form class="driver-mobile-form"><h3>${loadId?'Excepción de entrega':'Incidente / demora'}</h3>${loadId?'<label>Resultado<select name="kind"><option value="failed">Fallida</option><option value="partial">Parcial</option><option value="reschedule">Solicitar reprogramación</option></select></label><label>Peso entregado en esta ocasión (solo parcial)<input name="delivered_kg" type="number" min="0.001" step="0.001"></label>':'<input name="kind" type="hidden" value="delay"><label>Demora estimada en minutos<input name="minutes" type="number" min="1" max="10080" required></label>'}<label>Motivo<textarea name="reason" maxlength="2000" required></textarea></label><p>Una excepción no completa la carga. Operaciones debe aprobar cualquier cambio del itinerario.</p><button class="driver-button">Guardar evento</button></form>`;
   box.querySelector('form').onsubmit=e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target));if(b.kind!=='partial')delete b.delivered_kg;send('events',{...b,...(loadId?{load_id:loadId}:{}),...(stop?{stop_key:stop.key}:{}),event_key:crypto.randomUUID()});};
  }
  await refresh();
 }
 async function checklist(id,box){
  const stamp=generation;
  try{
   const ctx=contexts.get(String(id))||await request(base(id));if(!active(stamp)||!box.isConnected)return;contexts.set(String(id),ctx);
   const data=await request('/api/driver/trips/'+encodeURIComponent(id)+'/checklist');if(!active(stamp)||!box.isConnected)return;
   const current=data.checklists?.[0],rules=window.FleetChecklist;if(!rules)throw Error('Actualiza la app para cargar el formulario de inspección. No se modificó ningún registro.');
   const replacement=rules.canRegularize(current),closed=['Completado','Cancelado'].includes(ctx.status);
   if(current&&current.status!=='Pendiente'&&(!replacement||closed)){box.innerHTML='<h3>Checklist preoperacional</h3>'+rules.summary(current)+(current.status==='Rechazado'?'<p class="driver-error">Falla notificada a operaciones. Este registro no autoriza la salida.</p>':'');return;}
   if(closed){box.innerHTML='<h3>Checklist preoperacional</h3><p>El viaje está cerrado. No se registran inspecciones retroactivas.</p>';return;}
   const draftId='draft-checklist-'+id,saved=vault?await vault.get(draftId):null;
   if(!active(stamp)||!box.isConnected)return;
   box.innerHTML=`<h3>Checklist preoperacional</h3>${replacement?rules.summary(current)+'<p>Realiza una inspección nueva. El registro anterior se conservará sin cambios.</p>':''}<p>Revisa físicamente el vehículo. Una respuesta con falla lo cierra rechazado y genera alerta.</p><form class="driver-mobile-form">${checks.map(([key,label])=>`<label>${label}<select name="${key}" required><option value="">Seleccionar</option><option value="ok">Conforme</option><option value="fail">Con falla</option></select></label>`).join('')}<label>Observaciones<textarea name="observations" maxlength="2000"></textarea></label>${replacement?'<label>Motivo de la nueva inspección<input name="reason" required minlength="5" maxlength="1000"></label>':''}<p data-draft-status role="status"></p><button class="driver-button">${replacement?'Registrar nueva inspección':'Enviar checklist'}</button></form>`;
   const form=box.querySelector('form'),status=form.querySelector('[data-draft-status]');
   if(saved?.values)for(const [k,v] of Object.entries(saved.values))if(form.elements[k])form.elements[k].value=v;
   // The indicator describes an individual answer, never approval of the whole inspection.
   function refreshAnswers(){for(const [key] of checks){const select=form.elements[key];let indicator=select.parentElement.querySelector('.driver-check-answer');if(!indicator){const row=document.createElement('span');row.className='driver-check-answer-row';select.before(row);row.append(select);indicator=document.createElement('span');indicator.className='driver-check-answer';indicator.setAttribute('role','status');indicator.setAttribute('aria-live','polite');row.append(indicator);}const state=select.value==='ok'?'ok':select.value==='fail'?'fail':'';indicator.dataset.result=state;indicator.textContent=state==='ok'?'✓':state==='fail'?'✕':'';indicator.setAttribute('aria-label',state==='ok'?'Conforme':state==='fail'?'Con falla':'Sin respuesta');}}
   refreshAnswers();
   form.addEventListener('input',refreshAnswers);
   form.addEventListener('change',refreshAnswers);
   const values=()=>Object.fromEntries(new FormData(form));
   form.oninput=async()=>{if(!active(stamp)||!box.isConnected)return;try{await requireVault().put(draftId,{id:draftId,tripId:id,kind:'checklist',state:'draft',values:values(),context:saved?.context||{resource_version:ctx.resource_version,version:ctx.version}});status.textContent='Borrador guardado en este teléfono.';}catch(e){status.textContent=e.message;}};
   form.onsubmit=async e=>{e.preventDefault();if(!active(stamp)||!box.isConnected)return;const b=values();form.querySelector('button').disabled=true;
    try{
     if(saved?.context&&(saved.context.version!==ctx.version||saved.context.resource_version!==ctx.resource_version))throw Error('El borrador pertenece a otra versión del viaje. Revisa nuevamente el vehículo con operaciones.');
     const items=checks.map(([key])=>({id:key,result:b[key]})),result=items.some(i=>i.result==='fail')?'Rechazado':'Aprobado';rules.validate({status:result,items,observations:b.observations});
     const key=crypto.randomUUID();await queue(id,'checklist',{client_key:key,reported_at:new Date().toISOString(),items,observations:b.observations,...(replacement?{supersedes_id:current.id,reason:b.reason}:{})},key);
     await vault.remove(draftId);if(!active(stamp)||!box.isConnected)return;
     if(navigator.onLine!==false&&!await vault.get(key)){await checklist(id,box);return;}
     status.textContent='Pendiente de confirmación. Consulta Pendientes del teléfono; no se presenta como aprobado.';await renderOutbox();form.querySelectorAll('select,textarea,input').forEach(el=>el.disabled=true);
    }catch(error){status.textContent=error.message;form.querySelector('button').disabled=false;}
   };
  }catch(e){if(active(stamp)&&box.isConnected)box.innerHTML=`<p class="driver-error">${esc(e.message)}</p>`;}
 }
 async function photoData(file){
  if(file.size>5*1024*1024)throw Error('La fotografía supera 5 MB. Toma una imagen de menor tamaño.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Selecciona una fotografía JPG, PNG o WebP');
  const image=await createImageBitmap(file);try{
   const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
   const data=canvas.toDataURL('image/jpeg',0.75);if(data.length>1200000)throw Error('La fotografía sigue siendo demasiado grande. Usa otra imagen.');return data;
  }finally{image.close();}
 }
 window.DriverMobile={bind,mountOutbox,workflow,checklist,photoData,
  pause(){generation++;identity='';vault=null;contexts.clear();},
  async logout(){const store=vault;if(store){const rows=await store.list();if(rows.length&&!confirm('Hay '+rows.length+' registros locales. Cerrar sesión los eliminará de este teléfono. Cancela y sincroniza si deseas conservarlos.'))return false;generation++;vault=null;contexts.clear();await store.purge();}generation++;identity='';vault=null;contexts.clear();return true;},
  context:id=>contexts.get(String(id)),
  async ensureContext(id){const stamp=generation,ctx=contexts.get(String(id))||await request(base(id));if(!active(stamp))throw Error('La sesión cambió');contexts.set(String(id),ctx);return ctx;},
  pending:async id=>requireVault().get(id),
  draft:async(id,value)=>{const store=requireVault();return value?store.put(id,value):store.get(id);},
  async delivery(tripId,payload){await queue(tripId,'delivery',payload,payload.client_submission_id);return {pending:Boolean(await vault.get(payload.client_submission_id))};},
  async fuel(tripId,payload){await queue(tripId,'fuel',payload,payload.client_key);return {pending:Boolean(await vault.get(payload.client_key))};},
  reconcile,sync
 };
 window.addEventListener('online',()=>{if(Auth.user&&vault)sync();else if(Auth.token)authBoot();});
})();
