(function(){
 'use strict';
 const palettes={ocean:['Azul FleetChile','#1265a8'],forest:['Verde bosque','#23634c'],slate:['Azul pizarra','#394d65']};
 const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
 let current=null,identity='',generation=0,pending=null;
 const key=()=>window.Auth?.token?`${window.Auth.token}:${window.Auth.user?.company_id||''}:${localStorage.getItem('fleet_company_context')||''}`:'';
 const initials=name=>String(name||'FC').split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
 const image=b=>b?.logo_url&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(b.logo_url)?b.logo_url:null;
 function mark(el,b){if(!el)return;el.replaceChildren();const logo=image(b);if(logo){const img=document.createElement('img');img.src=logo;img.alt=`Logo de ${b.display_name}`;el.appendChild(img)}else el.textContent=initials(b.display_name);el.title=b.display_name;}
 function paint(){
  if(!current||identity!==key())return;
  document.body.dataset.companyPalette=current.palette;
  const sidebar=document.querySelector('aside .brand');
  if(sidebar){const name=sidebar.querySelector('strong');if(name)name.textContent=current.display_name;mark(sidebar.querySelector('b'),current);}
  const active=document.getElementById('activeCompanyName');if(active)active.textContent=current.display_name;
  mark(document.getElementById('activeCompanyMark'),current);
  const driver=document.querySelector('.driver-brand');if(driver){driver.replaceChildren();const logo=image(current);if(logo){const img=document.createElement('img');img.src=logo;img.alt='Logo de '+current.display_name;driver.appendChild(img)}const name=document.createElement('span');name.textContent=current.display_name+' · Conductor';driver.appendChild(name);}
 }
 function reset(){generation++;current=null;identity='';pending=null;delete document.body.dataset.companyPalette;const sidebar=document.querySelector('aside .brand');if(sidebar){const name=sidebar.querySelector('strong');if(name)name.textContent='FleetChile';const logo=sidebar.querySelector('b');if(logo)logo.textContent='FC';}const mark=document.getElementById('activeCompanyMark');if(mark)mark.textContent='FC';const driver=document.querySelector('.driver-brand');if(driver)driver.textContent='FleetChile · Conductor';}
 async function load({force=false}={}){
  const next=key();if(!next||!window.Auth?.user)return;
  if(next!==identity){reset();identity=next;}
  if(current&&!force){paint();return current;}
  if(pending&&!force)return pending;
  const version=++generation,session=identity;
  const task=(async()=>{try{const b=await Auth.request('/api/company/branding');if(version!==generation||session!==key())return;current=b;paint();return b;}catch{if(version===generation){current=null;delete document.body.dataset.companyPalette;}}finally{if(version===generation)pending=null;}})();
  pending=task;return task;
 }
 async function editor(host,{isCurrent=()=>true}={}){
  const session=key();let active=true,b,selectedLogo;
  const live=()=>active&&session===key()&&host.isConnected&&isCurrent();
  host.innerHTML='<p role="status">Cargando identidad empresarial…</p>';
  try{b=await Auth.request('/api/company/branding');if(!live())return;}catch(e){if(live())host.innerHTML=`<p role="alert">${esc(e.message)}</p>`;return;}
  const field=(name,label,type='text',max=120)=>`<label>${label}<input name="${name}" type="${type}" maxlength="${max}" value="${esc(b[name]||'')}"></label>`;
  host.innerHTML=`<section class="cb-shell"><div class="cb-heading"><h3>Identidad y documentos de ${esc(b.legal_name)}</h3><p>Personaliza la presentación de tu empresa. La razón social, el RUT, la licencia y los permisos no se modifican aquí.</p><p>Versión ${esc(b.version)} · ${b.updated_at?'Actualizada el '+esc(new Date(b.updated_at).toLocaleString('es-CL'))+' por usuario '+esc(b.updated_by):'Apariencia predeterminada'}</p></div><div class="cb-layout"><form class="cb-form">${field('display_name','Nombre comercial visible')}
   <label>Combinación de colores<select name="palette">${Object.entries(palettes).map(([k,v])=>`<option value="${k}" ${b.palette===k?'selected':''}>${v[0]}</option>`).join('')}</select></label>
   <label>Logo de la empresa<input name="logo_file" type="file" accept="image/png,image/jpeg,image/webp"></label><p class="cb-help">PNG, JPEG o WebP; máximo 1 MiB y 16 millones de píxeles. Se procesa como imagen estática sobre fondo blanco.</p><button type="button" data-cb-remove>Quitar logo</button>
   <fieldset><legend>Contacto operativo (no contractual)</legend>${field('contact_name','Persona de contacto')}${field('contact_email','Correo operativo','email',254)}${field('contact_phone','Teléfono operativo','tel',40)}</fieldset>
   <label>Motivo del cambio<textarea name="reason" required minlength="5" maxlength="500"></textarea></label><p data-cb-error role="alert"></p><p data-cb-status role="status"></p><div class="cb-actions"><button type="submit" class="cb-primary">Guardar personalización</button><button type="button" data-cb-reset>Restablecer apariencia</button></div></form>
   <div class="cb-previews"><h4>Previsualización sin guardar</h4><div data-cb-preview></div><p class="cb-help">Vista orientativa de interfaz y documento A4. Los PDF definitivos conservan la identidad de su fecha de emisión.</p></div></div><details class="cb-history"><summary>Historial de cambios</summary><div data-cb-history>Cargando historial…</div></details></section>`;
  const form=host.querySelector('form'),message=host.querySelector('[data-cb-error]'),preview=host.querySelector('[data-cb-preview]');
  let busy=false,reading=0;
  const draft=()=>({display_name:form.elements.display_name.value.trim()||b.legal_name,palette:form.elements.palette.value,contact_name:form.elements.contact_name.value,contact_email:form.elements.contact_email.value,contact_phone:form.elements.contact_phone.value,logo_url:selectedLogo===undefined?b.logo_url:selectedLogo});
  function repaint(){const d=draft(),logo=d.logo_url&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(d.logo_url)?`<img alt="Logo de muestra" src="${d.logo_url}">`:`<b>${esc(initials(d.display_name))}</b>`;preview.innerHTML=`<div class="cb-preview-app" data-palette="${esc(d.palette)}"><div class="cb-preview-side">${logo}<strong>${esc(d.display_name)}</strong><span>FleetChile</span></div><div class="cb-preview-content"><strong>${esc(d.display_name)}</strong><p>Usuario · Rol</p><button type="button" tabindex="-1">Nuevo viaje</button></div></div><article class="cb-preview-paper" data-palette="${esc(d.palette)}"><div class="cb-paper-head"><div><strong>${esc(d.display_name)}</strong><small>${esc(b.legal_name)}<br>RUT: ${esc(b.rut||'No informado')}</small></div>${logo}</div><h4>Ficha operacional de conductor</h4><small>Identificador · Fecha de emisión · Versión</small><h5>Identificación</h5><p>Nombre · RUT · Licencia</p><h5>Historial operacional</h5><p>Viajes y eventos del conductor</p><footer>${esc([d.contact_name,d.contact_email,d.contact_phone].filter(Boolean).join(' · '))}<br>Página 1 de 1</footer></article>`;}
  form.oninput=repaint;
  form.elements.logo_file.onchange=async()=>{const ticket=++reading,file=form.elements.logo_file.files?.[0];if(!file)return;message.textContent='';try{if(file.size>1048576||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Selecciona PNG, JPEG o WebP de máximo 1 MiB');busy=true;const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('No se pudo leer la imagen'));r.readAsDataURL(file)});if(live()&&ticket===reading){selectedLogo=data;repaint();}}catch(e){if(live())message.textContent=e.message;}finally{if(ticket===reading)busy=false;}};
  host.querySelector('[data-cb-remove]').onclick=()=>{reading++;busy=false;selectedLogo=null;form.elements.logo_file.value='';repaint();};
  async function save(reset){if(!live()||busy)return;if(reset&&!confirm('¿Restablecer el nombre, colores, contacto y logo a su configuración predeterminada?'))return;message.textContent='';busy=true;for(const el of form.querySelectorAll('button'))el.disabled=true;try{const d=draft(),payload={expected_version:b.version,reason:form.elements.reason.value};if(reset)payload.reset=true;else{for(const k of ['display_name','palette','contact_name','contact_email','contact_phone'])payload[k]=d[k];if(selectedLogo!==undefined)payload.logo=selectedLogo;}const saved=await Auth.request('/api/company/branding',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!live())return;generation++;pending=null;current=saved;identity=session;paint();active=false;await editor(host,{isCurrent});const notice=host.querySelector('[data-cb-status]');if(notice)notice.textContent='Personalización guardada. Los documentos anteriores conservan su identidad original.';}catch(e){if(live())message.textContent=e.message;}finally{busy=false;if(live())for(const el of form.querySelectorAll('button'))el.disabled=false;}}
  form.onsubmit=e=>{e.preventDefault();save(false);};host.querySelector('[data-cb-reset]').onclick=()=>{if(form.reportValidity())save(true);};
  repaint();
  try{const history=await Auth.request('/api/company/branding/history');if(live())host.querySelector('[data-cb-history]').innerHTML=history.rows.map(r=>`<p><strong>v${esc(r.version)}</strong> · ${esc(new Date(r.created_at).toLocaleString('es-CL'))} · Usuario ${esc(r.created_by)}<br>${esc(r.reason)}</p>`).join('')||'<p>Sin modificaciones registradas.</p>';}catch{if(live())host.querySelector('[data-cb-history]').textContent='No se pudo consultar el historial.';}
 }
 window.CompanyBranding={load,paint,reset,editor};
})();
