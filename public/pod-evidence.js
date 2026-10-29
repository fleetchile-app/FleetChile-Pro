(function(){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const same=(id,user,context)=>String(window.currentTripId)===String(id)&&Auth.user===user&&(localStorage.getItem('fleet_company_context')||'')===context;
 async function attach(id){
  const panel=document.getElementById('tripPanelDelivery'),user=Auth.user,context=localStorage.getItem('fleet_company_context')||'';
  if(!panel)return;
  const host=document.createElement('section');host.setAttribute('aria-label','Evidencias privadas de entrega');panel.appendChild(host);
  const load=async()=>{
   host.textContent='Consultando firmas y fotografías…';
   try{
    const data=await Auth.request(`/api/operations/trips/${Number(id)}/pod`);
    if(!same(id,user,context)||!host.isConnected)return;
    const toolbar=panel.querySelector('.toolbar');panel.replaceChildren();if(toolbar)panel.appendChild(toolbar);panel.appendChild(host);
    host.innerHTML=(data.proofs||[]).map(p=>`<article class="card"><h4>${escape(p.cargo||'Entrega')} · ${{CLOSED:'Cerrada',DRAFT:'Borrador',VOID:'Anulada'}[p.status]||'Registro histórico'}</h4><p>${escape(p.recipient_name||'Receptor no informado')} · ${escape(p.recipient_rut||'RUT no informado')}</p><p>${escape(p.notes||'')}</p><div class="toolbar">${(p.files||[]).map(f=>`<button type="button" class="secondary" data-proof="${Number(p.id)}" data-file="${Number(f.id)}">Descargar ${f.type==='signature'?'firma':'fotografía'}</button>`).join('')||'<span>Sin firma ni fotografía almacenada. No se presume evidencia.</span>'}</div><p role="status" data-pod-status></p></article>`).join('')||'<p>No hay entregas registradas.</p>';
    host.querySelectorAll('[data-file]').forEach(button=>button.onclick=async()=>{
     const status=button.closest('article').querySelector('[data-pod-status]');button.disabled=true;status.textContent='Verificando respaldo privado…';
     try{
      const response=await fetch(`/api/operations/trips/${Number(id)}/pod/${button.dataset.proof}/files/${button.dataset.file}`);
      if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||'No se pudo descargar la evidencia');}
      const blob=await response.blob();if(!same(id,user,context)||!host.isConnected)return;
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`pod-${Number(id)}-${button.dataset.file}.${blob.type==='image/png'?'png':'jpg'}`;
      document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);status.textContent='Evidencia verificada y descargada.';
     }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
    });
   }catch(e){if(same(id,user,context)&&host.isConnected){host.textContent=e.message;const retry=document.createElement('button');retry.type='button';retry.className='secondary';retry.textContent='Reintentar consulta';retry.onclick=load;host.appendChild(retry);}}
  };
  await load();
 }
 const previous=window.openTrip;
 window.openTrip=async function(id){const result=await previous.apply(this,arguments);if(String(window.currentTripId)===String(id))await attach(id);return result;};
})();
