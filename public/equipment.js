(function(){
 'use strict';
 const CAT='/api/fleet/compositions',TRIP='/api/operations/trips',esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const local=v=>{const d=v?new Date(v):new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 const date=v=>v?new Date(v).toLocaleString('es-CL'):'Sin término',cap=v=>v==null?'Sin capacidad informada':Number(v).toLocaleString('es-CL')+' t';
 const identity=()=>String(window.Auth?.token||'')+'|'+String(localStorage.getItem('fleet_company_context')||'')+'|'+String(window.Auth?.user?.company_id||'');
 const api=(url,method='GET',data)=>window.Auth.request(url,{method,...(data?{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});
 const select=(name,label,rows,value='',empty='Sin asignar')=>`<label class="fp-field">${esc(label)}<select name="${name}"><option value="">${esc(empty)}</option>${rows.map(r=>`<option value="${esc(r[0])}" ${String(r[0])===String(value)?'selected':''}>${esc(r[1])}</option>`).join('')}</select></label>`;
 const input=(name,label,value='',type='text',attrs='')=>`<label class="fp-field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value??'')}" ${attrs}></label>`;
 const button=(label,action,id='')=>`<button type="button" class="fp-secondary" data-eq-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
 const role=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\s_-]/g,'');
 const trailer=t=>['remolque','semirremolque','trailer'].includes(role(t.tipo));
 let root,session='',revision=0,rows=[],vehicles=[],canManage=false,page=1,filters={q:'',active:'active'};
 const live=()=>root?.isConnected&&document.getElementById('eq-root')===root&&session===identity();
 function error(target,e){const box=target.querySelector('.eq-error');if(box){box.hidden=false;box.textContent=e.message||'No se pudo completar la operación';}}
 function summary(s){return `<div class="eq-summary"><div>Vehículo principal<strong>${esc(s?.truck?.patente||'Sin asignar')}</strong></div><div>Remolque / semirremolque<strong>${esc(s?.trailer?.patente||'Sin acoplado')}</strong></div><div>Capacidad informativa<strong>${esc(cap(s?.capacity_t))}</strong></div></div>`;}
 function modal(title,html,save){
  const key=identity(),form=document.getElementById('form'),modal=document.getElementById('modal');document.getElementById('mt').textContent=title;
  form.innerHTML=`<div class="eq"><div class="eq-error" role="alert" hidden></div>${html}<div class="eq-actions"><button type="submit" class="fp-primary">Guardar</button></div></div>`;modal.classList.remove('hidden');
  form.onsubmit=async e=>{e.preventDefault();if(identity()!==key)return;const submit=form.querySelector('[type=submit]');submit.disabled=true;
   try{await save(Object.fromEntries(new FormData(form)));}catch(e){if(identity()===key)error(form,e);}finally{if(identity()===key)submit.disabled=false;}
  };return form;
 }
 function paint(){
  if(!live())return;const q=filters.q.toLocaleLowerCase(),list=rows.filter(c=>(filters.active==='all'||c.active===(filters.active==='active'))&&[c.name,c.truck_patente,c.trailer_patente].some(v=>String(v||'').toLocaleLowerCase().includes(q)));
  const pages=Math.max(1,Math.ceil(list.length/25));page=Math.min(page,pages);
  root.innerHTML=`<div class="eq-error" role="alert" hidden></div><div class="fp-head"><div><h2>Conjuntos y equipos</h2><p>Composiciones reutilizables. El conductor se asigna por viaje, no permanentemente al vehículo.</p></div>${canManage?button('Nuevo conjunto','new'):''}</div>
   <p class="eq-help">Un conjunto no inmoviliza ni reserva vehículos por sí solo. Cada viaje valida sus componentes, documentos, mantenciones y reservas. Cambiar el catálogo no cambia viajes ya asignados.</p>
   <form class="fp-card fp-grid" id="eq-filters">${input('q','Buscar conjunto o patente',filters.q)}${select('active','Estado',[['active','Activos'],['inactive','Inactivos'],['all','Todos']],filters.active,'Seleccionar')}<button type="submit" class="fp-secondary">Filtrar</button></form>
   <p>${list.length} conjuntos · Página ${page} de ${pages}</p><div class="fp-table-wrap"><table class="fp-table"><thead><tr><th>Conjunto</th><th>Vehículo</th><th>Acoplado</th><th>Capacidad</th><th>Vigencia</th><th>Acciones</th></tr></thead><tbody>${list.slice((page-1)*25,page*25).map(c=>`<tr><td><strong>${esc(c.name)}</strong><small>Versión ${Number(c.version)} · ${c.active?'Activo':'Inactivo'}</small></td><td>${esc(c.truck_patente)}</td><td>${esc(c.trailer_patente||'Sin acoplado')}</td><td>${esc(cap(c.capacity_t))}</td><td>${esc(date(c.valid_from))}<small>Hasta: ${esc(date(c.valid_until))}</small></td><td>${canManage?button('Editar','edit',c.id):''} ${button('Historial','history',c.id)}</td></tr>`).join('')||'<tr><td colspan="6">No hay conjuntos para estos filtros.</td></tr>'}</tbody></table></div>
   <div class="eq-actions">${page>1?button('Anterior','prev'):''}${page<pages?button('Siguiente','next'):''}${button('Volver a vehículos','vehicles')}</div><div id="eq-history"></div>`;
  root.onclick=e=>{const b=e.target.closest?.('[data-eq-action]');if(b&&!b.disabled)return action(b.dataset.eqAction,b.dataset.id).catch(e=>{if(live())error(root,e);});};
  root.querySelector('#eq-filters').onsubmit=e=>{e.preventDefault();filters=Object.fromEntries(new FormData(e.target));page=1;paint();};
 }
 async function reload(){const key=session,rev=++revision;const data=await api(CAT);if(!live()||key!==session||rev!==revision)return;rows=data.rows;canManage=data.can_manage;paint();}
 function edit(c=null){
  if(!canManage)return;
  modal(c?'Editar conjunto':'Nuevo conjunto',`<p class="eq-help">Selecciona vehículos registrados. No se suman las capacidades de la cabina y del remolque. Para nuevos tipos, actualiza primero la ficha de vehículos.</p><div class="fp-grid">
   ${input('name','Nombre del conjunto',c?.name,'text','required maxlength="160"')}${select('truck_id','Vehículo principal',vehicles.filter(t=>!trailer(t)).map(t=>[t.id,t.patente+' · '+t.tipo]),c?.truck_id,'Seleccionar')}${select('trailer_id','Remolque / semirremolque (opcional)',vehicles.filter(trailer).map(t=>[t.id,t.patente+' · '+cap(t.capacidad_t)]),c?.trailer_id)}
   ${input('valid_from','Vigente desde',local(c?.valid_from),'datetime-local','required')}${input('valid_until','Vigente hasta (opcional)',c?.valid_until?local(c.valid_until):'','datetime-local')}${select('active','Estado',[['true','Activo'],['false','Inactivo']],String(c?.active??true),'Seleccionar')}${input('reason','Motivo'+(c?' del cambio':''),'','text',c?'required maxlength="2000"':'maxlength="2000"')}</div>`,async b=>{
    const key=identity();await api(CAT+(c?'/'+c.id:''),c?'PATCH':'POST',{name:b.name,truck_id:b.truck_id,trailer_id:b.trailer_id||null,valid_from:new Date(b.valid_from).toISOString(),valid_until:b.valid_until?new Date(b.valid_until).toISOString():null,active:b.active==='true',...(c?{version:c.version}:{}),...(b.reason?{reason:b.reason}:{})});
    if(identity()!==key)return;document.getElementById('modal').classList.add('hidden');if(live())await reload();
   });
 }
 async function history(id,p=1){
  const key=session,rev=revision,data=await api(CAT+'/'+id+'/history?page='+p);if(!live()||key!==session||rev!==revision)return;
  const target=root.querySelector('#eq-history');target.innerHTML=`<div class="fp-card"><h3>Historial del conjunto</h3>${data.rows.map(h=>`<div class="eq-history"><strong>Versión ${Number(h.version)} · ${esc(date(h.recorded_at))}</strong><small>${esc(h.actor_name)} · Usuario #${esc(h.actor_user_id)}</small><p>${esc(h.reason)}</p>${summary(h.snapshot)}</div>`).join('')||'<p>Sin revisiones visibles.</p>'}<div class="eq-actions">${p>1?button('Revisiones anteriores de esta página','history-prev',id):''}${p*25<data.total?button('Más revisiones','history-next',id):''}</div></div>`;target.dataset.page=String(p);
 }
 async function action(a,id){
  if(!live())return;
  if(a==='vehicles')return window.trucks?.();if(a==='new')return edit();if(a==='edit')return edit(rows.find(c=>String(c.id)===String(id)));
  if(a==='prev'||a==='next'){page+=a==='next'?1:-1;return paint();}
  if(a==='history')return history(id);if(a==='history-next'||a==='history-prev')return history(id,Number(root.querySelector('#eq-history').dataset.page)+(a==='history-next'?1:-1));
 }
 window.openFleetCompositions=async()=>{
  document.getElementById('app').innerHTML='<section id="eq-root" class="eq" aria-label="Conjuntos y equipos"><p role="status">Cargando conjuntos…</p></section>';root=document.getElementById('eq-root');session=identity();const rev=++revision;page=1;filters={q:'',active:'active'};
  try{const [data,opts]=await Promise.all([api(CAT),api(CAT+'/options')]);if(!live()||rev!==revision)return;rows=data.rows;canManage=data.can_manage;vehicles=opts;paint();}catch(e){if(live())root.innerHTML=`<div class="eq-error" role="alert">${esc(e.message)}</div>`;}
 };
 window.assignTrip=async function(id){
  const key=identity();let data,opts;try{[data,opts]=await Promise.all([api(TRIP+'/'+id+'/resources'),api(TRIP+'/'+id+'/resources/options')]);}catch(e){if(identity()===key)alert(e.message);return;}
  if(identity()!==key||window.currentTripId!=null&&String(window.currentTripId)!==String(id))return;
  const t=data.trip,original=t.composition_snapshot;
  const form=modal('Asignar conjunto y conductor',`<p class="eq-help">La asignación es para este viaje. Reemplazar recursos conserva el historial, las cargas, el GPS anterior y las evidencias. Los cambios requieren motivo; no se modifica otro viaje.</p>
   ${original?`<p>Configuración registrada: <strong>${esc(original.name||'Individual')} · ${esc(original.truck?.patente)}${original.trailer?' + '+esc(original.trailer.patente):''}</strong> (versión ${Number(original.composition_version)||'individual'}). Volver a guardar un conjunto toma su versión seleccionada actual.</p>`:''}
   <div class="fp-grid">${select('composition_id','Conjunto registrado',opts.compositions.map(c=>[c.id,c.name+' · '+c.truck_patente+(c.trailer_patente?' + '+c.trailer_patente:'')+' · v'+c.version]),t.composition_id,'Asignación individual')}
   ${select('truck_id','Vehículo principal',opts.trucks.filter(v=>!trailer(v)).map(v=>[v.id,v.patente+' · '+v.tipo+' · '+v.status]),t.truck_id,'Asignar después (Planificado)')}${select('trailer_id','Remolque / semirremolque',opts.trucks.filter(trailer).map(v=>[v.id,v.patente+' · '+v.status]),t.trailer_id)}
   ${select('driver_id','Conductor',opts.drivers.map(d=>[d.id,d.name+' · '+d.status]),t.driver_id,'Asignar después (Planificado)')}${select('client_id','Cliente',opts.clients.map(c=>[c.id,c.name]),t.client_id,'Seleccionar cliente')}${select('route_id','Ruta',opts.routes.map(r=>[r.id,r.origin+' → '+r.destination]),t.route_id)}
   ${input('reason','Motivo del cambio','','text','maxlength="2000"')}<div class="eq-wide eq-help" id="eq-composition-preview"></div></div>`,async b=>{
    const selected=opts.compositions.find(c=>String(c.id)===String(b.composition_id));
    const payload={resource_version:t.resource_version,composition_id:selected?selected.id:null,driver_id:b.driver_id||null,client_id:b.client_id||null,route_id:b.route_id||null,reason:b.reason||undefined};
    if(selected)payload.composition_version=selected.version;else Object.assign(payload,{truck_id:b.truck_id||null,trailer_id:b.trailer_id||null});
    await api(TRIP+'/'+id+'/resources','PATCH',payload);if(identity()!==key)return;
    document.getElementById('modal').classList.add('hidden');await window.openTrip(id);
   });
  const choose=form.querySelector('[name=composition_id]'),update=()=>{
   const c=opts.compositions.find(c=>String(c.id)===String(choose.value));form.querySelector('[name=truck_id]').disabled=Boolean(c);form.querySelector('[name=trailer_id]').disabled=Boolean(c);
   form.querySelector('#eq-composition-preview').textContent=c?c.truck_patente+(c.trailer_patente?' + '+c.trailer_patente:'')+' · '+cap(c.capacity_t)+' · Vigente: '+date(c.valid_from)+' hasta '+date(c.valid_until):'Selecciona vehículo y, si corresponde, remolque de tu empresa. La capacidad no se inventa ni se suma a la cabina.';
  };choose.onchange=update;update();
 };
 async function tripHistory(id,panel,page=1){
  const key=identity(),data=await api(TRIP+'/'+id+'/resources?page='+page);if(identity()!==key||!panel.isConnected||String(window.currentTripId)!==String(id))return;
  panel.innerHTML=`<h3>Historial de recursos</h3><p>Las fechas indican cambios registrados. La reserva efectiva también depende del período y estado del viaje.</p>${data.history.map(h=>`<div class="eq-history"><strong>${h.baseline_observation?'Estado previo observado · fecha inicial desconocida':'Versión '+Number(h.version)+' · Desde '+esc(date(h.effective_at))}</strong>${h.effective_until?`<small>Hasta: ${esc(date(h.effective_until))}</small>`:''}<small>${esc(h.actor_name)} · Usuario #${esc(h.actor_user_id)} · Registrado ${esc(date(h.recorded_at))}</small><p>${esc(h.reason)}</p>${summary({truck:h.snapshot.truck,trailer:h.snapshot.trailer,capacity_t:h.snapshot.composition?.capacity_t})}<p>Conductor: <strong>${esc(h.snapshot.driver?.name||'Sin asignar')}</strong></p></div>`).join('')||'<p>Aún no hay asignaciones versionadas. Los eventos anteriores se conservan en Actividad.</p>'}<div class="eq-actions">${page>1?button('Anterior','trip-prev'):''}${page*25<data.total?button('Más historial','trip-next'):''}</div>`;
  panel.onclick=e=>{const b=e.target.closest?.('[data-eq-action]');if(b)return tripHistory(id,panel,page+(b.dataset.eqAction==='trip-next'?1:-1)).catch(e=>{panel.textContent=e.message;});};
 }
 const originalOpenTrip=window.openTrip;
 if(originalOpenTrip)window.openTrip=async function(id){
  const key=identity();await originalOpenTrip(id);if(identity()!==key||String(window.currentTripId)!==String(id))return;
  const body=document.getElementById('drawerBody'),overview=body?.querySelector('.trip-kpis'),trip=window.loadedOperationalTrip;
  if(!overview||!trip||String(trip.id)!==String(id))return;
  overview.insertAdjacentHTML('afterend',`<section class="eq eq-panel" id="eq-trip-resources"><h3>Conjunto asignado</h3><p>${esc(trip.composition_snapshot?.name||'Asignación individual')} ${trip.composition_snapshot?.composition_version?'· v'+Number(trip.composition_snapshot.composition_version):''}</p>${summary(trip.composition_snapshot||{truck:{patente:trip.patente}})}<div class="eq-actions">${button('Ver historial de recursos','trip-history')}</div><div id="eq-trip-history"></div></section>`);
  const section=body.querySelector('#eq-trip-resources');section.onclick=e=>{const b=e.target.closest?.('[data-eq-action]');if(b?.dataset.eqAction==='trip-history')return tripHistory(id,section.querySelector('#eq-trip-history')).catch(e=>{section.querySelector('#eq-trip-history').textContent=e.message;});};
 };
})();
