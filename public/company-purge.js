(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const base='/api/admin/company-purge',request=(p,b)=>Auth.request(base+p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});
 function manual(input){
  input.autocomplete='off';input.spellcheck=false;input.setAttribute('autocorrect','off');input.setAttribute('autocapitalize','none');input.readOnly=true;
  input.addEventListener('focus',()=>{input.readOnly=false;});
  for(const event of ['paste','drop'])input.addEventListener(event,e=>e.preventDefault());
  let typing=false,typedValue='';
  input.addEventListener('beforeinput',e=>{typing=e.isTrusted&&['insertText','insertCompositionText','deleteContentBackward','deleteContentForward','deleteWordBackward','deleteWordForward'].includes(e.inputType);if(!typing)e.preventDefault();});
  input.addEventListener('input',()=>{if(!typing)input.value='';typedValue=typing?input.value:'';typing=false;});
  return ()=>typedValue.length>0&&typedValue===input.value;
 }
 window.CompanyPurgeUI={allowed:u=>!!(u?.actor_type==='platform'&&u.platform_membership_id&&!u.active_company_context&&(u.ownership_active&&u.ownership_role||u.role_code==='platform_superadmin'&&u.permissions?.includes('platform.companies.manage'))),async render(host,isCurrent=()=>true){
  const data=await request('');if(!isCurrent())return;host.classList.add('company-purge');
  host.innerHTML=`<section class="admin-card"><h3>Eliminación irreversible de empresa</h3><p class="admin-error">Vacía los datos operacionales, comerciales y documentos gestionados y elimina la empresa. No hay deshacer. Se conserva auditoría global. Las cuentas exclusivas se desactivan y anonimizan; las identidades compartidas y ROOT/OWNER se preservan.</p><p>Puede bloquear brevemente escrituras de la plataforma. Realiza esta operación fuera de actividad. No elimina copias de respaldo externas ni garantiza el borrado físico de versiones retenidas por el proveedor de almacenamiento.</p><label>Empresa exacta<select data-purge-company><option value="">Seleccionar empresa</option>${data.companies.map(c=>`<option value="${Number(c.id)}">#${Number(c.id)} · ${esc(c.legal_name)} · ${esc(c.rut||'Sin RUT')}</option>`).join('')}</select></label><button class="secondary" data-prepare>Preparar eliminación</button><div data-confirm></div><p data-result role="status" aria-live="polite"></p></section><section class="admin-card"><h3>Estado de eliminaciones</h3>${data.jobs.map(j=>`<article><b>${esc(j.company_name)} · Empresa #${Number(j.target_company_id)}</b><p>${j.status==='complete'?'Eliminación completada':'Base de datos eliminada; limpieza de archivos pendiente'}</p>${j.status!=='complete'?`<button class="secondary" data-cleanup="${esc(j.id)}">Continuar limpieza de archivos</button>`:''}</article>`).join('')||'<p>Sin eliminaciones registradas.</p>'}</section>`;
  const result=host.querySelector('[data-result]'),select=host.querySelector('[data-purge-company]'),box=host.querySelector('[data-confirm]');
  async function cleanup(job){let state;do{state=await request('/jobs/'+job+'/cleanup',{});if(isCurrent())result.textContent=state.pending?'Limpieza en curso: quedan '+state.pending+' archivos.':'Eliminación completada.';}while(state.pending&&isCurrent());return state;}
  select.onchange=()=>{box.innerHTML='';result.textContent='';};
  host.querySelector('[data-prepare]').onclick=async e=>{
   if(!select.value){result.textContent='Selecciona una empresa';return;}const cid=select.value;e.target.disabled=true;
   try{const c=await request('/'+cid+'/challenge',{});if(!isCurrent()||select.value!==cid)return;
    box.innerHTML=`<h4>Eliminar #${Number(c.company.id)} · ${esc(c.company.legal_name)}</h4><p>Escribe tu contraseña actual y esta frase exactamente. Caduca en 5 minutos; cualquier intento exige una frase nueva.</p><blockquote>${esc(c.phrase)}</blockquote><form autocomplete="off"><label>Contraseña actual, tecleada<input type="password" name="purge-password-${crypto.randomUUID()}" data-password required maxlength="512" autocomplete="off"></label><label>Frase de cinco palabras, tecleada<input data-phrase required maxlength="200" autocomplete="off"></label><label>Motivo<textarea data-reason required minlength="5" maxlength="1000"></textarea></label><label><input type="checkbox" data-ack required> Entiendo que eliminaré esta empresa y sus datos de forma irreversible.</label><button type="submit" class="primary">Vaciar y eliminar esta empresa</button></form>`;
    const form=box.querySelector('form'),password=box.querySelector('[data-password]'),phrase=box.querySelector('[data-phrase]'),passwordTyped=manual(password),phraseTyped=manual(phrase);
    form.onsubmit=async event=>{event.preventDefault();if(!passwordTyped()||!phraseTyped()){result.textContent='Debes teclear la contraseña y la frase; no se admite pegar ni autocompletar.';return;}const button=form.querySelector('[type=submit]');button.disabled=true;select.disabled=true;host.querySelector('[data-prepare]').disabled=true;result.textContent='Vaciando y eliminando la empresa. Espera la confirmación; no repitas la solicitud.';
     try{const payload={challenge_id:c.challenge_id,password:password.value,phrase:phrase.value,reason:box.querySelector('[data-reason]').value};password.value='';phrase.value='';
      const job=await request('/'+cid+'/execute',payload);if(!isCurrent())return;box.innerHTML='';select.disabled=true;result.textContent='Base de datos eliminada. Iniciando limpieza de archivos…';
      await cleanup(job.job_id);if(isCurrent())await window.CompanyPurgeUI.render(host,isCurrent);
     }catch(error){if(isCurrent()){try{await window.CompanyPurgeUI.render(host,isCurrent);}catch{}const message=host.querySelector('[data-result]');if(message)message.textContent=error.message+' Consulta el estado de eliminaciones antes de repetir la operación.';box.innerHTML='';}}finally{password.value='';phrase.value='';}
    };
   }catch(error){if(isCurrent())result.textContent=error.message;}finally{e.target.disabled=false;}
  };
  for(const b of host.querySelectorAll('[data-cleanup]'))b.onclick=async()=>{b.disabled=true;try{await cleanup(b.dataset.cleanup);if(isCurrent())await window.CompanyPurgeUI.render(host,isCurrent);}catch(e){if(isCurrent())result.textContent='Limpieza pendiente: '+e.message;b.disabled=false;}};
 }};
})();
