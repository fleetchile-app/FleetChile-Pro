(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const id=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
 function complianceNote(c){return c?.denominator?`${Number(c.completed)}/${Number(c.denominator)} viajes no cancelados · selección actual`:'Sin viajes no cancelados en la selección';}
 function distanceNote(kpis,state){
  const c=kpis?.coverage?.[state];if(!c)return 'distancia oficial planificada';
  if(!c.eligible_trips)return state==='reconciled'?'Sin viajes conciliados':'Sin viajes provisionales';
  if(!c.with_distance)return 'Falta distancia disponible en estos viajes';
  return `${Number(c.with_distance)}/${Number(c.eligible_trips)} viajes con distancia planificada`;
 }
 function missingDetails(e,companyId){
  const count=Number(e?.delta?.missing_data_trips||0);if(!count)return '';
  const labels={revenue_unconfirmed:'Valor del servicio sin confirmar',costs_unrecognized:'Sin costos reconocidos'};
  const rows=(e.missing_trips||[]).map(t=>`<tr><td>${id(t.trip_id)&&id(companyId)?`<a href="/?trip=${Number(t.trip_id)}&amp;company=${Number(companyId)}" target="_blank" rel="noopener noreferrer">${esc(t.trip_number)}</a>`:esc(t.trip_number)}</td><td>${esc(t.status)}</td><td>${(t.reasons||[]).map(r=>esc(labels[r]||'Revisar información económica')).join(' · ')}</td></tr>`).join('');
  return `<section class="card" id="kpiMissingTrips" style="margin-top:15px;scroll-margin-top:100px"><h3>Viajes con datos económicos pendientes</h3><p>Completar la operación no confirma automáticamente el valor del servicio ni sus costos. Corresponde a los filtros actuales.</p><p>${count} viaje(s) pendiente(s). Se muestran hasta ${Number(e.missing_details_limit||100)}.</p><div class="wrap"><table class="table"><thead><tr><th>Viaje</th><th>Estado operacional</th><th>Qué falta revisar</th></tr></thead><tbody>${rows||'<tr><td colspan="3">Detalle no disponible. Actualiza los indicadores.</td></tr>'}</tbody></table></div></section>`;
 }
 const api={complianceNote,distanceNote,missingDetails};if(typeof module==='object'&&module.exports)module.exports=api;else root.FleetExecutiveKpis=api;
})(typeof window==='object'?window:globalThis);
