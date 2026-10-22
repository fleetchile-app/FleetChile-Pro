(function(){
 'use strict';
 const BASE='/api/company/clients',esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={person:'Persona',company:'Empresa',retail:'Minorista',wholesale:'Mayorista',prospect:'Prospecto',customer:'Cliente',recurring:'Recurrente',call:'Llamada',whatsapp:'WhatsApp',email:'Correo',pending:'Pendiente de respaldo',recorded:'Respaldo registrado',revoked:'Revocado',template:'Documento para firma',signed:'Respaldo firmado'};
 const id=v=>/^[1-9]\d*$/.test(String(v))?String(v):null;
 const defaults=()=>({q:'',active:'true',segment:'',relationship:'',privacy_status:'',assigned_person_id:'',sort:'name',direction:'asc',page:1,page_size:25});
 let root,session='',revision=0,filters=defaults(),options={workers:[],communes:[]},list,detail,tab='summary',servicePage=1,busy=false,editing=false;
 const identity=()=>[window.Auth?.token||'',window.Auth?.user?.id||'',window.Auth?.user?.company_id||'',localStorage.getItem('fleet_company_context')||''].join(':');
 const live=v=>v===revision&&session===identity()&&root?.isConnected!==false&&document.getElementById('client-root')===root;
 const date=v=>{const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}-${m[2]}-${m[1]}`:'Sin registro';};
 const timestamp=v=>v?new Date(v).toLocaleString('es-CL'):'Sin registro';
 const button=(action,label,attrs='')=>`<button type="button" class="secondary" data-client-action="${action}" ${attrs}>${esc(label)}</button>`;
 const field=(name,label,value='',type='text',attrs='')=>`<label class="client-field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
 const select=(name,label,rows,value='')=>`<label class="client-field"><span>${esc(label)}</span><select name="${name}">${rows.map(([k,v])=>`<option value="${esc(k)}"${String(value??'')===String(k)?' selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
 const choices=(keys,empty)=>[...(empty?[['',empty]]:[]),...keys.map(k=>[k,labels[k]])];
 const errorBox=()=>'<p class="client-error" data-client-error role="alert" tabindex="-1" hidden></p>';
 const facts=rows=>`<dl class="client-facts">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v||'No informado')}</dd></div>`).join('')}</dl>`;
 const reasonField=()=>field('reason','Motivo del cambio','','text','required maxlength="1000"');
 const companyName=()=>document.getElementById('activeCompanyName')?.textContent||window.Auth?.user?.company_name||'Empresa autorizada';
 function paint(html){if(!live(revision))return;root.innerHTML=`<div class="client-screen">${html}${errorBox()}</div>`;root.querySelector('h2')?.focus();}
 function error(e,form){if(e?.stale||!live(revision))return;const box=form?.querySelector('[data-client-error]')||root.querySelector('[data-client-error]');if(box){box.textContent=e.message||'No se pudo completar la operación';box.hidden=false;box.focus();}}
 async function request(path,opts={},version=revision){
  const response=await fetch(BASE+path,opts);const payload=await response.json().catch(()=>({}));
  if(!live(version))throw Object.assign(Error('Vista reemplazada'),{stale:true});
  if(!response.ok)throw Error(payload.error||'No se pudo completar la operación');return payload;
 }
 const formValues=form=>Object.fromEntries(new FormData(form));
 function normalizeRut(value){return String(value||'').replace(/[.\s-]/g,'').toUpperCase();}
 function validRut(value){const raw=normalizeRut(value);if(!/^\d{1,8}[\dK]$/.test(raw)||!Number(raw.slice(0,-1)))return false;let sum=0,m=2;for(const d of raw.slice(0,-1).split('').reverse()){sum+=Number(d)*m;m=m===7?2:m+1;}const dv=11-sum%11;return raw.slice(-1)===(dv===11?'0':dv===10?'K':String(dv));}
 function formatRut(value){const raw=normalizeRut(value);return /^\d{1,8}[\dK]$/.test(raw)?raw.slice(0,-1).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+'-'+raw.slice(-1):String(value||'');}
 async function loadList(){
  const version=++revision;editing=false;paint('<h2 tabindex="-1">Clientes</h2><p role="status">Cargando clientes…</p>'+button('list','Reintentar'));
  try{list=await request('?'+new URLSearchParams(Object.entries(filters).filter(([,v])=>v!=='')),{},version);if(!Array.isArray(list.rows))throw Error('Lista de clientes inválida');
   const pages=Math.max(1,Math.ceil(list.total/list.page_size));
   paint(`<h2 tabindex="-1">Clientes</h2><p>Empresa: <strong>${esc(companyName())}</strong>. Cada ficha conserva sus servicios y modificaciones.</p><div class="client-actions">${button('new','+ Nuevo cliente')}</div>
    <form data-client-form="filters" class="client-filters">${field('q','Buscar nombre, RUT, código o correo',filters.q)}${select('active','Estado',[['','Todos'],['true','Activos'],['false','Inactivos']],filters.active)}${select('segment','Segmento',choices(['retail','wholesale'],'Todos'),filters.segment)}${select('relationship','Relación',choices(['prospect','customer','recurring'],'Todas'),filters.relationship)}${select('privacy_status','Privacidad (informativo)',choices(['pending','recorded','revoked'],'Todos'),filters.privacy_status)}${select('assigned_person_id','Responsable',[['','Todos'],...options.workers.map(p=>[p.id,p.name])],filters.assigned_person_id)}${select('sort','Ordenar',[['name','Nombre'],['code','Código'],['recent','Última modificación']],filters.sort)}${select('direction','Dirección',[['asc','Ascendente'],['desc','Descendente']],filters.direction)}${select('page_size','Por página',[['25','25'],['50','50'],['100','100']],filters.page_size)}<div class="client-actions"><button class="primary" type="submit">Aplicar filtros</button>${button('clear','Limpiar')}</div></form>
    <p role="status">${Number(list.total)} clientes · Página ${Number(list.page)} de ${pages}</p><div class="client-table-wrap"><table class="client-table"><thead><tr>${['Cliente','Código / RUT','Contacto','Responsable','Relación','Estado / privacidad','Acciones'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${list.rows.map(c=>`<tr><td><strong>${esc(c.name)}</strong><small>${esc(labels[c.identity_type])}</small></td><td>${esc(c.client_code)}<small>${esc(formatRut(c.rut)||'RUT pendiente')}</small></td><td>${esc(c.email||'Sin correo')}<small>${esc(c.mobile||c.phone||'Sin teléfono')}</small></td><td>${esc(c.assigned_person_name||'Sin asignar')}</td><td>${esc(labels[c.relationship]||c.relationship)}<small>${esc(labels[c.segment]||'Sin segmento')}</small></td><td>${c.active?'Activo':'Inactivo'}<small>${esc(labels[c.privacy_status])}</small></td><td>${button('detail','Ver ficha',`data-id="${esc(c.id)}"`)} ${button('edit','Editar',`data-id="${esc(c.id)}"`)}</td></tr>`).join('')||'<tr><td colspan="7">No hay clientes para estos filtros.</td></tr>'}</tbody></table></div><nav class="client-actions" aria-label="Páginas de clientes">${button('previous','Anterior',list.page<=1?'disabled':'')}${button('next','Siguiente',list.page>=pages?'disabled':'')}</nav>`);
  }catch(e){error(e);}
 }
 async function openDetail(clientId,wanted='summary'){
  if(!id(clientId))return;const version=++revision;editing=false;tab=wanted;servicePage=1;
  paint('<h2 tabindex="-1">Ficha de cliente</h2><p role="status">Cargando…</p>'+button('list','Volver'));
  try{detail=await request('/'+id(clientId),{},version);drawDetail();if(tab==='services')await services();}catch(e){error(e);}
 }
 function drawDetail(){
  const c=detail.client;let content='';
  if(tab==='summary')content=facts([['Identidad',labels[c.identity_type]],['Código',c.client_code],['RUT',formatRut(c.rut)],['Contacto',c.contact_name],['Correo',c.email],['Teléfono',c.phone],['Móvil',c.mobile],['Dirección registrada',c.address],['Ciudad',c.city],['Comuna',c.commune],['Región',c.region],['Código postal',c.postal_code],['Sitio web',c.website],['Red social',c.social_url],['Contacto preferido',labels[c.preferred_contact]],['Segmento',labels[c.segment]],['Relación',labels[c.relationship]],['Responsable',c.assigned_person_name],['Sucursal',c.branch_name],['Estado',c.active?'Activo':'Inactivo']]);
  if(tab==='privacy')content=`<p class="client-note">${esc(labels[c.privacy_status])}. Este respaldo es informativo: no bloquea ni invalida la relación comercial, las cargas o los viajes. El sistema registra la declaración; no certifica la firma.</p>
   <p>Descarga el documento para firma y envíalo por tu canal habitual. Después carga el respaldo firmado. No se envían correos ni WhatsApp automáticamente.</p>
   ${(detail.documents||[]).map(d=>`<article class="client-event"><strong>${esc(labels[d.kind])} · ${d.current?'Vigente':'Versión anterior'}</strong><p>${esc(d.filename)} · ${esc(timestamp(d.created_at))} · Registrado por ${esc(d.uploaded_by_name)}</p>${d.kind==='signed'?`<p>Firmante: ${esc(d.signer_name)} · ${esc(d.signer_capacity||'Sin calidad informada')} · ${esc(date(d.signed_on))}</p>`:''}${button('download','Descargar PDF',`data-document="${esc(d.id)}"`)}</article>`).join('')||'<p>No hay documentos registrados.</p>'}
   <form data-client-form="document"><fieldset><legend>Registrar o reemplazar documento</legend><div class="client-grid">${select('kind','Documento',choices(['template','signed']))}<label class="client-field"><span>Archivo PDF (máximo 1 MiB)</span><input name="file" type="file" accept="application/pdf,.pdf" required></label>${field('signer_name','Firmante (obligatorio para respaldo firmado)','','text','maxlength="160"')}${field('signer_capacity','Calidad: titular, representante o apoderado','','text','maxlength="160"')}${field('signed_on','Fecha de firma (respaldo firmado)','','date')}${reasonField()}</div><p>Se conserva la versión anterior. No subas documentos con datos ajenos a este compromiso.</p>${errorBox()}<button class="primary" type="submit">Guardar documento privado</button></fieldset></form>
   ${c.privacy_status==='recorded'?`<form data-client-form="revoke"><fieldset><legend>Registrar revocación</legend><p>No elimina el archivo ni desactiva al cliente. Una nueva autorización firmada se registra como otra versión.</p>${reasonField()}${errorBox()}<button type="submit" class="secondary">Registrar revocación</button></fieldset></form>`:''}`;
  if(tab==='history')content=(detail.events||[]).map(e=>`<article class="client-event"><strong>${esc(e.action)}</strong><p>${esc(timestamp(e.created_at))} · ${esc(e.actor_name)} · ID ${esc(e.actor_user_id)}</p><p>${esc(e.reason||'Sin motivo adicional')}</p><details><summary>Datos anteriores y registrados</summary><h4>Antes</h4><pre>${esc(JSON.stringify(e.before_data,null,2))}</pre><h4>Después</h4><pre>${esc(JSON.stringify(e.after_data,null,2))}</pre></details></article>`).join('')||'<p>No hay cambios registrados desde la incorporación de este módulo.</p>';
  if(tab==='services')content='<div data-client-services role="status">Cargando servicios…</div>';
  paint(`${button('list','← Volver a clientes')}<h2 tabindex="-1">${esc(c.name)}</h2><p>${esc(c.client_code)} · ${esc(formatRut(c.rut))} · ${c.active?'Activo':'Inactivo'}</p><div class="client-actions">${button('edit','Editar ficha',`data-id="${esc(c.id)}"`)}</div><nav class="client-tabs" aria-label="Secciones del cliente">${[['summary','Datos del cliente'],['services','Servicios y viajes'],['privacy','Privacidad y documentos'],['history','Historial de cambios']].map(([k,v])=>button('tab',v,`data-tab="${k}"${tab===k?' aria-current="page"':''}`)).join('')}</nav>${content}`);
 }
 async function services(){
  const version=revision;try{const data=await request('/'+id(detail.client.id)+'/services?page='+servicePage,{},version);const host=root.querySelector('[data-client-services]');if(!host)return;
   host.innerHTML=`<p>Último servicio completado: <strong>${esc(timestamp(data.last_completed_service))}</strong>. ${Number(data.total)} viajes relacionados. Incluye cargas de este cliente en viajes compartidos.</p><div class="client-table-wrap"><table class="client-table"><thead><tr><th>Viaje</th><th>Estado</th><th>Trayecto</th><th>Salida real</th><th>Término real</th></tr></thead><tbody>${(data.rows||[]).map(t=>`<tr><td><a href="${esc('/?'+new URLSearchParams({trip:String(t.id),company:String(detail.client.company_id)}))}" target="_blank" rel="noopener noreferrer">${esc(t.trip_number)}</a></td><td>${esc(t.status)}</td><td>${esc(t.origin)} → ${esc(t.destination)}</td><td>${esc(timestamp(t.actual_departure))}</td><td>${esc(timestamp(t.actual_arrival))}</td></tr>`).join('')||'<tr><td colspan="5">Sin viajes registrados.</td></tr>'}</tbody></table></div><div class="client-actions">${button('service-previous','Anterior',servicePage<=1?'disabled':'')}${button('service-next','Siguiente',servicePage*25>=data.total?'disabled':'')}</div>`;
  }catch(e){error(e);}
 }
 async function editor(clientId){
  const version=++revision;paint('<h2 tabindex="-1">Preparando ficha…</h2>');
  try{const c=clientId?(await request('/'+id(clientId),{},version)).client:{};detail={client:c};editing=true;
   const workers=[['','Sin asignar'],...options.workers.map(p=>[p.id,`${p.name}${p.job_title?' · '+p.job_title:''}`])];
   if(c.assigned_person_id&&!options.workers.some(p=>String(p.id)===String(c.assigned_person_id)))workers.push([c.assigned_person_id,`${c.assigned_person_name||'Responsable anterior'} (asignación histórica)`]);
   paint(`${button('cancel-edit','← Volver sin guardar')}<h2 tabindex="-1">${c.id?'Editar cliente':'Nuevo cliente'}</h2><p>Empresa fija: <strong>${esc(companyName())}</strong>. Solo identificación, nombre y RUT son obligatorios; el código puede generarse automáticamente.</p>
    <form data-client-form="editor"><fieldset><legend>1. Identificación</legend><div class="client-grid">${select('identity_type','Identidad',choices(['company','person']),c.identity_type||'company')}${field('name','Nombre y apellidos / razón social',c.name,'text','required maxlength="200"')}${field('rut','RUT',formatRut(c.rut),'text','required maxlength="14" aria-describedby="client-rut-help"')}${field('client_code','Código (vacío para autogenerar al crear)',c.client_code,'text','maxlength="40"')}</div><p id="client-rut-help">Se verifica el dígito del RUT. No se permiten códigos ni RUT duplicados dentro de esta empresa.</p><p data-rut-error class="client-error" role="alert" hidden></p></fieldset>
    <fieldset><legend>2. Contacto y dirección</legend><div class="client-grid">${field('contact_name','Persona de contacto',c.contact_name,'text','maxlength="160"')}${field('phone','Teléfono principal',c.phone,'tel','maxlength="40"')}${field('mobile','Móvil',c.mobile,'tel','maxlength="40"')}${field('email','Correo electrónico',c.email,'email','maxlength="254"')}${field('street','Calle',c.street,'text','maxlength="200"')}${field('street_number','Número',c.street_number,'text','maxlength="30"')}${field('city','Ciudad',c.city,'text','maxlength="100"')}${select('commune_id','Comuna (catálogo oficial)',[['','Sin seleccionar'],...options.communes.map(x=>[x.id,`${x.name} · ${x.region_name}`])],c.commune_id||'')}${field('postal_code','Código postal',c.postal_code,'text','maxlength="20"')}${field('website','Sitio web (https://…)',c.website,'url','maxlength="500"')}${field('social_url','Red social (https://…)',c.social_url,'url','maxlength="500"')}</div>${c.address&&!c.street?`<p>Dirección anterior conservada hasta completar calle/número: ${esc(c.address)} · ${esc(c.commune||'')} · ${esc(c.region||'')}</p>`:''}</fieldset>
    <fieldset><legend>3. Gestión comercial</legend><div class="client-grid">${select('preferred_contact','Contacto preferido',choices(['call','whatsapp','email'],'Sin preferencia'),c.preferred_contact||'')}${select('segment','Segmento',choices(['retail','wholesale'],'Sin definir'),c.segment||'')}${select('relationship','Relación',choices(['prospect','customer','recurring']),c.relationship||'customer')}${select('assigned_person_id','Responsable (opcional, no conductores)',workers,c.assigned_person_id||'')}${field('branch_name','Sucursal asignada (opcional)',c.branch_name,'text','maxlength="120"')}${select('active','Estado',[['true','Activo'],['false','Inactivo']],String(c.active!==false))}</div><p>Los responsables se obtienen de Personas y accesos de tu empresa. Desactivar no borra el historial.</p></fieldset>
    <fieldset><legend>4. Privacidad</legend><p>El respaldo se gestiona desde la ficha después de guardar. Su ausencia no impide operar.</p></fieldset>${c.id?reasonField():''}${errorBox()}<div class="client-actions"><button type="submit" class="primary">Guardar cliente</button>${button('cancel-edit','Cancelar')}</div></form>`);
  }catch(e){error(e);}
 }
 async function mutate(path,method,payload,form,after){
  if(busy||!live(revision))return;busy=true;const version=revision,submit=form.querySelector('button[type="submit"]');if(submit)submit.disabled=true;
  try{await request(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},version);await after();}catch(e){error(e,form);}finally{busy=false;if(submit)submit.disabled=false;}
 }
 async function submit(event){
  const form=event.target;if(!form.dataset.clientForm)return;event.preventDefault();if(busy)return;
  try{const data=formValues(form),kind=form.dataset.clientForm;
   if(kind==='filters'){Object.assign(filters,data,{page:1});return loadList();}
   if(kind==='editor'){
    if(!validRut(data.rut)){form.querySelector('[name="rut"]').setAttribute('aria-invalid','true');throw Error('RUT incorrecto: revisa el dígito verificador');}
    data.active=data.active==='true';data.rut=formatRut(data.rut);data.assigned_person_id=data.assigned_person_id||null;data.commune_id=data.commune_id||null;
    // Empty structured fields must not erase a legacy free-form address.
    if(!detail.client.street&&!data.street&&!data.street_number){delete data.street;delete data.street_number;}
    if(detail.client.id){if(!data.reason?.trim())throw Error('Indica el motivo de modificación');data.profile_version=detail.client.profile_version;}
    else if(!data.client_code)delete data.client_code;
    const editingId=detail.client.id;return mutate(editingId?'/'+id(editingId):'',editingId?'PATCH':'POST',data,form,()=>loadList());
   }
   if(kind==='revoke'){if(!data.reason?.trim())throw Error('Indica el motivo');return mutate('/'+id(detail.client.id)+'/privacy/revoke','POST',{reason:data.reason},form,()=>openDetail(detail.client.id,'privacy'));}
   if(kind==='document'){
    const file=form.querySelector('[name="file"]').files?.[0];if(!file||file.size>1048576||!file.name.toLowerCase().endsWith('.pdf'))throw Error('Selecciona un PDF de máximo 1 MiB');
    if(!data.reason?.trim())throw Error('Indica el motivo del registro o reemplazo');
    if(data.kind==='signed'&&(!data.signer_name?.trim()||!data.signed_on))throw Error('Indica firmante y fecha de firma');
    const version=revision;busy=true;let content;
    try{content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('No se pudo leer el archivo'));reader.readAsDataURL(file);});}finally{busy=false;}
    if(!live(version))return;delete data.file;const previous=detail.documents.find(d=>d.current&&d.kind===data.kind);
    return mutate('/'+id(detail.client.id)+'/documents','POST',{...data,filename:file.name,content,expected_current_id:previous?.id||null},form,()=>openDetail(detail.client.id,'privacy'));
   }
  }catch(e){error(e,form);}
 }
 async function download(docId){
  const version=revision;const response=await fetch(BASE+'/'+id(detail.client.id)+'/documents/'+id(docId)+'/download');
  if(!live(version))return;if(!response.ok){const d=await response.json().catch(()=>({}));throw Error(d.error||'No se pudo descargar');}
  const blob=await response.blob();if(!live(version))return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`cliente-${detail.client.client_code}-${id(docId)}.pdf`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 async function click(event){
  const target=event.target.closest?.('[data-client-action]');if(!target||!root.contains(target)||target.disabled||busy)return;
  try{const action=target.dataset.clientAction;
   if(action==='reload')return mount();if(action==='list')return loadList();if(action==='clear'){filters=defaults();return loadList();}
   if(action==='previous'||action==='next'){filters.page=Math.max(1,Number(filters.page)+(action==='next'?1:-1));return loadList();}
   if(action==='new')return editor();if(action==='edit')return editor(target.dataset.id);if(action==='detail')return openDetail(target.dataset.id);
   if(action==='cancel-edit'){if(!editing||confirm('¿Descartar los cambios sin guardar?'))return loadList();}
   if(action==='tab'){tab=target.dataset.tab;drawDetail();if(tab==='services')await services();}
   if(action==='service-next'||action==='service-previous'){servicePage=Math.max(1,servicePage+(action==='service-next'?1:-1));return services();}
   if(action==='download')return download(target.dataset.document);
  }catch(e){error(e);}
 }
 function rutEvent(event){const input=event.target;if(input.name!=='rut')return;const raw=input.value,pos=input.selectionStart??raw.length,count=normalizeRut(raw.slice(0,pos)).length,formatted=formatRut(raw);input.value=formatted;let offset=0,seen=0;while(offset<formatted.length&&seen<count){if(/[0-9K]/i.test(formatted[offset]))seen++;offset++;}input.setSelectionRange?.(offset,offset);input.removeAttribute('aria-invalid');}
 async function mount(){
  window.stopControlDashboard?.();window.leaveAdminView?.();const key=identity();if(key!==session){session=key;filters=defaults();options={workers:[],communes:[]};detail=null;}
  const title=document.getElementById('title');if(title)title.textContent='Clientes';
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.v==='clients'));
  const host=document.getElementById('app');host.innerHTML='<div id="client-root"></div>';root=document.getElementById('client-root');revision++;root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',rutEvent);
  root.addEventListener('focusout',event=>{if(event.target.name!=='rut')return;const valid=validRut(event.target.value),box=root.querySelector('[data-rut-error]');if(box){box.hidden=valid;box.textContent=valid?'':'RUT incorrecto: revisa el dígito verificador';}if(!valid)event.target.setAttribute('aria-invalid','true');});
  paint('<h2 tabindex="-1">Clientes</h2><p role="status">Preparando catálogos…</p>'+button('reload','Reintentar'));
  try{options=await request('/options');await loadList();}catch(e){error(e);}
 }
 window.clients=mount;
 window.openClientEditor=async clientId=>{if(!live(revision))await mount();return editor(clientId);};
 const originalOpenForm=window.openForm;window.openForm=function(view){return view==='clients'?window.openClientEditor():originalOpenForm?.(view);};
})();
