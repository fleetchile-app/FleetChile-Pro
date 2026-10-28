(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FleetChecklist=api;})(typeof window==='object'?window:globalThis,function(){
 'use strict';
 const controls=Object.freeze([['brakes','Frenos y dirección'],['tires','Neumáticos'],['lights','Luces y señalización'],['visibility','Espejos, vidrios y visibilidad'],['safety','Elementos de seguridad'],['documents','Documentación del vehículo']].map(Object.freeze));
 const ids=controls.map(([id])=>id),fail=message=>Object.assign(Error(message),{status:400,code:'CHECKLIST_INCOMPLETE'});
 function normalized(items){
  if(!Array.isArray(items)||items.length!==ids.length||ids.some(id=>items.filter(i=>i&&i.id===id&&['ok','fail'].includes(i.result)).length!==1))throw fail('Responde los seis controles del checklist, sin duplicados ni controles desconocidos');
  return ids.map(id=>({id,result:items.find(i=>i.id===id).result}));
 }
 function validate(input={}){
  const status=input.status||'Pendiente';if(!['Pendiente','Aprobado','Rechazado'].includes(status))throw fail('Estado de checklist no válido');
  if(input.observations!=null&&typeof input.observations!=='string')throw fail('Observaciones no válidas');const notes=(input.observations||'').trim();if(notes.length>2000)throw fail('Las observaciones superan el máximo de 2000 caracteres');
  if(status==='Pendiente'){if(input.items!==undefined&&!Array.isArray(input.items))throw fail('Los controles deben ser una lista');return {status,items:input.items||[],observations:notes||null};}
  const items=normalized(input.items),result=items.some(i=>i.result==='fail')?'Rechazado':'Aprobado';if(status!==result)throw fail('El resultado no coincide con las respuestas del checklist');if(result==='Rechazado'&&!notes)throw fail('Describe la falla encontrada');return {status:result,items,observations:notes||null};
 }
 function quality(row){if(!row||row.status==='Pendiente')return {complete:false,code:'pending'};try{validate(row);return {complete:true,code:'complete'};}catch{return {complete:false,code:'incomplete_historical'};}}
 const canRegularize=row=>row?.status==='Aprobado'&&!quality(row).complete;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function summary(row){
  const q=quality(row),date=row.completed_at||row.created_at,dateLabel=date&&Number.isFinite(new Date(date).getTime())?new Date(date).toLocaleString('es-CL'):'No registrada';
  return `<div class="checklist-record"><p><strong>${q.code==='incomplete_historical'?'Registro histórico incompleto · estado registrado: '+esc(row.status):esc(row.status)}</strong></p>${q.code==='incomplete_historical'?'<p role="alert">No acredita una inspección completa. Se conserva el registro original; no se inventan respuestas.</p>':''}<p>Registrado por: ${esc(row.created_by_name||'No registrado en el histórico')}<br>Cerrado por: ${esc(row.completed_by_name||'No registrado en el histórico')}<br>${row.completed_at?'Cierre':'Registro'}: ${esc(dateLabel)}</p><ul>${controls.map(([id,label])=>{const rows=Array.isArray(row.items)?row.items.filter(i=>i&&i.id===id):[],r=rows.length===1?rows[0].result:null;return `<li>${esc(label)}: <strong>${r==='ok'?'Conforme':r==='fail'?'Con falla':'Sin respuesta válida'}</strong></li>`;}).join('')}</ul>${row.observations?'<p>Observaciones: '+esc(row.observations)+'</p>':''}${row.supersedes_id?'<p>Nueva inspección vinculada al registro anterior #'+esc(row.supersedes_id)+'. No lo modifica.</p>':''}</div>`;
 }
 return {controls,ids,normalized,validate,quality,canRegularize,summary};
});
