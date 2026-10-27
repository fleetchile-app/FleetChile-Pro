(function(){
  const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 2.1 3-.3.9 2.9 2.6 1.5-1.1 2.8 1.1 2.8-2.6 1.5-.9 2.9-3-.3L12 21l-2.2-2.1-3 .3-.9-2.9-2.6-1.5 1.1-2.8-1.1-2.8 2.6-1.5.9-2.9 3 .3L12 3z"/><circle cx="12" cy="12" r="3"/></svg>';
  const nav=document.getElementById('nav');
  const btn=document.createElement('button');btn.className='admin-nav-item';btn.dataset.v='configuration';btn.hidden=true;btn.setAttribute('aria-label','Administración de mi empresa');btn.innerHTML=icon+'<span>Mi empresa</span>';nav.appendChild(btn);
  btn.onclick=()=>window.configuration&&window.configuration();
  const peopleBtn=document.createElement('button');peopleBtn.dataset.v='companyPeople';peopleBtn.hidden=true;peopleBtn.setAttribute('aria-label','Personas y accesos');peopleBtn.innerHTML='<i aria-hidden="true">'+icon+'</i><span>Personas y accesos</span>';nav.appendChild(peopleBtn);
  peopleBtn.onclick=()=>window.companyPeople?.();

  const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  let adminIdentity=null,adminRevision=0,activeAdmin=null,companyProfile=null,peopleEntrySession='',supportSwitchBusy=false;
  const positiveId=value=>/^[1-9]\d*$/.test(String(value))?String(value):null;
  const platformSupport=u=>Boolean(u?.actor_type==='platform'&&positiveId(u.platform_membership_id)&&
    (u.permissions?.includes('platform.users.manage')||(u.ownership_role&&u.ownership_active===true)));
  const owner=u=>Boolean(u?.actor_type==='platform'&&u.ownership_role&&u.ownership_active!==false);
  const legacy=u=>Boolean(u?.actor_type==='legacy'&&u.role_code==='admin');
  const companyAdmin=u=>Boolean((u?.actor_type==='company'&&u.membership_id&&u.permissions?.includes('company.users.manage'))||legacy(u));
  function platformItems(u=adminIdentity){
    if(u?.actor_type!=='platform')return [];
    const general=['platform.companies.manage','platform.users.manage'].some(permission=>u.permissions?.includes(permission));
    const companies=owner(u)||u.permissions?.includes('platform.companies.manage');
    const users=owner(u)||u.permissions?.includes('platform.users.manage');
    return [['overview','Resumen global',general],['organization','Empresas y licencias',companies],['commercial-plans','Planes comerciales',companies],['users','Usuarios',users],['roles','Roles y permisos',users&&general],['owners','Propietarios',owner(u)],['settings','Configuración global',general],['audit','Auditoría',general]].filter(item=>item[2]).map(([key,label])=>[key,label]);
  }
  const get=async u=>{const revision=adminRevision;if(window.adminSurface==='company'&&u==='companies')return [];const r=await fetch('/api/'+u);const d=await r.json();if(revision!==adminRevision)throw Object.assign(Error('Vista reemplazada'),{stale:true});if(!r.ok)throw Error(d.error||'No se pudo cargar');if(window.adminSurface==='company'&&u==='roles')return d.filter(x=>['company_admin','manager','operations','maintenance','driver','viewer'].includes(x.code));return d};
  const patch=async(u,o)=>{const r=await fetch('/api/'+u,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});const d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo guardar');return d};
  const put=async(u,o)=>{const r=await fetch('/api/'+u,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});const d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo guardar');return d};

  function applyBranding(name){
    const clean=String(name||'FleetChile').trim()||'FleetChile';
    document.querySelectorAll('.brand strong').forEach(el=>el.textContent=clean);
    document.title=clean+' Pro';
  }
  async function loadPublicBranding(){
    try{const s=await get('public/settings');const raw=s['appearance.company_name'];const name=typeof raw==='string'?raw.replace(/^"|"$/g,''):raw;applyBranding(name)}catch(e){/* la aplicación conserva el nombre por defecto */}
  }
  loadPublicBranding();

  window.togglePlatformAdminMenu=function(open){
    const links=document.getElementById('platformAdminLinks'),toggle=document.getElementById('platformAdminToggle');
    if(!links||!toggle)return;
    links.hidden=typeof open==='boolean'?!open:!links.hidden;
    toggle.setAttribute('aria-expanded',String(!links.hidden));
  };
  window.renderAdminNavigation=function(user){
    if(String(user?.id||'')!==String(adminIdentity?.id||'')||String(user?.company_id||'')!==String(adminIdentity?.company_id||''))companyProfile=null;
    adminIdentity=user||null;btn.hidden=!companyAdmin(user);
    const companyActor=user?.actor_type==='company'&&user.membership_id;
    const selectedCompany=typeof localStorage!=='undefined'?localStorage.getItem('fleet_company_context'):user?.active_company_context;
    const contextualPlatform=user?.actor_type==='platform'&&positiveId(selectedCompany);
    const peopleAllowed=['company.people.read','company.people.manage','company.licenses.manage'].some(code=>user?.permissions?.includes(code));
    const support=contextualPlatform&&platformSupport(user);
    peopleBtn.hidden=!((companyActor&&peopleAllowed)||support);
    peopleBtn.setAttribute('aria-label',support?'Soporte plataforma: Personas y accesos de la empresa seleccionada':'Personas y accesos');
    peopleBtn.innerHTML='<i aria-hidden="true">'+icon+'</i><span>'+(support?'Personas y accesos · Soporte':'Personas y accesos')+'</span>';
    const entryKey=user?[user.id,user.company_id,window.Auth?.token||''].join(':'):'';
    if(!user)peopleEntrySession='';
    if(entryKey&&entryKey!==peopleEntrySession){
      peopleEntrySession=entryKey;
      if(user.role_code==='administrative'&&!user.permissions?.includes('dashboard.read')&&!peopleBtn.hidden){
        Promise.resolve().then(()=>{
          const selected=document.querySelector?.('#nav button.active');
          if(!activeAdmin&&selected?.dataset.v==='dashboard'&&entryKey===[adminIdentity?.id,adminIdentity?.company_id,window.Auth?.token||''].join(':'))return window.companyPeople?.();
        }).catch(()=>{});
      }
    }
    const host=document.getElementById('platformAdminMenuHost'),items=platformItems(user);
    if(!host)return;
    host.hidden=!items.length;
    host.innerHTML=items.length?`<button id="platformAdminToggle" type="button" class="platform-admin-toggle ${activeAdmin?.surface==='platform'?'active':''}" aria-expanded="false" aria-controls="platformAdminLinks" onclick="togglePlatformAdminMenu()">${icon}<span>Plataforma</span><span aria-hidden="true">▾</span></button><nav id="platformAdminLinks" class="platform-admin-links" aria-label="Administración de plataforma" hidden><p>ADMINISTRACIÓN DE PLATAFORMA</p>${items.map(([key,label])=>`<button type="button" ${activeAdmin?.surface==='platform'&&activeAdmin.tab===key?'aria-current="page"':''} onclick="platformAdministration('${key}')">${label}</button>`).join('')}</nav>`:'';
  };
  window.leaveAdminView=function(){adminRevision++;activeAdmin=null;window.renderAdminNavigation(adminIdentity)};
  if(document.addEventListener){
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.getElementById('platformAdminLinks')?.hidden===false){window.togglePlatformAdminMenu(false);document.getElementById('platformAdminToggle')?.focus()}});
    document.addEventListener('click',event=>{const host=document.getElementById('platformAdminMenuHost');if(host&&!host.contains(event.target))window.togglePlatformAdminMenu(false)});
  }
  function itemsForSurface(){return window.adminSurface==='platform'?platformItems():companyAdmin(adminIdentity)?[['overview','Resumen'],['users','Usuarios'],['company-profile','Datos y licencia'],['commercial','Capacidad y servicios']]:[]}
  const companyLabel=()=>companyProfile?.company.legal_name||'Empresa autorizada';
  function paintCompanyHeading(){
    if(activeAdmin?.surface!=='company')return;
    const tab=itemsForSurface().find(([key])=>key===activeAdmin.tab);
    const title=document.getElementById('title'),heading=document.getElementById('companyAdminHeading');
    if(title)title.textContent=companyLabel()+(activeAdmin.tab==='overview'?'':' · '+(tab?.[1]||''));
    if(heading)heading.textContent=companyLabel();
  }
  async function loadCompanyProfile(){
    const data=await get('company/profile');
    if(!data?.company?.legal_name||String(data.company.id)!==String(adminIdentity?.company_id)||!data.license||!data.usage)throw Error('No se pudo verificar la empresa y su licencia');
    companyProfile=data;paintCompanyHeading();return data;
  }
  async function enterAdmin(surface,tab){
    window.stopControlDashboard?.();window.leaveAdminView();
    const revision=adminRevision;
    document.querySelectorAll('#nav button').forEach(b=>b.classList.remove('active'));
    document.getElementById('title').textContent=surface==='platform'?'Plataforma':'Mi empresa';
    document.getElementById('app').innerHTML='<div class="admin-loading" role="status">Verificando acceso administrativo…</div>';
    try{
      const me=await get('auth/me'),u=me.user;
      if(revision!==adminRevision)return;
      window.renderAdminNavigation(u);
      if(surface==='platform'?!platformItems(u).length:!companyAdmin(u))throw Error('Esta sección requiere permisos de administración del alcance seleccionado');
      window.adminSurface=surface;
      window.adminOwner=Boolean(u.actor_type==='platform'&&u.ownership_role&&u.ownership_active!==false);
      await window.adminTab(tab||itemsForSurface()[0][0]);
    }catch(error){if(revision===adminRevision){document.getElementById('title').textContent='Acceso restringido';document.getElementById('app').innerHTML=`<div class="card admin-denied"><h2>Acceso restringido</h2><p>${esc(error.message)}</p></div>`}}
  }
  window.configuration=()=>enterAdmin('company','overview');
  window.platformAdministration=tab=>enterAdmin('platform',tab);
  window.openCommercialCompany=companyId=>{const revision=adminRevision;return window.CommercialUI.company(document.getElementById('admin-panel'),{platform:true,companyId,isCurrent:()=>revision===adminRevision});};
  window.adminTab=async function(tab){
    const items=itemsForSurface(),selected=items.find(([key])=>key===tab),A=document.getElementById('app');
    if(!selected){window.leaveAdminView();document.getElementById('title').textContent='Acceso restringido';A.innerHTML='<div class="card admin-denied"><h2>Acceso restringido</h2><p>Esta sección no está disponible para tu identidad y alcance.</p></div>';return}
    const revision=++adminRevision,platform=window.adminSurface==='platform';
    activeAdmin={surface:window.adminSurface,tab};window.renderAdminNavigation(adminIdentity);
    document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',!platform&&b===btn));
    const title=document.getElementById('title');title.textContent=platform?'Plataforma · '+selected[1]:companyLabel()+(tab==='overview'?'':' · '+selected[1]);
    const available=`<nav class="admin-tabs" aria-label="${platform?'Secciones de plataforma':'Administración de mi empresa'}">${items.map(([key,label])=>`<button class="${tab===key?'active':''}" ${tab===key?'aria-current="page"':''} onclick="adminTab('${key}')">${label}</button>`).join('')}</nav>`;
    A.innerHTML=`<div class="admin-shell"><div class="admin-head"><div><small>${platform?'ADMINISTRACIÓN DE PLATAFORMA':'ADMINISTRACIÓN DE EMPRESA'}</small><h2 ${platform?'':'id="companyAdminHeading"'}>${platform?'Administración de Plataforma':esc(companyLabel())}</h2><p>${platform?'Alcance global: estas opciones administran la plataforma, no solo la empresa seleccionada.':'Administración de la empresa autorizada. Los datos contractuales se consultan en Datos y licencia.'}</p></div></div>${available}<div id="admin-panel"><div class="admin-loading" role="status">Cargando...</div></div></div>`;
    title.focus?.({preventScroll:true});
    try{const views={overview,organization,users,roles,owners,settings,audit,'commercial-plans':()=>window.CommercialUI.plans(document.getElementById('admin-panel'),()=>revision===adminRevision),'commercial':()=>window.CommercialUI.company(document.getElementById('admin-panel'),{isCurrent:()=>revision===adminRevision}),'company-profile':companyProfileView};await views[tab]()}catch(error){if(revision===adminRevision){const panel=document.getElementById('admin-panel');if(panel)panel.innerHTML=`<div class="admin-error" role="alert">${esc(error.message)}<br><button class="secondary" onclick="adminTab('${tab}')">Reintentar</button></div>`}}
  };
  window.renderAdminNavigation(window.Auth?.user);
  async function overview(){
    if(window.adminSurface!=='platform'){
      const revision=adminRevision;
      const [profile,summary]=await Promise.all([loadCompanyProfile(),get('core/summary').then(data=>({data}),error=>({error}))]);
      if(revision!==adminRevision)return;
      document.getElementById('admin-panel').innerHTML=`<div class="admin-kpis"><div><small>Usuarios activos en esta empresa</small><b>${profileValue(profile.usage.active_users)}</b></div><div><small>Clientes</small><b>${profileValue(summary.data?.clients)}</b></div><div><small>Viajes activos</small><b>${profileValue(summary.data?.active_trips)}</b></div></div>${summary.error?`<p class="admin-note" role="status">Resumen operativo no disponible: ${esc(summary.error.message)}. Los datos no disponibles se muestran como N/D.</p>`:''}<section class="admin-card"><h3>${esc(companyLabel())}</h3><p>${profileValue(profile.usage.registered_users)} usuarios vinculados a esta empresa. Plan registrado: ${profileValue(profile.license.plan_code)}.</p><button class="admin-link" onclick="adminTab('users')">Gestionar usuarios →</button><br><button class="admin-link" onclick="adminTab('company-profile')">Consultar datos de empresa y licencia →</button></section>`;
      return;
    }
    const s=await get('admin/platform-summary'),allowed=new Set(platformItems().map(([key])=>key));
    document.getElementById('admin-panel').innerHTML=`<div class="admin-kpis"><div><small>Empresas activas</small><b>${s.companies.active}/${s.companies.total}</b></div><div><small>Usuarios activos</small><b>${s.users.active}/${s.users.total}</b></div><div><small>Memberships empresa</small><b>${s.company_memberships.active}</b></div><div><small>Memberships plataforma</small><b>${s.platform_memberships.active}</b></div><div><small>Auditoría · 30 días</small><b>${s.recent_audit_30d}</b></div></div><div class="admin-grid">${allowed.has('organization')?`<section class="admin-card"><h3>Empresas y licencias</h3><p>${s.companies.total} empresas registradas · ${s.companies.inactive} inactivas. Plan, vigencia, límites y módulos por empresa.</p><button class="admin-link" onclick="adminTab('organization')">Administrar empresas y licencias →</button></section>`:''}${allowed.has('users')?`<section class="admin-card"><h3>Identidad y acceso</h3><p>${s.users.total} usuarios y ${s.platform_memberships.total} membresías de plataforma.</p><button class="admin-link" onclick="adminTab('users')">Administrar usuarios →</button></section>`:''}<section class="admin-card"><h3>Actividad gobernada</h3><p>${s.recent_audit_30d} eventos de auditoría en los últimos 30 días.</p><button class="admin-link" onclick="adminTab('audit')">Ver auditoría →</button></section></div>`;
  }
  function profileValue(value){return value===null||value===undefined||value===''?'N/D':esc(value)}
  function profileDate(value){
    if(!value)return 'No registrado';
    const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match?`${match[3]}-${match[2]}-${match[1]}`:'Fecha no válida';
  }
  function profileFacts(fields){return `<dl class="company-facts">${fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${profileValue(value)}</dd></div>`).join('')}</dl>`}
  async function companyProfileView(){
    const {company:c,license:l,usage:u}=await loadCompanyProfile();
    const statuses={active:'Activa',trial:'Prueba',suspended:'Suspendida',expired:'Vencida',scheduled:'Período pagado de inicio futuro',unconfigured:'Sin período pagado'};
    const modules=l.capabilities&&typeof l.capabilities==='object'&&!Array.isArray(l.capabilities)?Object.entries(l.capabilities):[];
    const moduleLabels={fleet:'Flota',drivers:'Conductores',fuel:'Combustible',routes:'Rutas',loads:'Cargas',gps:'GPS',pod:'Entregas / POD',reports:'Reportes',operations:'Operaciones',maintenance:'Mantenimiento',economics:'Gestión económica'};
    document.getElementById('admin-panel').innerHTML=`<section class="admin-card"><h3>Datos de la empresa titular</h3><p>Información registrada por plataforma. Estos datos identifican a la empresa a la que está asignada la licencia y son de solo lectura.</p>${profileFacts([['Razón social',c.legal_name],['RUT',c.rut],['Nombre comercial',c.trade_name],['Correo registrado',c.email],['Teléfono',c.phone],['Dirección',c.address],['Comuna',c.commune],['Región',c.region],['Estado de empresa',c.active===true?'Activa':c.active===false?'Inactiva':null]])}</section><section class="admin-card"><h3>Licencia y capacidad registrada</h3><p>No modifica el contrato ni amplía los límites. Los datos mostrados provienen del registro de plataforma; no sustituyen el documento contractual. Si hay control comercial, el máximo del plan no equivale a los cupos contratados. Consulta Capacidad y servicios para sus detalles.</p>${profileFacts([['Plan registrado',l.plan_code],['Estado de licencia',statuses[l.status]||l.status],['Inicio registrado',profileDate(l.started_at)],['Vencimiento registrado',profileDate(l.expires_at)],['Límite de usuarios',l.user_limit],['Usuarios con acceso activo',u.active_users],['Usuarios vinculados (incluye inactivos)',u.registered_users],[l.commercial_enforced?'Máximo total de equipos del plan':'Límite de camiones registrado',l.truck_limit],...(l.commercial_enforced?[['Equipos contratados del período mostrado',l.contracted_equipment]]:[]),['Camiones registrados',u.trucks]])}</section><section class="admin-card"><h3>Módulos registrados en la licencia</h3><p>La disponibilidad de cada función también depende de los permisos del usuario.</p>${modules.length?profileFacts(modules.map(([key,value])=>[esc(moduleLabels[key]||key),value===true?'Habilitado en el registro':value===false?'Deshabilitado en el registro':'No informado'])):'<p>No hay información de módulos registrada.</p>'}</section>`;
  }
  async function owners(){const o=await get('admin/owners');document.getElementById('admin-panel').innerHTML=`<div class="admin-card"><div class="admin-section-head"><div><h3>Gobierno de propietarios</h3><p>Ownership separado de roles y memberships. Máximo: 2 principales y 2 backup.</p></div></div><div class="wrap"><table class="table"><thead><tr><th>Slot</th><th>Tipo</th><th>Identidad</th><th>Estado</th><th>Incorporación</th><th></th></tr></thead><tbody>${o.map(x=>`<tr><td>${x.slot}</td><td>${x.owner_type==='primary'?'Principal':'Backup'}</td><td><b>${esc(x.name)}</b><small>${esc(x.email)}</small></td><td><span class="admin-status ${x.active?'on':'off'}">${x.active?'Activo':'Inactivo'}</span></td><td>${new Date(x.created_at).toLocaleString('es-CL')}</td><td><button class="smallbtn" onclick="toggleOwner(${x.slot},${!x.active})">${x.active?'Desactivar':'Activar'}</button><button class="smallbtn" onclick="removeOwner(${x.slot})">Retirar</button></td></tr>`).join('')||'<tr><td colspan="6">No hay propietarios registrados.</td></tr>'}</tbody></table></div><p class="admin-note">La incorporación de un propietario requiere un usuario con membership de plataforma activa y no se habilita desde una cuenta administradora delegada.</p></div>`}
  window.toggleOwner=async(slot,active)=>{if(!confirm(active?'¿Activar propietario?':'¿Desactivar propietario?'))return;try{await patch('admin/owners/'+slot,{active});owners()}catch(e){alert(e.message)}};
  window.removeOwner=async slot=>{if(!confirm('¿Retirar este propietario?'))return;try{const r=await fetch('/api/admin/owners/'+slot,{method:'DELETE'});if(!r.ok){const d=await r.json();throw Error(d.error)}owners()}catch(e){alert(e.message)}};
  async function organization(){const c=await get('companies');document.getElementById('admin-panel').innerHTML=`<div class="admin-card"><div class="admin-section-head"><div><h3>Empresas / tenants</h3><p>Administra las empresas que utilizan FleetChile y su licencia.</p></div><button class="primary" onclick="newCompany()">+ Nueva empresa</button></div><div class="wrap"><table class="table"><thead><tr><th>Empresa</th><th>Estado</th><th>Plan</th><th>Licencia</th><th>Vigencia</th><th>Límites</th><th></th></tr></thead><tbody>${c.map(x=>`<tr><td><b>${esc(x.legal_name)}</b><small>${esc(x.rut||'')}</small></td><td><span class="admin-status ${x.active?'on':'off'}">${x.active?'Activa':'Inactiva'}</span></td><td>${x.commercial_enforced?'Ver licencia y cupos':esc(x.plan_code||'Registro anterior')}</td><td>${x.commercial_enforced?'Control comercial activo':esc(x.license_status||'Registro anterior')}</td><td>${x.commercial_enforced?'Consultar períodos pagados':esc(x.license_expires_at||'Registro anterior')}</td><td>${x.commercial_enforced?'Según cupos pagados':(x.user_limit||'—')+' usuarios · '+(x.truck_limit||'—')+' camiones (registro anterior)'}</td><td><button class="smallbtn" onclick="editCompany(${x.id})">Gestionar datos</button><button class="smallbtn" onclick="openCommercialCompany(${x.id})">Licencia y cupos</button></td></tr>`).join('')||'<tr><td colspan="7">No hay empresas registradas.</td></tr>'}</tbody></table></div></div>`}
  window.newCompany=()=>{window.editCompany(null)};
  window.editCompany=async id=>{const c=id===null?{}:(await get('companies')).find(x=>Number(x.id)===Number(id))||{};document.getElementById('mt').textContent=id===null?'Nueva empresa':'Gestionar empresa';document.getElementById('form').innerHTML=`<div class="formgrid">${[['legal_name','Razón social'],['rut','RUT'],['trade_name','Nombre comercial'],['email','Correo'],['phone','Teléfono'],['plan_code','Plan'],['license_status','Estado licencia'],['license_started_at','Inicio licencia'],['license_expires_at','Vencimiento'],['user_limit','Límite usuarios'],['truck_limit','Límite camiones']].map(([k,l])=>`<div class="field"><label>${l}</label><input name="${k}" value="${esc(c[k]||'')}" ${k==='legal_name'?'required':''} ${['plan_code','license_status','license_started_at','license_expires_at','user_limit','truck_limit'].includes(k)&&(id===null||c.commercial_enforced)?'disabled':''}></div>`).join('')}<div class="field"><label>Estado empresa</label><select name="active"><option value="true" ${c.active!==false?'selected':''}>Activa</option><option value="false" ${c.active===false?'selected':''}>Inactiva</option></select></div><div class="formactions"><button class="primary">Guardar</button></div></div>`;document.getElementById('modal').classList.remove('hidden');document.getElementById('form').onsubmit=async e=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));o.active=o.active==='true';for(const k of ['user_limit','truck_limit'])if(o[k])o[k]=Number(o[k]);try{const url=id===null?'companies':'admin/companies/'+id;const r=await fetch('/api/'+url,{method:id===null?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});const d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo guardar');close();organization()}catch(err){alert(err.message)}}};
  window.saveCompany=async id=>{const o={};['legal_name','rut','trade_name','email','phone','address','commune','region'].forEach(k=>o[k]=document.getElementById('co-'+k).value);try{await patch('admin/companies/'+id,o);alert('Organización actualizada');organization()}catch(e){alert(e.message)}};
  async function users(){const platform=window.adminSurface==='platform';const u=await get('users');document.getElementById('admin-panel').innerHTML=`<div class="admin-card"><div class="admin-section-head"><div><h3>Usuarios</h3><p>${platform?'Usuarios de plataforma y empresas.':'Usuarios de mi empresa.'}</p></div><button class="primary" onclick="newAdminUser()">+ Nuevo usuario</button></div><div class="wrap"><table class="table"><thead><tr><th>Nombre</th><th>Correo</th><th>Alcance</th><th>Rol moderno</th><th>Empresa</th><th>Acceso conductor</th><th>Último acceso</th><th>Estado</th><th></th></tr></thead><tbody>${u.map(x=>{const isPlatform=!!x.platform_role_code;const role=isPlatform?(x.platform_role_name||x.platform_role_code):(x.modern_role_name||x.role_name);const company=isPlatform?'—':(x.modern_company_name||x.company_name||'—');const membershipId=/^[1-9]\d*$/.test(String(x.modern_membership_id))?String(x.modern_membership_id):null;const memberActive=x.modern_membership_active;const active=platform?(isPlatform?(x.platform_membership_active??x.active):(memberActive??x.active)):Boolean(memberActive&&x.active);return `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${isPlatform?'PLATFORM':'COMPANY'}</td><td>${esc(role||'Sin rol moderno')}</td><td>${esc(company)}</td><td>${!isPlatform&&(x.modern_role_code||x.role_code)==='driver'?`<span>${x.driver_id?'Asociado':'Sin asociar'}</span><button class="smallbtn" onclick="associateUserDriver(${Number(x.id)})">${x.driver_id?'Ver asociación':'Asociar conductor'}</button>`:'—'}</td><td>${x.last_login_at?new Date(x.last_login_at).toLocaleString('es-CL'):'Nunca'}</td><td><span class="admin-status ${active?'on':'off'}">${!platform&&!x.active?'Cuenta bloqueada por plataforma':active?'Activo':'Inactivo'}</span></td><td>${platform?`<button class="smallbtn" onclick="toggleAdminUser(${x.id},${!x.active})">${x.active?'Desactivar cuenta':'Activar cuenta'}</button>`:membershipId?`<button class="smallbtn" onclick="toggleCompanyMembership('${membershipId}',${!memberActive})">${memberActive?'Desactivar acceso empresa':'Activar acceso empresa'}</button>`:'<span>Sin membership empresarial</span>'}${platform?platformUserSupportAction(x)+platformPersonnelExemptionAction(x):''}</td></tr>`}).join('')}</tbody></table></div></div>`}
  window.associateUserDriver=async id=>{
    try{
      const data=await get('users/'+encodeURIComponent(id)+'/driver-assignment');
      document.getElementById('mt').textContent='Asociar cuenta de conductor';
      document.getElementById('form').innerHTML=`<div class="formgrid"><p>Cuenta: <b>${esc(data.user.name)}</b> · ${esc(data.user.email)}</p><p>Selecciona la ficha de conductor de esta misma empresa. Esta asociación habilita el acceso del conductor a sus viajes.</p><div class="field"><label>Ficha de conductor</label><select name="driver_id" required><option value="">Seleccionar conductor</option>${data.drivers.map(driver=>`<option value="${Number(driver.id)}" ${driver.id===data.user.driver_id?'selected':''}>${esc(driver.name)} · RUT ${esc(driver.rut||'no informado')}</option>`).join('')}</select></div>${!data.drivers.length?'<p>No hay fichas disponibles. Crea la ficha en Conductores dentro de la empresa correspondiente y vuelve a asociarla aquí.</p>':''}<div class="formactions"><button class="primary" ${!data.drivers.length?'disabled':''}>Guardar asociación</button></div></div>`;
      document.getElementById('modal').classList.remove('hidden');
      let saving=false;
      document.getElementById('form').onsubmit=async event=>{
        event.preventDefault();
        if(saving)return;
        const fields=Object.fromEntries(new FormData(event.target));
        const driverId=Number(fields.driver_id);
        if(!Number.isSafeInteger(driverId)||driverId<1)return alert('Selecciona un conductor');
        saving=true;
        try{
          await patch('users/'+encodeURIComponent(id)+'/driver-assignment',{driver_id:driverId});
          close();
          await users();
          alert('Conductor asociado. Recarga el portal del conductor para actualizar su acceso.');
        }catch(error){alert(error.message)}finally{saving=false}
      };
    }catch(error){alert(error.message)}
  };
  window.newAdminUser=async()=>{
    const platform=window.adminSurface==='platform';
    if(!platform)return window.renderCompanyPeople?.();
    const [r,c,p]=await Promise.all([get('company-roles'),get('companies'),get('platform-roles')]);
    const roles=[...p.map(x=>({...x,_scope:'PLATFORM'})),...r.map(x=>({...x,_scope:'COMPANY'}))];
    document.getElementById('mt').textContent='Nuevo usuario';
    const form=document.getElementById('form');
    form.innerHTML=`<div class="formgrid"><div class="field"><label for="platform-user-name">Nombre</label><input id="platform-user-name" name="name" required></div><div class="field"><label for="platform-user-email">Correo</label><input id="platform-user-email" name="email" type="email" required></div><div class="field"><label for="platform-user-phone">Teléfono</label><input id="platform-user-phone" name="phone"></div><div class="field"><label for="platform-user-password">Contraseña</label><input id="platform-user-password" name="password" type="password" minlength="10" required autocomplete="new-password"></div><div class="field"><label for="platform-user-scope">Alcance</label><select id="platform-user-scope" name="scope"><option value="PLATFORM">PLATFORM</option><option value="COMPANY" selected>COMPANY</option></select></div><div class="field"><label for="platform-user-role">Rol</label><select id="platform-user-role" name="role_id" required>${roles.map(x=>`<option data-scope="${x._scope}" data-code="${esc(x.code)}" value="${x.id}">${esc(x.name)} · ${x._scope}</option>`).join('')}</select></div><div class="field"><label for="platform-user-company">Empresa</label><select id="platform-user-company" name="company_id"><option value="">Seleccionar empresa para usuario COMPANY</option>${c.map(x=>`<option value="${x.id}">${esc(x.legal_name)}</option>`).join('')}</select></div><fieldset data-bootstrap-fields hidden><legend>Exención bootstrap de administrador empresarial</legend><label><input name="bootstrap_exempt" type="checkbox" disabled> Registrar una exención explícita de regularización contractual</label><p>No elimina condiciones laborales ni bloqueos de cuenta. Solo plataforma puede registrarla y requiere motivo.</p><div class="field"><label for="platform-bootstrap-reason">Motivo de la exención</label><input id="platform-bootstrap-reason" name="bootstrap_exemption_reason" maxlength="2000" disabled></div></fieldset><div class="formactions"><button class="primary" type="submit">Crear usuario</button></div></div>`;
    const scope=document.querySelector('#form [name="scope"]'),roleSelect=document.querySelector('#form [name="role_id"]'),companySelect=document.querySelector('#form [name="company_id"]');
    const bootstrap=form.querySelector('[data-bootstrap-fields]'),check=form.querySelector('[name="bootstrap_exempt"]'),why=form.querySelector('[name="bootstrap_exemption_reason"]');
    const syncBootstrap=()=>{
      const current=[...roleSelect.options].find(option=>option.value===roleSelect.value);
      const eligible=scope.value==='COMPANY'&&current?.dataset.code==='company_admin';
      bootstrap.hidden=!eligible;check.disabled=!eligible;
      if(!eligible){check.checked=false;why.value='';}
      why.disabled=!eligible||!check.checked;why.required=eligible&&check.checked;
    };
    const sync=()=>{
      const isP=scope.value==='PLATFORM';[...roleSelect.options].forEach(option=>option.hidden=option.dataset.scope!==(isP?'PLATFORM':'COMPANY'));
      roleSelect.value=[...roleSelect.options].find(option=>!option.hidden)?.value||'';
      companySelect.disabled=isP;companySelect.required=!isP;companySelect.value='';syncBootstrap();
    };
    scope.addEventListener('change',sync);roleSelect.addEventListener('change',syncBootstrap);check.addEventListener('change',syncBootstrap);sync();
    document.getElementById('modal').classList.remove('hidden');
    let saving=false;
    form.onsubmit=async event=>{
      event.preventDefault();if(saving)return;
      const body=Object.fromEntries(new FormData(form));body.role_id=Number(body.role_id);body.company_id=body.company_id?Number(body.company_id):null;
      delete body.bootstrap_exempt;delete body.bootstrap_exemption_reason;
      if(!bootstrap.hidden&&check.checked){
        if(!String(why.value||'').trim()){why.focus();return;}
        body.bootstrap_exempt=true;body.bootstrap_exemption_reason=why.value.trim();
      }
      const submit=form.querySelector('button[type="submit"]');saving=true;submit.disabled=true;
      try{const response=await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const payload=await response.json();if(!response.ok)throw Error(payload.error||'No se pudo crear el usuario');close();await users();}
      catch(error){alert(error.message);}
      finally{saving=false;submit.disabled=false;}
    };
  };
  window.toggleAdminUser=async(id,active)=>{
    const company=typeof localStorage!=='undefined'&&localStorage.getItem('fleet_company_context');
    if(company){
      alert('Estás administrando una empresa. Gestiona el acceso empresarial desde Personas y accesos; no se modificará la cuenta global.');
      if(positiveId(id)&&typeof window.openCompanyPersonForUser==='function')return window.openCompanyPersonForUser(String(id));
      return window.companyPeople?.();
    }
    if(!confirm(active?'¿Activar usuario?':'¿Desactivar usuario?'))return;
    try{await patch('users/'+id,{active});return users()}catch(e){alert(e.message)}
  };
  window.toggleCompanyMembership=async(id,active)=>{
    if(window.adminSurface!=='company'||!/^[1-9]\d*$/.test(String(id)))return;
    if(!confirm(active?'¿Activar el acceso a esta empresa? No cambia el bloqueo global de la cuenta.':'¿Desactivar solo el acceso a esta empresa? Los accesos a otras empresas no se modificarán.'))return;
    const revision=adminRevision;
    try{await patch('user-memberships/'+encodeURIComponent(id),{active});if(revision===adminRevision)await users()}catch(error){if(!error.stale)alert(error.message)}
  };
  async function roles(){const[r,p]=await Promise.all([get('roles'),get('admin/permissions')]);document.getElementById('admin-panel').innerHTML=`<div class="admin-card"><div class="admin-section-head"><div><h3>Roles y permisos</h3><p>Define qué módulos puede gestionar cada perfil.</p></div></div><div class="role-layout"><div class="role-list">${r.map((x,i)=>`<button class="role-select ${i===0?'active':''}" onclick="selectRole(${x.id},this)"><b>${esc(x.name)}</b><small>${esc(x.description||'')}</small></button>`).join('')}</div><div id="permission-editor"><p>Selecciona un rol.</p></div></div></div>`;if(r[0])selectRole(r[0].id,document.querySelector('.role-select'))}
  window.selectRole=async(id,el)=>{document.querySelectorAll('.role-select').forEach(x=>x.classList.remove('active'));el?.classList.add('active');const[p,all]=await Promise.all([get('admin/roles/'+id+'/permissions'),get('admin/permissions')]);const selected=new Set(p.map(x=>x.id));document.getElementById('permission-editor').innerHTML=`<div class="permission-head"><div><h3>Permisos</h3><p>Selecciona las capacidades disponibles para este rol.</p></div><button class="primary" onclick="saveRolePermissions(${id})">Guardar permisos</button></div><div class="permission-grid">${all.map(x=>`<label><input type="checkbox" data-perm="${x.id}" ${selected.has(x.id)?'checked':''}><span><b>${esc(x.name)}</b><small>${esc(x.module)} · ${esc(x.code)}</small></span></label>`).join('')}</div>`};
  window.saveRolePermissions=async id=>{const ids=[...document.querySelectorAll('[data-perm]:checked')].map(x=>Number(x.dataset.perm));try{await put('admin/roles/'+id+'/permissions',{permission_ids:ids});alert('Permisos guardados')}catch(e){alert(e.message)}};
  async function settings(){const s=await get('admin/settings');const groups={};s.forEach(x=>(groups[x.category]??=[]).push(x));document.getElementById('admin-panel').innerHTML=Object.entries(groups).map(([cat,items])=>`<section class="admin-card settings-group"><div class="admin-section-head"><div><h3>${esc(cat.charAt(0).toUpperCase()+cat.slice(1))}</h3></div></div><div class="settings-list">${items.map(x=>{const v=x.value;const type=typeof v==='boolean'?'boolean':typeof v==='number'?'number':'text';return `<label><span><b>${esc(x.label)}</b><small>${esc(x.description||'')}</small></span><input data-setting="${esc(x.setting_key)}" data-type="${type}" value="${esc(typeof v==='string'?v.replace(/^"|"$/g,''):v)}" ${type==='boolean'?'type=checkbox '+(v?'checked':''):type==='number'?'type=number':''}></label>`}).join('')}<button class="primary" onclick="saveSettings()">Guardar cambios</button></div></section>`).join('')}
  window.saveSettings=async()=>{try{for(const el of document.querySelectorAll('[data-setting]')){let v;if(el.dataset.type==='boolean')v=el.checked;else if(el.dataset.type==='number')v=Number(el.value);else v=el.value;await patch('admin/settings/'+encodeURIComponent(el.dataset.setting),{value:v})}const s=await get('public/settings');const raw=s['appearance.company_name'];const name=typeof raw==='string'?raw.replace(/^"|"$/g,''):raw;applyBranding(name);alert('Configuración guardada');settings()}catch(e){alert(e.message)}};
  async function audit(){const a=await get('admin/audit');document.getElementById('admin-panel').innerHTML=`<div class="admin-card"><div class="admin-section-head"><div><h3>Auditoría</h3><p>Registro reciente de acciones del sistema.</p></div></div><div class="wrap"><table class="table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>ID</th><th>IP</th></tr></thead><tbody>${a.map(x=>`<tr><td>${new Date(x.created_at).toLocaleString('es-CL')}</td><td>${esc(x.user_name||'Sistema')}</td><td>${esc(x.action)}</td><td>${esc(x.entity)}</td><td>${esc(x.entity_id||'—')}</td><td>${esc(x.ip||'—')}</td></tr>`).join('')||'<tr><td colspan="6">No hay eventos registrados.</td></tr>'}</tbody></table></div></div>`}
  const platformUsers=users;
  function platformUserSupportAction(user){
    if(!platformSupport(adminIdentity)||user.platform_role_code)return '';
    const userId=positiveId(user.id),companyId=positiveId(user.modern_company_id);
    if(!userId||!companyId)return '<small>Soporte empresarial: se requiere una membership verificable.</small>';
    return `<button class="smallbtn" onclick="openPlatformCompanyUser('${userId}','${companyId}')">Editar en empresa</button>`;
  }
  window.openPlatformCompanyUser=async function(userId,companyId){
    if(supportSwitchBusy||!platformSupport(adminIdentity)||!positiveId(userId)||!positiveId(companyId))return;
    const revision=adminRevision,identity=String(adminIdentity.id),token=window.Auth?.token;
    const prior=typeof localStorage!=='undefined'?localStorage.getItem('fleet_company_context')||'':'';
    supportSwitchBusy=true;
    try{
      // Revalidate both the actor and row's company before recording a context switch.
      const identityResult=await get('auth/me');
      if(!platformSupport(identityResult.user)||String(identityResult.user.id)!==identity)return;
      const response=await fetch('/api/users/'+encodeURIComponent(userId)+'/memberships?company_id='+encodeURIComponent(companyId));
      const memberships=await response.json();if(!response.ok)throw Error(memberships.error||'No se pudo verificar la empresa del usuario.');
      if(revision!==adminRevision||window.Auth?.token!==token)return;
      const matches=Array.isArray(memberships)?memberships.filter(row=>String(row.company_id)===String(companyId)&&String(row.user_id)===String(userId)&&positiveId(row.id)):[];
      if(matches.length!==1)throw Error('No hay una membership empresarial única para ese usuario y empresa.');
      if(!confirm('¿Abrir soporte de plataforma para la empresa #'+companyId+'? Se registrará la selección de esta empresa antes de editar.'))return;
      if((typeof localStorage!=='undefined'?localStorage.getItem('fleet_company_context')||'':'')!==prior)throw Error('El contexto cambió durante la solicitud. Vuelve a seleccionar la empresa.');
      const switched=await fetch('/api/auth/company-context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_id:companyId})});
      const result=await switched.json();if(!switched.ok)throw Error(result.error||'No se pudo cambiar de empresa.');
      if(String(result.company?.id)!==String(companyId))throw Error('El servidor no confirmó la empresa solicitada.');
      if(revision!==adminRevision||String(adminIdentity?.id)!==identity||window.Auth?.token!==token)return;
      if((typeof localStorage!=='undefined'?localStorage.getItem('fleet_company_context')||'':'')!==prior)throw Error('El contexto cambió durante la solicitud. Vuelve a seleccionar la empresa.');
      localStorage.setItem('fleet_company_context',String(companyId));
      const name=document.getElementById('activeCompanyName');if(name)name.textContent=result.company.legal_name||'Empresa #'+companyId;
      const mark=document.getElementById('activeCompanyMark');if(mark)mark.textContent='FC';
      const selector=document.getElementById('companyContextSelect');if(selector)selector.value=String(companyId);
      const selectedIdentity={...identityResult.user,active_company_context:String(companyId)};
      if(window.Auth)window.Auth.user=selectedIdentity;
      window.renderAdminNavigation(selectedIdentity);
      if(typeof window.openCompanyPersonForUser!=='function')throw Error('No se pudo cargar Personas y accesos. Recarga la aplicación.');
      await window.openCompanyPersonForUser(String(userId));
    }catch(error){if(!error.stale)alert(error.message);}
    finally{supportSwitchBusy=false;}
  };
  users=async function(){
    if(window.adminSurface==='platform')return platformUsers();
    if(typeof window.renderCompanyPeople!=='function')throw Error('No se pudo cargar Personas y accesos. Recarga la aplicación.');
    return window.renderCompanyPeople();
  };
  function platformPersonnelExemptionAction(user){
    if(adminIdentity?.actor_type!=='platform'||!adminIdentity.permissions?.includes('platform.users.manage')||user.modern_role_code!=='company_admin')return '';
    const membershipId=/^[1-9]\d*$/.test(String(user.modern_membership_id))?String(user.modern_membership_id):null;
    if(!membershipId){
      const userId=/^[1-9]\d*$/.test(String(user.id))?String(user.id):null;
      const companyId=/^[1-9]\d*$/.test(String(user.modern_company_id))?String(user.modern_company_id):null;
      if(!userId||!companyId)return '<small>Exención laboral: requiere membership empresarial verificable.</small>';
      return `<button class="smallbtn" onclick="resolvePersonnelPlatformExemption('${userId}','${companyId}',true)">Registrar exención laboral</button><button class="smallbtn" onclick="resolvePersonnelPlatformExemption('${userId}','${companyId}',false)">Retirar exención laboral</button>`;
    }
    return `<button class="smallbtn" onclick="personnelPlatformExemption('${membershipId}',true)">Registrar exención laboral</button><button class="smallbtn" onclick="personnelPlatformExemption('${membershipId}',false)">Retirar exención laboral</button>`;
  }
  window.resolvePersonnelPlatformExemption=async function(userId,companyId,exempt){
    if(adminIdentity?.actor_type!=='platform'||!adminIdentity.permissions?.includes('platform.users.manage')||![userId,companyId].every(value=>/^[1-9]\d*$/.test(String(value))))return;
    try{
      const rows=await get('users/'+encodeURIComponent(userId)+'/memberships?company_id='+encodeURIComponent(companyId));
      const matches=rows.filter(row=>String(row.company_id)===String(companyId)&&row.role_code==='company_admin'&&/^[1-9]\d*$/.test(String(row.id)));
      if(matches.length!==1)throw Error('No se pudo verificar una membership única de administrador empresarial.');
      window.personnelPlatformExemption(String(matches[0].id),exempt);
    }catch(error){if(!error.stale)alert(error.message);}
  };
  window.personnelPlatformExemption=function(membershipId,exempt){
    if(adminIdentity?.actor_type!=='platform'||!adminIdentity.permissions?.includes('platform.users.manage')||!/^[1-9]\d*$/.test(String(membershipId)))return;
    document.getElementById('mt').textContent=exempt?'Registrar exención laboral':'Retirar exención laboral';
    const form=document.getElementById('form');
    form.innerHTML='<p>Solo aplica a la membership de administrador de empresa indicada. No elimina condiciones laborales ni otros bloqueos de acceso.</p><div class="field"><label for="personnelExemptionReason">Motivo obligatorio</label><input id="personnelExemptionReason" name="reason" required maxlength="2000"></div><p data-exemption-error role="alert" hidden></p><div class="formactions"><button class="primary" type="submit">Confirmar</button></div>';
    document.getElementById('modal').classList.remove('hidden');
    let saving=false;form.onsubmit=async event=>{
      event.preventDefault();if(saving)return;const reason=String(new FormData(form).get('reason')||'').trim();if(!reason)return;
      saving=true;const button=form.querySelector('button[type="submit"]');button.disabled=true;
      try{const response=await fetch('/api/platform/personnel/'+encodeURIComponent(membershipId)+'/exemption',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exempt,reason})});const data=await response.json();if(!response.ok)throw Error(data.error||'No se pudo registrar la exención');close();await users();}
      catch(error){const box=form.querySelector('[data-exemption-error]');box.textContent=error.message;box.hidden=false;}
      finally{saving=false;button.disabled=false;}
    };
  };
})();
