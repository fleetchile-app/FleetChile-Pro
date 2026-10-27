(function(){
 'use strict';
 const BASE='/api/fleet/work-orders',esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const historicalEditor=window.openMaintenanceForm;
 const stages={scheduled:'Programada',received:'Ingresada al taller',in_progress:'En trabajo',released:'Liberada · costos pendientes',closed:'Cerrada',cancelled:'Cancelada'};
 const kinds={part:'Repuesto',labor:'Mano de obra',service:'Servicio externo'},states={pending:'Pendiente',done:'Realizado',cancelled:'Cancelado',open:'Abierto',fixed:'Reparado',verified:'Verificado'};
 const dt=v=>v?new Date(v).toLocaleString('es-CL'):'Sin registrar',money=v=>v==null?'Por determinar':new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(v);
 const field=(name,label,value='',type='text',extra='')=>`<label class="mw-field">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value??'')}" ${extra}></label>`;
 const area=(name,label,value='',required=false)=>`<label class="mw-field mw-full">${esc(label)}<textarea name="${name}" ${required?'required':''} maxlength="4000">${esc(value)}</textarea></label>`;
 const select=(name,label,rows,value='',empty='Sin asignar')=>`<label class="mw-field">${esc(label)}<select name="${name}"><option value="">${esc(empty)}</option>${rows.map(r=>`<option value="${esc(r[0])}" ${String(r[0])===String(value)?'selected':''}>${esc(r[1])}</option>`).join('')}</select></label>`;
 const button=(text,action,id='',primary=false)=>`<button type="button" class="mw-${primary?'primary':'secondary'}" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
 let root,identity='',revision=0,options={trucks:[],drivers:[],users:[]},order=null,filters={page:1},listRows=[];
 const currentIdentity=()=>String(window.Auth?.token||'')+'|'+String(localStorage.getItem('fleet_company_context')||'')+'|'+String(window.Auth?.user?.company_id||'');
 const live=()=>root&&root.isConnected&&document.getElementById('mw-root')===root&&identity===currentIdentity();
 async function api(path='',method='GET',body){
  if(!live())throw Error('Vista o sesión reemplazada');
  return window.Auth.request(BASE+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 }
 function paint(html){if(!live())return;root.innerHTML=`<div class="mw-error" role="alert" hidden></div>${html}`;root.onclick=event=>{const b=event.target.closest('[data-action]');if(b&&root.contains(b))action(b.dataset.action,b.dataset.id).catch(error);};}
 function error(e){if(!live())return;const box=root.querySelector('.mw-error');if(box){box.hidden=false;box.textContent=e.message||'No se pudo completar la operación';box.scrollIntoView?.({block:'nearest'});}}
 function form(title,html,save){
  ++revision;
  paint(`<div class="mw-head"><h2>${esc(title)}</h2>${button('Volver',order?'detail':'list',order?.id||'')}</div><form class="mw-card"><div class="mw-grid">${html}</div><div class="mw-actions"><button type="submit" class="mw-primary">Guardar</button></div></form>`);
  const f=root.querySelector('form');f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('[type=submit]');b.disabled=true;
   try{await save(Object.fromEntries(new FormData(f)));}catch(e){error(e);if(live())b.disabled=false;}
  };
 }
 const routineFields=r=>`<fieldset class="mw-full"><legend>Repetición preventiva (opcional)</legend><p>Deja intervalos vacíos si no deseas una rutina. Al liberar, se programará la siguiente orden; no se inmoviliza por anticipado.</p><div class="mw-grid">${field('routine_name','Nombre de rutina',r?.name||'')}${field('routine_days','Cada cuántos días',r?.days||'','number','min="1" step="1"')}${field('routine_km','Cada cuántos km',r?.km||'','number','min="1" step="1"')}${field('routine_hours','Cada cuántas horas',r?.hours||'','number','min="0.1" step="0.1"')}</div></fieldset>`;
 const getRoutine=b=>b.routine_days||b.routine_km||b.routine_hours?{name:b.routine_name,days:b.routine_days||null,km:b.routine_km||null,hours:b.routine_hours||null}:null;
 const localNow=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 const intakeFields=(o={})=>`${field('received_at','Fecha y hora de ingreso',localNow(),'datetime-local','required')}${field('odometer_km','Odómetro al ingresar (km)',o.current_odometer_km??o.km??'','number','required min="0" step="1"')}${field('hour_meter_hours','Horómetro (horas, opcional)',o.hour_meter_hours??'','number','min="0" step="0.1"')}${select('delivered_by_driver_id','Conductor que entrega (opcional)',options.drivers.map(d=>[d.id,d.name]))}`;
 const version=()=>({work_order_version:order.work_order_version});
 const scheduleFields=(o={})=>`${field('scheduled_for','Fecha programada (opcional)',String(o.due||'').slice(0,10),'date')}${field('scheduled_odometer_km','Programar a los km (opcional)',o.next_due_odometer_km,'number','min="0" step="1"')}${field('scheduled_hours','Programar a las horas (opcional)',o.next_due_hours,'number','min="0" step="0.1"')}<p class="mw-help mw-full">Indica al menos un criterio: fecha, km u horas. Se considera vencida al cumplirse cualquiera de los criterios.</p>`;
 async function mutate(path,method,data){
  const id=order.id,rev=revision;await api('/'+id+path,method,{...version(),...data});if(live()&&rev===revision)await detail(id);
 }
 async function list(){
  order=null;const rev=++revision;paint('<h2>Mantenciones</h2><p role="status">Cargando órdenes…</p>');
  const q=new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==''&&v!=null));const data=await api('?'+q);
  if(!live()||rev!==revision)return;listRows=data.rows;
  paint(`<div class="mw-head"><div><h2>Mantenciones</h2><p>Programa → ingresa al taller → registra trabajos → libera → cierra costos.</p></div><div class="mw-actions">${options.can_operate_fleet!==false?button('Ingresar al taller','new-receive','',true):''}${button('Programar mantención','new-schedule')}</div></div>
   <p class="mw-help">Programar no inmoviliza. El ingreso real deja el vehículo en mantención. La liberación técnica y el cierre de costos son pasos distintos.</p>
   <form class="mw-card mw-grid" id="mw-filters">${select('truck_id','Vehículo',options.trucks.map(t=>[t.id,t.patente]),filters.truck_id,'Todos')}${select('stage','Etapa',[...Object.entries(stages),['legacy','Histórico anterior']],filters.stage,'Todas')}<button class="mw-secondary" type="submit">Aplicar filtros</button></form>
   <p>${Number(data.total)} registros · Página ${Number(data.page)}</p><div class="mw-card mw-scroll"><table><thead><tr>${['Orden / vehículo','Motivo','Etapa','Ingreso / programación','Inmovilización','Costo final','Acción'].map(s=>`<th>${s}</th>`).join('')}</tr></thead><tbody>${data.rows.length?data.rows.map(o=>`<tr><td><strong>OT #${Number(o.id)} · ${esc(o.patente||o.truck||'Sin vehículo')}</strong><small>${esc(o.maintenance_type||'Anterior')}</small></td><td>${esc(o.item)}</td><td><span class="mw-badge">${esc(stages[o.operation_stage]||o.status||'Histórico')}</span>${o.overdue?'<small class="mw-warn">Rutina vencida por fecha, km u horas</small>':''}</td><td>${o.received_at?esc(dt(o.received_at)):esc(String(o.due||'Sin fecha').slice(0,10))}${o.next_due_odometer_km!=null?`<small>Próximo: ${esc(o.next_due_odometer_km)} km</small>`:''}${o.next_due_hours!=null?`<small>Próximo: ${esc(o.next_due_hours)} h</small>`:''}</td><td>${o.downtime_hours==null?'—':esc(Number(o.downtime_hours).toFixed(1))+' h'}</td><td>${esc(money(o.cost_clp))}</td><td>${button(o.operation_stage?'Abrir ficha':'Ver histórico',o.operation_stage?'detail':'legacy',o.id)}</td></tr>`).join(''):'<tr><td colspan="7">No hay registros para estos filtros.</td></tr>'}</tbody></table></div>
   <div class="mw-actions">${Number(data.page)>1?button('Anterior','prev'):''}${Number(data.page)*Number(data.page_size)<Number(data.total)?button('Siguiente','next'):''}</div>`);
  root.querySelector('#mw-filters').onsubmit=e=>{e.preventDefault();filters={...Object.fromEntries(new FormData(e.target)),page:1};list().catch(error);};
 }
 async function detail(id){
  const rev=++revision;paint('<h2>Ficha de mantención</h2><p role="status">Consultando orden…</p>');const o=await api('/'+encodeURIComponent(id));
  if(!live()||rev!==revision)return;order=o;
  if(!o.operation_stage){legacy(o);return;}
  const technical=['received','in_progress'].includes(o.operation_stage),editable=!['closed','cancelled'].includes(o.operation_stage);
  paint(`<div class="mw-head"><div><h2>OT #${Number(o.id)} · ${esc(o.patente)}</h2><span class="mw-badge">${esc(stages[o.operation_stage])}</span></div>${button('Volver a mantenciones','list')}</div>
   <div class="mw-card"><h3>${esc(o.item)}</h3><div class="mw-facts">${[
    ['Ingreso real',dt(o.received_at)],['Liberación técnica',dt(o.released_at)],['Tiempo inmovilizado',o.downtime_hours==null?'Sin ingreso':Number(o.downtime_hours).toFixed(1)+' h'],
    ['Responsable',o.responsible_name||'Sin asignar'],['Entrega vehículo',o.delivered_by_name||'Sin conductor registrado'],['Odómetro de ingreso',o.odometer_km==null?'Sin lectura':o.odometer_km+' km'],
    ['Estimado',money(o.costs.estimated)],['Trabajos / repuestos registrados',money(o.costs.actual)],['Costo final confirmado',money(o.cost_clp)]
   ].map(([a,b])=>`<div>${esc(a)}<strong>${esc(b)}</strong></div>`).join('')}</div><p><strong>Diagnóstico:</strong> ${esc(o.diagnosis||'Por registrar')}</p><p><strong>Trabajos realizados:</strong> ${esc(o.work_summary||'Por registrar')}</p>${o.release_note?`<p><strong>Conclusión:</strong> ${esc(o.release_note)}</p>`:''}
   <div class="mw-actions">${o.operation_stage==='scheduled'&&options.can_operate_fleet!==false?button('Registrar ingreso','receive','',true):''}${editable&&o.operation_stage!=='released'?button('Editar ficha / diagnóstico','edit'):''}${technical&&options.can_operate_fleet!==false?button('Liberar técnicamente','release','',true):''}${o.operation_stage==='released'?button('Cerrar costos','close','',true):''}${o.operation_stage==='scheduled'?button('Cancelar programación','cancel'):''}${technical&&options.can_operate_fleet!==false?button('Agregar lectura','meters'):''}</div></div>
   <div class="mw-card"><div class="mw-head"><h3>Trabajos, servicios y repuestos</h3>${editable&&o.operation_stage!=='released'?button('Agregar','item-new'):''}</div><p>Un precio vacío significa por determinar. Cero es un costo informado explícitamente.</p><div class="mw-scroll"><table><thead><tr><th>Tipo / descripción</th><th>Cantidad</th><th>Unitario estimado</th><th>Unitario real</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${o.lines.map(l=>`<tr><td>${esc(kinds[l.kind])}<strong> · ${esc(l.description)}</strong></td><td>${esc(l.quantity)}</td><td>${esc(money(l.estimated_unit_cost_clp))}</td><td>${esc(money(l.actual_unit_cost_clp))}</td><td>${esc(states[l.status])}</td><td>${editable?button(o.operation_stage==='released'?'Completar precio':'Editar','item',l.id):'—'}</td></tr>`).join('')||'<tr><td colspan="6">Sin trabajos registrados.</td></tr>'}</tbody></table></div></div>
   <div class="mw-card"><div class="mw-head"><h3>Hallazgos y reparaciones</h3>${technical?button('Registrar hallazgo','finding-new'):''}</div>${o.findings.map(f=>`<div class="mw-event"><strong>${esc(f.description)}</strong><small>${esc(({minor:'Menor',major:'Mayor',critical:'Crítico'})[f.severity])} · ${esc(states[f.state])}${f.source_alert_id?' · Alerta #'+Number(f.source_alert_id):''}</small><p>${esc(f.remedy||'Sin reparación registrada')}</p>${technical?button('Gestionar reparación / verificación','finding',f.id):''}</div>`).join('')||'<p>Sin hallazgos registrados.</p>'}</div>
   <div class="mw-card"><h3>Lecturas e historial</h3>${o.readings.map(r=>`<p>${esc(dt(r.reading_at))} · ${esc(r.odometer_km??'—')} km · ${esc(r.hour_meter_hours??'—')} h · ${esc(r.reason)}</p>`).join('')||'<p>Sin lecturas.</p>'}${o.events.map(e=>`<div class="mw-event"><strong>${esc(eventLabel(e.event_type))}</strong><small>${esc(dt(e.occurred_at))} · ${esc(e.actor_name)} · Usuario #${Number(e.actor_user_id)||'—'}</small><p>${esc(eventDetail(e))}</p></div>`).join('')}</div>`);
 }
 function eventLabel(s){return ({schedule:'Programación',intake:'Ingreso al taller',diagnosis:'Actualización de ficha',item_add:'Trabajo/repuesto agregado',item_update:'Trabajo/repuesto actualizado',finding_add:'Hallazgo registrado',finding_update:'Reparación/verificación',meter_reading:'Lectura registrada',technical_release:'Liberación técnica',financial_close:'Cierre de costos',cancel:'Programación cancelada',routine_scheduled:'Próxima rutina programada'})[s]||s;}
 function eventDetail(event){
  const d=event.details||{};
  if(d.finding)return `${d.finding.description} · ${states[d.finding.state]||d.finding.state} · ${d.finding.remedy||'Reparación por registrar'}`;
  if(d.line)return `${d.line.description} · Cantidad: ${d.line.quantity} · ${states[d.line.status]} · Unitario real: ${money(d.line.actual_unit_cost_clp)}`;
  if(d.reading)return `Lectura: ${d.reading.km} km · ${d.reading.hours??'—'} h`;
  if(d.release_note)return d.release_note+(d.next_work_order_id?' · Próxima orden #'+d.next_work_order_id:'');
  if(d.final_cost_clp!=null)return 'Total confirmado: '+money(d.final_cost_clp);
  if(d.reason)return d.reason;
  const after=d.order||{},before=d.before||{},labels={item:'Motivo',diagnosis:'Diagnóstico',work_summary:'Trabajos',responsible_user_id:'Responsable (usuario)',operation_stage:'Etapa',cost_clp:'Costo final'};
  return Object.keys(labels).filter(k=>after[k]!=null&&String(after[k])!==String(before[k]??'')).map(k=>labels[k]+': '+(k==='operation_stage'?stages[after[k]]:k==='cost_clp'?money(after[k]):after[k])).join(' · ');
 }
 function legacy(o){order=o;paint(`<h2>Mantención histórica #${Number(o.id)}</h2><p class="mw-help">Registro anterior al circuito de órdenes de trabajo. No se inventaron fechas de ingreso, liberación ni verificaciones.</p><div class="mw-card"><h3>${esc(o.patente||o.truck||'Vehículo anterior')} · ${esc(o.item)}</h3><p>${esc(o.status)} · ${esc(o.maintenance_type||'Tipo anterior')}</p><p>Costo registrado: ${esc(money(o.cost_clp))}</p><p>${esc(o.notes||'')}</p>${typeof historicalEditor==='function'?button('Editar registro anterior','legacy-edit'):''}${button('Volver','list')}</div>`);}
 function newOrder(mode){order=null;form(mode==='receive'?'Ingreso real al taller':'Programar mantención',`
  <p class="mw-help mw-full">${mode==='receive'?'Al guardar se inmoviliza el vehículo. Los hallazgos, trabajos y costos se registran después.':'Esta programación no cambia la disponibilidad del vehículo.'}</p>
  ${select('truck_id','Vehículo',options.trucks.map(t=>[t.id,t.patente+' · '+t.status]),'','Seleccionar vehículo')}${select('maintenance_type','Tipo',[['Preventiva','Preventiva'],['Correctiva','Correctiva']],'Preventiva')}${field('reason','Motivo / servicio requerido','','text','required maxlength="1000"')}${field('workshop','Taller (opcional)')}${select('responsible_user_id','Responsable interno',options.users.map(u=>[u.id,u.name]))}
  ${mode==='receive'?intakeFields():scheduleFields()}${routineFields(null)}`,
  async b=>{const payload={mode,truck_id:b.truck_id,maintenance_type:b.maintenance_type,reason:b.reason,workshop:b.workshop||null,responsible_user_id:b.responsible_user_id||null,routine:getRoutine(b)};
   if(mode==='schedule')Object.assign(payload,{scheduled_for:b.scheduled_for||null,scheduled_odometer_km:b.scheduled_odometer_km||null,scheduled_hours:b.scheduled_hours||null});else Object.assign(payload,{received_at:new Date(b.received_at).toISOString(),odometer_km:b.odometer_km,hour_meter_hours:b.hour_meter_hours||null,delivered_by_driver_id:b.delivered_by_driver_id||null});
   const rev=revision,saved=await api('','POST',payload);if(live()&&rev===revision)await detail(saved.id);
  });
  if(mode==='receive')root.querySelector('[name=truck_id]').onchange=e=>{const t=options.trucks.find(t=>String(t.id)===e.target.value);if(t){root.querySelector('[name=odometer_km]').value=t.km??'';root.querySelector('[name=hour_meter_hours]').value=t.hour_meter_hours??'';}};
 }
 async function action(name,id){
  if(!live())return;
  if(name==='list')return list();if(name==='detail')return detail(id||order.id);
  if(name==='prev'||name==='next'){filters.page=Number(filters.page||1)+(name==='next'?1:-1);return list();}
  if(name==='new-receive'||name==='new-schedule'){if(name==='new-receive'&&options.can_operate_fleet===false)return;return newOrder(name.slice(4));}
  if(name==='legacy')return legacy(listRows.find(o=>String(o.id)===String(id)));
  if(name==='legacy-edit'&&order&&!order.operation_stage&&typeof historicalEditor==='function')return historicalEditor(order);
  const o=order;
  if(name==='receive')return form('Registrar ingreso',intakeFields(o),b=>mutate('/receive','POST',{...b,received_at:new Date(b.received_at).toISOString(),delivered_by_driver_id:b.delivered_by_driver_id||null,hour_meter_hours:b.hour_meter_hours||null}));
  if(name==='edit')return form('Ficha de mantención',`${field('reason','Motivo',o.item,'text','required')}${field('workshop','Taller',o.workshop)}${select('responsible_user_id','Responsable',options.users.map(u=>[u.id,u.name]),o.responsible_user_id)}${o.operation_stage==='scheduled'?(scheduleFields(o)+routineFields(o.routine)):(area('diagnosis','Diagnóstico',o.diagnosis)+area('work_summary','Resumen de trabajos realizados',o.work_summary))}`,b=>{
   const body={...b,responsible_user_id:b.responsible_user_id||null};if(o.operation_stage==='scheduled'){body.routine=getRoutine(b);for(const k of ['routine_name','routine_days','routine_km','routine_hours'])delete body[k];if(!body.scheduled_for)delete body.scheduled_for;}
   return mutate('','PATCH',body);
  });
  if(name==='item-new'||name==='item'){
   const l=name==='item'?o.lines.find(l=>String(l.id)===String(id)):{};if(!l)return;
   const priceOnly=o.operation_stage==='released';return form(priceOnly?'Completar costo real':'Trabajo / repuesto',`${priceOnly?'':select('kind','Tipo',Object.entries(kinds),l.kind||'part')+field('description','Descripción',l.description,'text','required maxlength="1000"')+field('quantity','Cantidad',l.quantity||1,'number','required min="0.001" step="0.001"')+field('estimated_unit_cost_clp','Precio unitario estimado (CLP)',l.estimated_unit_cost_clp,'number','min="0" step="1"')}${o.operation_stage==='scheduled'?'':field('actual_unit_cost_clp','Precio unitario real (CLP)',l.actual_unit_cost_clp,'number','min="0" step="1"')}${priceOnly?'':select('status','Estado',[['pending','Pendiente'],...(o.operation_stage==='scheduled'?[]:[['done','Realizado']]),['cancelled','Cancelado']],l.status||'pending')}${area('note','Nota / motivo si cancela',l.note)}`,b=>mutate('/items'+(l.id?'/'+l.id:''),l.id?'PATCH':'POST',b));
  }
  if(name==='finding-new')return form('Hallazgo / defecto',`${area('description','Descripción del hallazgo','',true)}${select('severity','Severidad',[['minor','Menor'],['major','Mayor'],['critical','Crítico']],'major')}${select('responsible_user_id','Responsable de reparación',options.users.map(u=>[u.id,u.name]))}${select('source_alert_id','Checklist rechazado pendiente',(o.pending_checklist_alerts||[]).map(a=>[a.id,'#'+a.id+' · '+a.title]))}<p class="mw-help mw-full">Selecciona el checklist rechazado que corresponde a la reparación. Al verificar la reparación y liberar, se resolverá esa alerta con trazabilidad.</p>`,b=>mutate('/findings','POST',{...b,source_alert_id:b.source_alert_id||null,responsible_user_id:b.responsible_user_id||null}));
  if(name==='finding'){const f=o.findings.find(f=>String(f.id)===String(id));const choices=f.state==='open'?[['fixed','Registrar reparación']]:f.state==='fixed'?[['verified','Verificar reparación'],['open','Reabrir hallazgo']]:[['open','Reabrir hallazgo']];return form('Reparación / verificación',`<p class="mw-full">${esc(f.description)}</p>${select('state','Acción',choices,choices[0][0])}${area('remedy','Reparación / resultado de verificación / motivo',f.remedy,true)}`,b=>mutate('/findings/'+f.id,'PATCH',b));}
  if(name==='meters')return form('Registrar lectura',`${field('reading_at','Fecha y hora',localNow(),'datetime-local','required')}${field('odometer_km','Odómetro km',o.current_odometer_km,'number','required min="0" step="1"')}${field('hour_meter_hours','Horómetro horas',o.hour_meter_hours,'number','min="0" step="0.1"')}${area('reason','Motivo','',true)}`,b=>mutate('/meters','POST',{...b,reading_at:new Date(b.reading_at).toISOString()}));
  if(name==='release')return form('Liberación técnica',`<p class="mw-help mw-full">Debes completar diagnóstico, trabajos y verificación de hallazgos. Los precios pueden seguir pendientes. La documentación vial continuará controlándose por separado.</p>${field('released_at','Fecha y hora',localNow(),'datetime-local','required')}${field('odometer_km','Odómetro de salida km',o.current_odometer_km,'number','required min="0" step="1"')}${field('hour_meter_hours','Horómetro de salida horas',o.hour_meter_hours,'number','min="0" step="0.1"')}${area('release_note','Conclusión técnica','',true)}`,b=>mutate('/release','POST',{...b,released_at:new Date(b.released_at).toISOString()}));
  if(name==='close')return form('Cierre de costos',`<p class="mw-help mw-full">El total se calcula desde los trabajos y repuestos realizados. No se reemplaza por un total manual. Completa los precios reales antes de cerrar.</p><p class="mw-full">Total registrado: <strong>${esc(money(o.costs.actual))}</strong></p>${area('zero_cost_reason','Si el total es cero o no hay partidas, indica el motivo')}`,b=>mutate('/close','POST',b));
  if(name==='cancel')return form('Cancelar programación',area('reason','Motivo','',true),b=>mutate('/cancel','POST',b));
 }
 window.maintenance=async function(){
  const app=document.getElementById('app');app.innerHTML='<section id="mw-root" class="mw" aria-label="Mantenciones"></section>';root=document.getElementById('mw-root');identity=currentIdentity();filters={page:1};order=null;
  paint('<h2>Mantenciones</h2><p role="status">Cargando recursos de la empresa…</p>');const rev=++revision;
  try{const data=await api('/options');if(!live()||rev!==revision)return;options=data;await list();}catch(e){error(e);}
 };
 window.openMaintenanceForm=()=>{if(live())newOrder('receive');};
})();
