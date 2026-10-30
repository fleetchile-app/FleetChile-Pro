(function(){
 'use strict';
 const open=window.openTrip;
 if(!open)return;
 // Keep refresh/save calls in the same view; only entry links open a new tab.
 window.openTrip=async function(id){
  const previousTab=document.querySelector('#drawerBody .trip-tabs button.active')?.textContent;
  const sameTrip=String(window.currentTripId)===String(id);
  const user=Auth.user,context=localStorage.getItem('fleet_company_context')||'';
  const result=await open.apply(this,arguments);
  if(Auth.user!==user||(localStorage.getItem('fleet_company_context')||'')!==context||String(window.currentTripId)!==String(id))return result;
  if(window.linkedTripView&&!window.isLinkedTripCurrent?.())return result;
  const body=document.getElementById('drawerBody'),detail=body?.querySelector('.trip-detail'),trip=window.loadedOperationalTrip;
  if(!detail||!trip||String(trip.id)!==String(id))return result;
  if(window.linkedTripView&&String(trip.company_id)!==new URLSearchParams(location.search).get('company')){
   body.innerHTML='<div class="card" role="alert"><h2>Empresa del viaje no coincidente</h2><p>Abre el viaje desde su empresa autorizada. No se ha cambiado tu contexto.</p><a class="secondary" href="/">Ir a la plataforma</a></div>';window.loadedOperationalTrip=null;return result;
  }
  const head=detail.querySelector('.trip-detail-head');
  if(window.linkedTripView){
   document.title=(trip.trip_number||'Viaje #'+id)+' · FleetChile';
   document.getElementById('title').textContent='Ficha operacional · '+(trip.trip_number||'#'+id);
   const notice=document.createElement('p');notice.className='trip-workspace-note';notice.textContent='Ficha completa del viaje. La pestaña de origen conserva su mapa y filtros.';head?.after(notice);
  }else if(head){
   const actions=document.createElement('div');actions.className='trip-workspace-actions';
   actions.innerHTML=window.tripWorkspaceLink(id,trip.company_id);head.append(actions);
  }
  const tabs=body.querySelector('.trip-tabs');
  tabs?.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&button.parentElement===tabs)body.querySelectorAll('.trip-panel').forEach(panel=>panel.classList.add('hidden'));},true);
  // All extension tabs (itinerary, economics and POD) have now been attached.
  if(sameTrip&&previousTab){const tab=Array.from(body.querySelectorAll('.trip-tabs button')).find(b=>b.textContent===previousTab);tab?.click();}
  return result;
 };
})();
