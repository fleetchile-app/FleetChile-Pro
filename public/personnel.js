(function(){
  'use strict';
  const base='/api/company/people';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const id=value=>/^[1-9]\d*$/.test(String(value))?String(value):null;
  const date=value=>{const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return match?`${match[3]}-${match[2]}-${match[1]}`:'No informado';};
  const labels={indefinite:'Indefinido',fixed:'Plazo fijo',day:'Por día',event:'Por evento',permission:'Permiso',medical_leave:'Licencia médica',vacation:'Vacaciones',suspended:'Suspendido'};
  const reasonLabels={allowed:'Habilitado',ACCOUNT_DISABLED:'Cuenta bloqueada por plataforma',MEMBERSHIP_DISABLED:'Acceso empresarial desactivado',PERSON_NOT_REGULARIZED:'Ficha pendiente de regularización',MEMBERSHIP_MISSING:'Membership empresarial pendiente',ACCOUNT_MISSING:'Sin cuenta de acceso',CONTRACT_MISSING:'Sin contrato',CONTRACT_NOT_STARTED:'Contrato aún no iniciado',CONTRACT_EXPIRED:'Contrato vencido',CONDITION_ACTIVE:'Condición laboral bloqueante vigente',DRIVER_NOT_ASSOCIATED:'Conductor no asociado',DRIVER_LICENSE_MISSING:'Licencia de conducir pendiente',DRIVER_LICENSE_EXPIRED:'Licencia de conducir vencida',regularization_required:'Regularización pendiente'};
  const statusLabels={...labels,missing:'Sin registro',expired:'Vencida',valid:'Vigente',exempt:'Exención registrada por plataforma'};
  const licenseClasses=['A1','A2','A3','A4','A5','B','C','CR','D','E','F','A1_OLD','A2_OLD'];
  const defaults=()=>({q:'',role:'',condition:'',access:'',contract:'',sort:'name',direction:'asc',page:1,page_size:25});
  let session='',root=null,revision=0,filters=defaults(),data=null,detail=null,tab='person',scene='list',draft=null,step=0,busy=false,readiness=null;
  const sessionKey=()=>[window.Auth?.token||'',window.Auth?.user?.id||'',window.Auth?.user?.company_id||'',window.localStorage?.getItem('fleet_company_context')||''].join(':');
  const companyName=()=>document.getElementById('activeCompanyName')?.textContent||window.Auth?.user?.company_name||'Empresa autorizada';
  const canRead=()=>Boolean(window.Auth?.user?.permissions?.some(permission=>['company.people.read','company.people.manage'].includes(permission))||data?.can_manage);
  const live=(version=revision)=>version===revision&&session===sessionKey()&&root?.isConnected!==false&&document.getElementById('personnel-root')===root;
  const selected=(a,b)=>String(a??'')===String(b??'')?' selected':'';
  const option=(value,label,current)=>`<option value="${esc(value)}"${selected(value,current)}>${esc(label)}</option>`;
  const button=(action,label,extra='')=>`<button type="button" data-action="${action}" ${extra}>${esc(label)}</button>`;
  function field(name,label,value='',type='text',extra=''){
    return `<label class="personnel-field" for="personnel-${name}"><span>${esc(label)}</span><input id="personnel-${name}" name="${name}" type="${type}" value="${esc(value)}" ${name==='rut'?'aria-describedby="personnel-rut-error"':''} ${extra}>${name==='rut'?'<small id="personnel-rut-error" data-rut-error role="status" aria-live="polite" hidden></small>':''}</label>`;
  }
  function selectField(name,label,options,current='',extra=''){
    return `<label class="personnel-field" for="personnel-${name}"><span>${esc(label)}</span><select id="personnel-${name}" name="${name}" ${extra}>${options.map(([value,text])=>option(value,text,current)).join('')}</select></label>`;
  }
  const roleOptions=()=>[['','Seleccionar rol'],...(data?.roles||[]).map(role=>[role.id,role.name||role.role_name||role.code])];
  const roleCode=roleId=>(data?.roles||[]).find(role=>String(role.id)===String(roleId))?.code;
  const errorBox=()=>'<p class="personnel-error" data-error role="alert" tabindex="-1" hidden></p>';
  const actions=submit=>`<div class="personnel-actions"><button type="submit" class="primary">${esc(submit)}</button></div>`;
  const reasonField=()=>field('reason','Motivo (obligatorio)','','text','required maxlength="1000"');
  const facts=rows=>`<dl class="personnel-facts">${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value??'No informado')}</dd></div>`).join('')}</dl>`;
  const historyFields={name:'Nombre',rut:'RUT',birth_date:'Nacimiento',job_title:'Cargo',type:'Tipo',start_date:'Inicio',end_date:'Fin',event_name:'Evento',classes:'Clases de licencia',issued_date:'Emisión',printed_expiry:'Vencimiento impreso',effective_expiry:'Vigencia efectiva',current:'Licencia actual',active:'Activo',membership_active:'Acceso empresarial',account_active:'Cuenta global',role_id:'ID de rol',role_code:'Rol',role_name:'Nombre del rol',driver_id:'ID de conductor',contract_exempt:'Exención',exemption_reason:'Motivo de exención',exemption_by:'Actor de exención',exemption_at:'Fecha de exención',voided_at:'Anulación',cancelled_at:'Cancelación'};
  function historySnapshot(snapshot){
    if(typeof snapshot==='string'){try{snapshot=JSON.parse(snapshot);}catch{return {};}}
    const out={};
    function walk(value,prefix='',depth=0){
      if(!value||typeof value!=='object'||depth>4)return;
      for(const [key,item] of Object.entries(value)){
        if(historyFields[key]){if(item===null||['string','number','boolean'].includes(typeof item)||key==='classes'&&Array.isArray(item))out[prefix+historyFields[key]]=Array.isArray(item)?item.filter(v=>typeof v==='string').join(', '):item;}
        else if(['person','contract','condition','license','contracts','conditions','licenses','voided','replacement'].includes(key)){
          if(Array.isArray(item))item.forEach((row,index)=>walk(row,prefix+(labels[key]||key)+' '+(index+1)+' · ',depth+1));
          else walk(item,prefix+(key==='person'?'Persona':key==='voided'?'Anulado':key==='replacement'?'Reemplazo':key)+' · ',depth+1);
        }
      }
    }
    walk(snapshot);return out;
  }
  function eventChanges(event){
    const before=historySnapshot(event.before_data),after=historySnapshot(event.after_data);
    const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>before[key]!==after[key]);
    const readable=value=>value===true?'Sí':value===false?'No':value??'Sin registro';
    return `<details class="personnel-history"><summary>Ver datos anteriores y actualizados</summary>${keys.length?`<div class="personnel-table-wrap"><table class="personnel-table"><thead><tr><th scope="col">Dato</th><th scope="col">Datos anteriores</th><th scope="col">Datos actualizados</th></tr></thead><tbody>${keys.map(key=>`<tr><th scope="row">${esc(key)}</th><td>${esc(readable(before[key]))}</td><td>${esc(readable(after[key]))}</td></tr>`).join('')}</tbody></table></div>`:'<p>No hay cambios comparables en los campos visibles.</p>'}</details>`;
  }
  function normalizeRut(value){return String(value||'').replace(/[.\s-]/g,'').toUpperCase();}
  function validRut(value){
    const normalized=normalizeRut(value);if(!/^\d{1,8}[\dK]$/.test(normalized)||Number(normalized.slice(0,-1))===0)return false;
    let sum=0,factor=2;for(const digit of normalized.slice(0,-1).split('').reverse()){sum+=Number(digit)*factor;factor=factor===7?2:factor+1;}
    const check=11-sum%11;return normalized.slice(-1)===(check===11?'0':check===10?'K':String(check));
  }
  function formatRut(value){const normalized=normalizeRut(value);return /^\d{1,8}[\dK]$/.test(normalized)?normalized.slice(0,-1).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+'-'+normalized.slice(-1):String(value||'');}
  function showError(error,form){
    if(!live()||error?.stale)return;
    const box=(form||root).querySelector('[data-error]')||root.querySelector('[data-page-error]');
    if(box){box.textContent=error.message||'No se pudo completar la operación.';box.hidden=false;box.focus?.();}
  }
  async function request(url,options={},version=revision){
    const response=await fetch(url,options);let payload;try{payload=await response.json();}catch{payload={};}
    if(!live(version))throw Object.assign(new Error('Vista reemplazada'),{stale:true});
    if(!response.ok)throw new Error(payload.error||`No se pudo completar la consulta (HTTP ${response.status}).`);
    return payload;
  }
  function paint(html,focus=true){
    if(!live())return;root.innerHTML=`<div class="personnel-screen">${html}<p data-page-error class="personnel-error" role="alert" tabindex="-1" hidden></p></div>`;
    if(focus)root.querySelector('[data-heading]')?.focus();
  }
  const heading=title=>`<h2 data-heading tabindex="-1">${esc(title)}</h2>`;
  const banner=()=>data?.policy?.enforced===true?'<p class="personnel-notice">Control laboral activado. El acceso depende de contrato, condiciones y demás restricciones vigentes.</p>':'<p class="personnel-notice">Modo de regularización: los accesos actuales pueden conservar excepciones transitorias. Completa las fichas antes de activar el control laboral.</p>';
  function filterForm(){
    const roles=canRead()?[['','Todos los roles'],...(data.roles||[]).map(role=>[role.code,role.name||role.code])]:[['driver','Conductor']];
    return `<form data-form="filters" class="personnel-filters" aria-label="Buscar y filtrar personas">
      ${field('q',canRead()?'Buscar nombre, RUT o correo':'Buscar nombre',filters.q,'search','maxlength="160"')}
      ${selectField('role','Rol',roles,filters.role)}
      ${canRead()?selectField('condition','Condición laboral',[['','Todas'],['permission','Permiso'],['medical_leave','Licencia médica'],['vacation','Vacaciones'],['suspended','Suspendido']],filters.condition)+selectField('access','Acceso',[['','Todos'],['allowed','Habilitado'],['blocked','Bloqueado']],filters.access)+selectField('contract','Contrato',[['','Todos'],['missing','Sin contrato vigente'],['exempt','Exento por plataforma'],['indefinite','Indefinido'],['fixed','Plazo fijo'],['day','Por día'],['event','Por evento']],filters.contract):''}
      ${selectField('sort','Ordenar por',[['name','Nombre'],['role_code','Rol'],['license','Licencia']],filters.sort)}
      ${selectField('direction','Orden',[['asc','Ascendente'],['desc','Descendente']],filters.direction)}
      ${selectField('page_size','Por página',[['25','25'],['50','50'],['100','100']],filters.page_size)}
      <div class="personnel-actions"><button type="submit" class="primary">Aplicar filtros</button>${button('clear','Limpiar filtros')}</div>
    </form>`;
  }
  function accessLabel(access){
    if(!access)return 'No disponible';const reasons=Array.isArray(access.reasons)?access.reasons:[];
    return (access.allowed?'Habilitado':'Bloqueado')+(reasons.length?' · '+reasons.map(code=>reasonLabels[code]||code).join(', '):'')+(access.regularization_required?' · Regularización pendiente':'');
  }
  function rowMarkup(row,index){
    const restricted=!canRead();
    const association=data.can_accounts&&row.role_code==='driver'&&id(row.user_id)?button('associate-driver',row.driver_id?'Ver asociación':'Asociar conductor',`data-row="${index}"`):'';
    const action=(id(row.id)?button('detail','Ver ficha',`data-id="${esc(row.id)}"`):data.can_manage?button('regularize','Regularizar',`data-row="${index}"`):'Ficha pendiente')+association;
    return `<tr><th scope="row"><strong>${esc(row.name||'Sin nombre')}</strong>${restricted?'':`<small>${esc(formatRut(row.rut)||'RUT pendiente')}</small><small>${esc(row.email||'Sin cuenta')}</small>`}</th>
      <td>${esc(row.role_name||row.role_code||'Sin cuenta')}</td>${restricted?'':`<td>${esc(statusLabels[row.condition_label]||row.condition_label||'Sin condición registrada')}</td><td>${esc(statusLabels[row.contract_label]||row.contract_label||'No informado')}</td><td>${esc(accessLabel(row.access))}</td>`}
      <td>${esc(statusLabels[row.license_label]||row.license_label||'No informada')}</td><td>${action}</td></tr>`;
  }
  function drawList(){
    scene='list';detail=null;draft=null;
    const restricted=!canRead(),total=Number(data.total)||0,page=Number(data.page)||1,size=Number(data.page_size)||25;
    const pages=Math.max(1,Math.ceil(total/size));
    paint(`${heading(restricted?'Licencias de conductores':'Personas y accesos')}<p>Empresa: <strong>${esc(companyName())}</strong>. ${restricted?'Vista limitada a licencias de conductores.':'Rol, cargo, condición laboral, contrato y acceso son datos distintos.'}</p>
      ${restricted?'':banner()}${readiness?`<p role="status">Revisión automática: ${Number.isInteger(readiness.missing)?readiness.missing+' accesos pendientes':readiness.ready?'sin pendientes':'revisa los pendientes'}. La activación requiere confirmación expresa.</p>`:''}<div class="personnel-actions">${data.can_manage?button('new','Nueva persona','class="primary"'):''}${canRead()?button('notifications',`Notificaciones (${Number(data.notifications_unread)||0} sin leer)`):''}${data.can_accounts?button('readiness','Revisar regularización'):''}</div>
      ${filterForm()}<p role="status">${total} personas · Página ${page} de ${pages}</p>
      <div class="personnel-table-wrap" role="region" aria-label="Personas de la empresa" tabindex="0"><table class="personnel-table"><caption>${restricted?'Licencias de conductores':'Personas, contratos y acceso efectivo'}</caption><thead><tr><th scope="col">Persona</th><th scope="col">Rol</th>${restricted?'':'<th scope="col">Condición</th><th scope="col">Contrato</th><th scope="col">Acceso efectivo</th>'}<th scope="col">Licencia</th><th scope="col">Acciones</th></tr></thead><tbody>${data.rows.length?data.rows.map(rowMarkup).join(''):`<tr><td colspan="${restricted?4:7}">No hay personas para estos filtros.</td></tr>`}</tbody></table></div>
      <nav class="personnel-actions" aria-label="Paginación">${button('previous','Anterior',page<=1?'disabled':'')}${button('next','Siguiente',page>=pages?'disabled':'')}</nav>`);
  }
  async function loadList(){
    const version=++revision;scene='list';
    paint(`${heading('Personas y accesos')}<p role="status">Cargando personas…</p>${button('reload','Reintentar')}`);
    try{
      if(!canRead())filters.role='driver';
      const params=new URLSearchParams();for(const [key,value] of Object.entries(filters))if(value!=='')params.set(key,value);
      const payload=await request(base+'?'+params,{},version);
      if(!Array.isArray(payload.rows))throw new Error('La lista de personas no tiene un formato válido.');
      data=payload;readiness=null;
      if(data.can_accounts&&data.policy?.enforced===false){try{readiness=await request(base+'/policy/readiness',{},version);}catch(error){if(error.stale)throw error;data.readiness_error=error.message;}}
      filters.page=Number(payload.page)||filters.page;filters.page_size=Number(payload.page_size)||filters.page_size;drawList();
      if(data.readiness_error)showError(new Error('No se pudo comprobar la regularización: '+data.readiness_error));
    }catch(error){showError(error);}
  }
  function contractFields(values={}){
    return `<fieldset><legend>Contrato</legend><div class="personnel-grid">${selectField('contract_type','Tipo',[['','Sin registrar (solo borrador)'],...Object.entries(labels).filter(([key])=>['indefinite','fixed','day','event'].includes(key))],values.contract_type||'')}${field('contract_start','Inicio',values.contract_start||'','date')}${field('contract_end','Fin (plazo fijo, día o evento)',values.contract_end||'','date')}${field('event_name','Evento (si corresponde)',values.event_name||'')}</div><p>Indefinido no lleva fecha de fin. Los contratos previos se conservan; el servidor valida vigencia y solapamientos.</p></fieldset>`;
  }
  function licenseFields(values={}){
    const classes=Array.isArray(values.classes)?values.classes:[];
    return `<fieldset><legend>Licencia de conducir</legend><p id="personnel-license-help">Selecciona las clases impresas. La vigencia efectiva se calcula y valida en el servidor.</p><div class="personnel-classes" role="group" aria-describedby="personnel-license-help">${licenseClasses.map(value=>`<label><input type="checkbox" name="classes" value="${value}"${classes.includes(value)?' checked':''}> ${value==='A1_OLD'?'A1 antigua':value==='A2_OLD'?'A2 antigua':value}</label>`).join('')}</div><div class="personnel-grid">${field('issued_date','Fecha de emisión (opcional)',values.issued_date||'','date')}${field('printed_expiry','Vencimiento impreso',values.printed_expiry||'','date')}</div></fieldset>`;
  }
  function readForm(form){
    const values=Object.fromEntries(new FormData(form));values.classes=[...new FormData(form).getAll('classes')];return values;
  }
  function contractValue(values){
    if(!values.contract_type)return undefined;
    return {type:values.contract_type,start_date:values.contract_start,end_date:values.contract_type==='indefinite'?null:values.contract_end||null,event_name:values.contract_type==='event'?values.event_name||null:null};
  }
  function licenseValue(values){return {classes:values.classes||[],issued_date:values.issued_date||null,printed_expiry:values.printed_expiry||''};}
  function checkRut(values,form){
    if(values.rut&&!validRut(values.rut)){
      const input=form.querySelector('[name="rut"]');input?.setAttribute('aria-invalid','true');
      throw new Error('RUT inválido: revisa el número y el dígito verificador. No se ha guardado.');
    }
  }
  function checkContract(value){
    if(!value)return;if(!value.start_date)throw new Error('Indica la fecha de inicio del contrato.');
    if(['fixed','day','event'].includes(value.type)&&!value.end_date)throw new Error('Indica la fecha de fin del contrato.');
    if(value.end_date&&value.end_date<value.start_date)throw new Error('El fin del contrato no puede ser anterior al inicio.');
    if(value.type==='day'&&value.end_date!==value.start_date)throw new Error('El contrato por día comienza y termina en la misma fecha.');
    if(value.type==='event'&&!value.event_name)throw new Error('Indica el nombre del evento.');
  }
  function checkLicense(value){if(!value.classes.length||!value.printed_expiry)throw new Error('Selecciona al menos una clase y el vencimiento impreso de la licencia.');}
  function beginWizard(row){
    if(!data?.can_manage)return;
    draft={name:row?.name||'',rut:row?.rut||'',email:row?.email||'',user_id:id(row?.user_id),membership_id:id(row?.membership_id),driver_id:id(row?.driver_id),existing_role:row?.role_code||'',create_account:false,classes:[]};step=0;scene='wizard';drawWizard();
  }
  function drawWizard(){
    const titles=['Persona','Trabajo','Acceso y conducción','Revisar y guardar'];
    let body='';
    if(step===0)body=`<div class="personnel-grid">${field('name','Nombre',draft.name,'text','required maxlength="180" autocomplete="name"')}${field('rut','RUT',formatRut(draft.rut),'text','maxlength="14" aria-describedby="personnel-rut-help"')}${field('birth_date','Fecha de nacimiento',draft.birth_date||'','date')}${field('job_title','Cargo (no concede permisos)',draft.job_title||'')}${field('email','Correo',draft.email,'email','autocomplete="email"')}${field('phone','Teléfono',draft.phone||'','tel','autocomplete="tel"')}</div><p id="personnel-rut-help">Puedes pegar el RUT con o sin puntos y guion. Se comprueba el dígito verificador.</p>`;
    if(step===1)body=contractFields(draft)+'<p>Las condiciones temporales se registran desde la ficha con fechas de inicio y fin. Nunca se registran diagnósticos ni adjuntos médicos.</p>';
    if(step===2){
      const driver=draft.membership_id?draft.existing_role==='driver':draft.create_account&&roleCode(draft.role_id)==='driver';
      body=`${draft.membership_id?'<p>Regularización de un acceso empresarial existente. No se crea otra cuenta ni se cambia su rol.</p>':data.can_accounts?`<label class="personnel-check"><input name="create_account" type="checkbox"${draft.create_account?' checked':''}> Crear cuenta de acceso activa</label>${draft.create_account?`<div class="personnel-grid">${selectField('role_id','Rol de acceso',roleOptions(),draft.role_id||'')}${field('password','Contraseña inicial',draft.password||'','password','autocomplete="new-password" minlength="10"')}</div>`:''}`:'<p>Crearás una ficha sin acceso. La administración de cuentas requiere un permiso independiente.</p>'}${driver?licenseFields(draft):''}<p>Crear una cuenta activa requiere datos completos, contrato vigente y licencia si el rol es conductor. El servidor determina el acceso.</p>`;
    }
    if(step===3){
      const contract=contractValue(draft);
      body=facts([['Nombre',draft.name],['RUT',formatRut(draft.rut)||'Pendiente'],['Nacimiento',date(draft.birth_date)],['Cargo',draft.job_title||'No informado'],['Empresa',window.Auth?.user?.company_name||'Empresa autorizada'],['Cuenta',draft.membership_id?'Regularizar acceso existente':draft.create_account?'Crear cuenta activa':'Borrador sin acceso'],['Contrato',contract?`${labels[contract.type]} · ${date(contract.start_date)} a ${contract.end_date?date(contract.end_date):'sin fin'}`:'Pendiente'],['Licencia',draft.include_license?`${draft.classes.join(', ')} · impresa ${date(draft.printed_expiry)}`:'Sin registrar']])+'<p>Guardar no concede acceso si existen otras restricciones. No se asociará una cuenta global existente por coincidencia de correo.</p>';
    }
    paint(`${heading(draft.membership_id?'Regularizar persona':'Nueva persona')}<p>Empresa fija: ${esc(companyName())}</p>${draft.existing_role==='driver'&&!draft.driver_id?`<p class="personnel-notice">Primero asocia la ficha de conductor existente de esta empresa. No se creará otro conductor al regularizar.</p>${data.can_accounts&&draft.user_id?button('associate-driver','Asociar conductor',`data-user="${draft.user_id}"`):'<p>Solicita la asociación a quien administra las cuentas.</p>'}`:''}<ol class="personnel-steps" aria-label="Pasos del alta">${titles.map((title,index)=>`<li${index===step?' aria-current="step"':''}>${index+1}. ${title}</li>`).join('')}</ol><form data-form="wizard" novalidate><h3>${titles[step]}</h3>${body}<p id="personnel-form-error" data-error class="personnel-error" role="alert" tabindex="-1" hidden></p><div class="personnel-actions">${button('cancel-wizard','Cancelar')}${step?button('back-step','Anterior'):''}<button type="submit" class="primary">${step===3?'Guardar persona':'Continuar'}</button></div></form>`);
  }
  function captureWizard(form){
    if(step===3)return;
    const values=readForm(form);
    if(step===0){checkRut(values,form);if(!values.name?.trim())throw new Error('Indica el nombre de la persona.');}
    if(step===1)checkContract(contractValue(values));
    if(step!==2)delete values.classes;
    Object.assign(draft,values);
    if(step===2){
      if(draft.existing_role==='driver'&&!draft.driver_id)throw new Error('Asocia primero la ficha de conductor existente de esta empresa y vuelve a regularizar.');
      draft.create_account=!draft.membership_id&&data.can_accounts&&values.create_account==='on';
      draft.include_license=draft.membership_id?draft.existing_role==='driver':draft.create_account&&roleCode(draft.role_id)==='driver';
      if(draft.create_account){
        if(!draft.email||!draft.role_id||String(draft.password||'').length<10)throw new Error('Para crear acceso indica correo, rol y una contraseña de al menos 10 caracteres.');
        if(!draft.rut||!validRut(draft.rut)||!draft.birth_date||!draft.contract_type)throw new Error('Completa RUT, nacimiento y contrato antes de crear una cuenta activa.');
      }
      if(draft.include_license)checkLicense(licenseValue(draft));
    }
  }
  function createPayload(){
    const payload={name:draft.name,rut:normalizeRut(draft.rut)||null,birth_date:draft.birth_date||null,job_title:draft.job_title||'',create_account:Boolean(draft.create_account)};
    if(draft.membership_id)payload.membership_id=draft.membership_id;
    if(draft.create_account)Object.assign(payload,{email:draft.email,phone:draft.phone||'',password:draft.password,role_id:draft.role_id});
    if(contractValue(draft))payload.contract=contractValue(draft);
    if(draft.include_license)payload.license=licenseValue(draft);
    return payload;
  }
  async function openDetail(personId,requestedTab='person'){
    if(!id(personId))return;const version=++revision;scene='detail';tab=requestedTab;
    paint(`${heading('Ficha de persona')}<p role="status">Cargando ficha…</p>${button('list','Volver a personas')}`);
    try{detail=await request(base+'/'+encodeURIComponent(personId),{},version);if(!detail.person)throw new Error('La ficha no tiene un formato válido.');drawDetail();}catch(error){showError(error);}
  }
  function drawDetail(){
    const person=detail.person,manage=detail.can_manage===true,driver=person.role_code==='driver',licenses=detail.can_licenses===true&&driver,read=canRead();
    const tabs=read?[['person','Datos personales'],['contracts','Contratos'],['conditions','Condiciones'],...(driver?[['licenses','Licencias']]:[]),['access','Acceso'],['events','Historial']]:[['licenses','Licencias']];
    if(!tabs.some(([key])=>key===tab))tab=tabs[0][0];
    let body='';
    if(tab==='person')body=manage?`<form data-form="person"><div class="personnel-grid">${field('name','Nombre',person.name,'text','required maxlength="180"')}${field('rut','RUT',formatRut(person.rut))}${field('birth_date','Fecha de nacimiento',String(person.birth_date||'').slice(0,10),'date')}${field('job_title','Cargo',person.job_title||'')}</div>${reasonField()}${errorBox()}${actions('Guardar datos')}</form>`:facts([['Nombre',person.name],['RUT',formatRut(person.rut)],['Nacimiento',date(person.birth_date)],['Cargo',person.job_title]]);
    if(tab==='contracts')body=`<p>Se conserva el historial. Añadir un contrato no modifica los anteriores. Solo plataforma puede registrar una exención autorizada para administrador de empresa.</p>${person.contract_exempt?'<p class="personnel-notice">Exención registrada por plataforma. No anula condiciones laborales ni otros bloqueos.</p>':''}${(detail.contracts||[]).map(contract=>facts([['Tipo',labels[contract.type]||contract.type],['Inicio',date(contract.start_date)],['Fin',contract.end_date?date(contract.end_date):'Sin fin'],['Evento',contract.event_name||'—'],['Estado',contract.voided_at?'Anulado':'Registrado']])+ (manage&&!contract.voided_at?button('void-contract','Anular contrato',`data-id="${esc(contract.id)}"`)+button('replace-contract','Reemplazar contrato',`data-id="${esc(contract.id)}"`):'')).join('')||'<p>No hay contratos registrados.</p>'}${manage?`<form data-form="contract"><h3>Añadir contrato</h3>${contractFields()}${reasonField()}${errorBox()}${actions('Registrar contrato')}</form>`:''}`;
    if(tab==='conditions')body=`<p>Permiso, licencia médica, vacaciones y suspensión bloquean el acceso durante sus fechas inclusivas, incluso con contrato vigente. No registres diagnósticos ni adjuntos.</p>${(detail.conditions||[]).map(condition=>`${facts([['Condición',labels[condition.type]||condition.type],['Inicio',date(condition.start_date)],['Fin inclusive',date(condition.end_date)],['Estado',condition.cancelled_at?'Cancelada':'Registrada']])}${manage&&!condition.cancelled_at?button('cancel-condition','Cancelar condición',`data-id="${esc(condition.id)}"`)+button('extend-condition','Prolongar condición',`data-id="${esc(condition.id)}"`):''}`).join('')||'<p>No hay condiciones registradas.</p>'}${manage?`<form data-form="condition"><h3>Registrar condición</h3><div class="personnel-grid">${selectField('type','Condición',[['permission','Permiso'],['medical_leave','Licencia médica'],['vacation','Vacaciones'],['suspended','Suspendido']])}${field('start_date','Inicio','','date','required')}${field('end_date','Fin inclusive','','date','required')}</div>${reasonField()}${errorBox()}${actions('Registrar condición')}</form>`:''}`;
    if(tab==='licenses')body=`${(detail.licenses||[]).map(license=>facts([['Clases',(license.classes||[]).join(', ')],['Emisión',date(license.issued_date)],['Vencimiento impreso',date(license.printed_expiry)],['Vigencia efectiva',date(license.effective_expiry)],['Registro',license.current?'Actual':'Histórico']])).join('')||'<p>No hay licencia registrada.</p>'}${licenses?`<form data-form="license"><h3>Registrar o renovar licencia</h3>${licenseFields()}${reasonField()}${errorBox()}${actions('Guardar licencia')}</form>`:''}`;
    if(tab==='access'){
      const accountEditor=data.can_accounts&&person.membership_id?`<form data-form="access">${selectField('active','Acceso empresarial',[['true','Activar'],['false','Desactivar']],String(person.membership_active??true))}${reasonField()}${errorBox()}${actions('Cambiar acceso empresarial')}</form><form data-form="role">${selectField('role_id','Rol',roleOptions(),person.role_id||'')}${reasonField()}${errorBox()}${actions('Cambiar rol')}</form>`:
        data.can_accounts&&detail.can_manage&&!person.user_id&&!person.membership_id?`<form data-form="draft-account"><h3>Crear cuenta para esta persona</h3><p>Se usará esta misma ficha. Completa sus datos y un contrato vigente antes de crear acceso. Un correo existente no se asociará automáticamente.</p><div class="personnel-grid">${field('email','Correo','','email','required autocomplete="email"')}${field('phone','Teléfono (opcional)','','tel','autocomplete="tel"')}${field('password','Contraseña inicial','','password','required minlength="10" autocomplete="new-password"')}${selectField('role_id','Rol de acceso',roleOptions(),'','required')}</div><div data-account-license></div>${errorBox()}${actions('Crear cuenta de acceso')}</form>`:
        '<p>No tienes permiso para crear o administrar esta cuenta, o la identidad existente requiere revisión de su membership.</p>';
      body=`${facts([['Rol',person.role_name||person.role_code||'Sin cuenta'],['Acceso efectivo',accessLabel(detail.access)]])}<p>Reactivar el acceso empresarial no elimina condiciones, contratos faltantes, licencia vencida ni un bloqueo global.</p>${accountEditor}`;
    }
    if(tab==='events')body=(detail.events||[]).map(event=>`<article class="personnel-event"><h3>${esc(event.action)}</h3>${facts([['Actor',event.actor_name||'No informado'],['Fecha',event.created_at?new Date(event.created_at).toLocaleString('es-CL',{timeZone:'America/Santiago'}):'No informada'],['Motivo',event.reason||'No informado']])}${eventChanges(event)}</article>`).join('')||'<p>No hay eventos registrados.</p>';
    paint(`${button('list','← Volver a personas')}${heading(person.name||'Ficha de persona')}${read?`<p class="personnel-notice">${esc(accessLabel(detail.access))}</p>`:''}<nav class="personnel-tabs" aria-label="Secciones de la ficha">${tabs.map(([key,text])=>button('tab',text,`data-tab="${key}"${tab===key?' aria-current="page"':''}`)).join('')}</nav>${body}`);
  }
  async function notifications(){
    if(!canRead())return;const version=++revision;scene='notifications';
    paint(`${heading('Notificaciones de personas')}${button('list','Volver a personas')}<p role="status">Cargando…</p>`);
    try{const payload=await request(base+'/notifications',{},version),rows=Array.isArray(payload)?payload:payload.rows||[];
      paint(`${heading('Notificaciones de personas')}${button('list','Volver a personas')}${rows.map(notification=>`<article class="personnel-event"><p>${esc(notification.message)}</p><p>${esc(notification.created_at?new Date(notification.created_at).toLocaleString('es-CL',{timeZone:data.policy?.time_zone||'America/Santiago'}):'Fecha no informada')}</p>${id(notification.person_id)?button('detail','Ver ficha',`data-id="${esc(notification.person_id)}"`):''}${!notification.read_at?button('read-notification','Marcar como leída',`data-id="${esc(notification.id)}"`):'<span>Leída</span>'}</article>`).join('')||'<p>No hay notificaciones.</p>'}`);
    }catch(error){showError(error);}
  }
  async function showReadiness(){
    if(!data.can_accounts)return;const version=++revision;scene='readiness';
    paint(`${heading('Regularización del control laboral')}${button('list','Volver a personas')}<p role="status">Verificando fichas…</p>`);
    try{readiness=await request(base+'/policy/readiness',{},version);
      const missing=Array.isArray(readiness.issues)?readiness.issues:[];
      const zero=readiness.ready===true&&readiness.missing===0;
      paint(`${heading('Regularización del control laboral')}${button('list','Volver a personas')}<p>Activar el control aplica las restricciones laborales a los accesos de esta empresa. No crea exenciones locales.</p><p role="status">${zero?'Sin pendientes según la revisión del servidor.':'Hay fichas o datos pendientes. Completa la regularización antes de activar.'}</p>${missing.map(row=>`<article class="personnel-event"><strong>${esc(row.name||'Persona pendiente')}</strong><p>${esc((row.reasons||[]).map(reason=>reasonLabels[reason]||reason).join(', '))}</p>${id(row.person_id)?button('detail','Abrir ficha',`data-id="${esc(row.person_id)}"`):id(row.membership_id)?button('readiness-regularize','Regularizar',`data-membership="${esc(row.membership_id)}" data-name="${esc(row.name)}"`):'<p>Requiere revisión de la membership por administración.</p>'}</article>`).join('')}${zero&&data.policy?.enforced!==true?`<form data-form="activate">${field('password','Confirma tu contraseña','','password','required autocomplete="current-password"')}<label class="personnel-check"><input type="checkbox" name="confirm" required> Confirmo activar el control laboral en esta empresa.</label>${errorBox()}${actions('Activar control laboral')}</form>`:''}`);
    }catch(error){showError(error);}
  }
  async function mutate(url,method,payload,form,after){
    if(busy||!live())return;busy=true;const version=revision,submit=form?.querySelector('button[type="submit"]');
    if(submit)submit.disabled=true;
    try{const response=await request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},version);if(form?.querySelector('[name="password"]'))form.querySelector('[name="password"]').value='';await after(response);}
    catch(error){showError(error,form);}
    finally{busy=false;if(submit)submit.disabled=false;}
  }
  async function submit(event){
    const form=event.target;if(!form.dataset?.form)return;event.preventDefault();if(busy)return;
    try{
      const values=readForm(form),kind=form.dataset.form;
      if(kind==='filters'){
        for(const key of Object.keys(defaults()))if(key!=='page'&&values[key]!==undefined)filters[key]=values[key];
        if(validRut(filters.q)){const rut=normalizeRut(filters.q);filters.q=rut.slice(0,-1)+'-'+rut.slice(-1);}
        filters.page=1;return loadList();
      }
      if(kind==='wizard'){
        captureWizard(form);if(step<3){step++;return drawWizard();}
        const payload=createPayload();return mutate(base,'POST',payload,form,async()=>{draft=null;await loadList();});
      }
      if(!String(values.reason||'').trim()&&!['activate','draft-account'].includes(kind))throw new Error('Indica un motivo para registrar este cambio.');
      const personId=id(detail?.person?.id),endpoint=personId?base+'/'+personId:null;
      if(kind==='draft-account'&&data.can_accounts&&detail.can_manage&&!detail.person.user_id&&!detail.person.membership_id){
        if(!values.email?.trim()||!id(values.role_id)||String(values.password||'').length<10)throw new Error('Indica correo, rol y una contraseña de al menos 10 caracteres.');
        const payload={email:values.email.trim(),phone:values.phone||'',password:values.password,role_id:values.role_id};
        if(roleCode(values.role_id)==='driver'){
          if(!detail.can_licenses)throw new Error('La cuenta de conductor requiere licencia. Solicita a quien tenga permiso para gestionar licencias.');
          payload.license=licenseValue(values);checkLicense(payload.license);
        }
        return mutate(endpoint+'/account','POST',payload,form,()=>openDetail(personId,'access'));
      }
      if(kind==='person'&&detail.can_manage){checkRut(values,form);return mutate(endpoint,'PATCH',{name:values.name,rut:normalizeRut(values.rut)||null,birth_date:values.birth_date||null,job_title:values.job_title,reason:values.reason},form,()=>openDetail(personId,tab));}
      if(kind==='contract'&&detail.can_manage){const contract=contractValue(values);if(!contract)throw new Error('Selecciona un tipo de contrato.');checkContract(contract);return mutate(endpoint+'/contracts','POST',{...contract,reason:values.reason},form,()=>openDetail(personId,tab));}
      if(kind==='condition'&&detail.can_manage){if(!values.start_date||!values.end_date||values.end_date<values.start_date)throw new Error('Indica un período válido con inicio y fin inclusive.');return mutate(endpoint+'/conditions','POST',{type:values.type,start_date:values.start_date,end_date:values.end_date,reason:values.reason},form,()=>openDetail(personId,tab));}
      if(kind==='license'&&detail.can_licenses){const license=licenseValue(values);checkLicense(license);return mutate(endpoint+'/licenses','POST',{...license,reason:values.reason},form,()=>openDetail(personId,'licenses'));}
      if(kind==='access'&&data.can_accounts)return mutate(endpoint+'/access','PATCH',{active:values.active==='true',reason:values.reason},form,()=>openDetail(personId,'access'));
      if(kind==='role'&&data.can_accounts){if(!id(values.role_id))throw new Error('Selecciona un rol.');return mutate(endpoint+'/role','PUT',{role_id:values.role_id,reason:values.reason},form,()=>openDetail(personId,'access'));}
      if(kind==='cancel-condition'&&detail.can_manage)return mutate(endpoint+'/conditions/'+id(form.dataset.id)+'/cancel','POST',{reason:values.reason},form,()=>openDetail(personId,'conditions'));
      if(kind==='extend-condition'&&detail.can_manage){if(!values.end_date)throw new Error('Indica el nuevo fin inclusive.');return mutate(endpoint+'/conditions/'+id(form.dataset.id)+'/extend','POST',{reason:values.reason,end_date:values.end_date},form,()=>openDetail(personId,'conditions'));}
      if(kind==='void-contract'&&detail.can_manage)return mutate(endpoint+'/contracts/'+id(form.dataset.id)+'/void','POST',{reason:values.reason},form,()=>openDetail(personId,'contracts'));
      if(kind==='replace-contract'&&detail.can_manage){const contract=contractValue(values);if(!contract)throw new Error('Selecciona el contrato de reemplazo.');checkContract(contract);return mutate(endpoint+'/contracts/'+id(form.dataset.id)+'/replace','POST',{reason:values.reason,contract},form,()=>openDetail(personId,'contracts'));}
      if(kind==='activate'&&data.can_accounts){if(!values.password||values.confirm!=='on')throw new Error('Confirma la activación e ingresa tu contraseña.');return mutate(base+'/policy/activate','POST',{password:values.password},form,()=>loadList());}
    }catch(error){showError(error,form);}
  }
  async function click(event){
    const target=event.target.closest?.('[data-action]');if(!target||!root.contains(target)||target.disabled||busy)return;
    const action=target.dataset.action;
    try{
      if(action==='reload'||action==='list')return loadList();
      if(action==='clear'){filters=defaults();return loadList();}
      if(action==='previous'||action==='next'){filters.page=Math.max(1,Number(filters.page)+(action==='next'?1:-1));return loadList();}
      if(action==='new')return beginWizard();
      if(action==='regularize')return beginWizard(data.rows[Number(target.dataset.row)]);
      if(action==='associate-driver'&&data.can_accounts){const row=target.dataset.row!==undefined?data.rows[Number(target.dataset.row)]:draft;if(id(row?.user_id))return window.associateUserDriver?.(row.user_id);}
      if(action==='readiness-regularize')return beginWizard(data.rows.find(row=>String(row.membership_id)===String(target.dataset.membership))||{membership_id:target.dataset.membership,name:target.dataset.name});
      if(action==='detail')return openDetail(target.dataset.id);
      if(action==='tab'){tab=target.dataset.tab;return drawDetail();}
      if(action==='cancel-wizard'){if(window.confirm('¿Descartar los datos sin guardar?')){draft=null;return loadList();}return;}
      if(action==='back-step'){
        if(step<3){const values=readForm(root.querySelector('[data-form="wizard"]'));if(step!==2)delete values.classes;
          if(step===2){values.create_account=values.create_account==='on';values.include_license=values.include_license==='on';}
          Object.assign(draft,values);}
        step=Math.max(0,step-1);return drawWizard();
      }
      if(action==='notifications')return notifications();
      if(action==='readiness')return showReadiness();
      if(action==='read-notification'&&canRead()&&id(target.dataset.id))return mutate(base+'/notifications/'+id(target.dataset.id)+'/read','POST',{},null,()=>notifications());
      if(action==='cancel-condition'&&detail.can_manage&&id(target.dataset.id)){
        const container=document.createElement('form');container.dataset.form='cancel-condition';container.dataset.id=target.dataset.id;
        container.innerHTML=`<h3>Cancelar condición</h3><p>Se conserva el historial. La cancelación no elimina otros bloqueos.</p>${reasonField()}${errorBox()}${actions('Confirmar cancelación')}`;target.replaceWith(container);container.querySelector('input')?.focus();
      }
      if(['extend-condition','void-contract','replace-contract'].includes(action)&&detail.can_manage&&id(target.dataset.id)){
        const container=document.createElement('form');container.dataset.form=action;container.dataset.id=target.dataset.id;
        container.innerHTML=`<h3>${action==='extend-condition'?'Prolongar condición':action==='replace-contract'?'Reemplazar contrato':'Anular contrato'}</h3><p>Se conservará el historial. El servidor comprobará los efectos sobre el acceso.</p>${action==='extend-condition'?field('end_date','Nuevo fin inclusive','','date','required'):action==='replace-contract'?contractFields():''}${reasonField()}${errorBox()}${actions('Confirmar cambio')}`;target.replaceWith(container);container.querySelector('input')?.focus();
      }
    }catch(error){showError(error);}
  }
  async function renderCompanyPeople(options={}){
    window.stopControlDashboard?.();
    const key=sessionKey();if(key!==session){session=key;filters=defaults();draft=null;data=null;detail=null;}
    const host=(!options.standalone&&document.getElementById('admin-panel'))||document.getElementById('app');if(!host)return;
    host.innerHTML='<div id="personnel-root"></div>';root=document.getElementById('personnel-root');
    root.addEventListener('click',click);root.addEventListener('submit',submit);
    root.addEventListener('change',event=>{
      const form=event.target.closest?.('form');
      if(form?.dataset.form==='draft-account'&&event.target.name==='role_id'){
        const license=form.querySelector('[data-account-license]');
        const driver=roleCode(event.target.value||readForm(form).role_id)==='driver';
        if(license)license.innerHTML=driver?(detail.can_licenses?licenseFields():'<p role="alert">Crear una cuenta de conductor requiere permiso de gestión de licencias.</p>'):'';
        return;
      }
      if(scene!=='wizard'||step!==2||!['create_account','role_id'].includes(event.target.name))return;
      const values=readForm(event.target.closest('form'));Object.assign(draft,values);draft.create_account=values.create_account==='on';
      if(!draft.create_account)draft.password='';drawWizard();root.querySelector(`[name="${event.target.name}"]`)?.focus();
    });
    root.addEventListener('input',event=>{
      const input=event.target;if(input.name!=='rut')return;
      const before=String(input.value||''),cursor=input.selectionStart??before.length;
      const count=normalizeRut(before.slice(0,cursor)).length,formatted=formatRut(before);
      if(formatted!==before){input.value=formatted;let seen=0,position=0;while(position<formatted.length&&seen<count){if(/[0-9K]/i.test(formatted[position]))seen++;position++;}input.setSelectionRange?.(position,position);}
      input.removeAttribute('aria-invalid');const error=root.querySelector('[data-rut-error]');if(error)error.hidden=true;
    });
    root.addEventListener('focusout',event=>{
      const input=event.target;if(input.name!=='rut')return;
      const error=root.querySelector('[data-rut-error]');
      if(!input.value||validRut(input.value)){input.value=formatRut(input.value);input.removeAttribute('aria-invalid');if(error)error.hidden=true;}
      else{input.setAttribute('aria-invalid','true');if(error){error.textContent='RUT inválido: revisa el número y el dígito verificador.';error.hidden=false;}}
    });
    return loadList();
  }
  window.renderCompanyPeople=renderCompanyPeople;
  window.companyPeople=()=>{
    window.leaveAdminView?.();document.querySelectorAll('#nav button').forEach(button=>button.classList.toggle('active',button.dataset.v==='companyPeople'));
    window.adminSurface='company';
    const title=document.getElementById('title');if(title){title.textContent='Personas y accesos';title.focus?.();}
    return renderCompanyPeople({standalone:true});
  };
  window.renewPersonnelLicenseForDriver=async driverId=>{
    if(!id(driverId))return;await window.companyPeople();if(!live()||!data?.can_licenses)return;
    const version=++revision;
    try{const payload=await request(base+'?driver_id='+encodeURIComponent(driverId)+'&page_size=25',{},version);
      const row=payload.rows?.find(person=>String(person.driver_id)===String(driverId));
      if(id(row?.id))return openDetail(row.id,'licenses');
      throw new Error('El conductor necesita una ficha de persona en esta empresa antes de renovar. Solicita su regularización.');
    }catch(error){showError(error);}
  };
})();
