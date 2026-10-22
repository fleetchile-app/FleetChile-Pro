const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/admin.js'),'utf8');
const platform={id:1,actor_type:'platform',platform_membership_id:2,permissions:['platform.users.manage','platform.companies.manage']};
const company={id:2,actor_type:'company',membership_id:3,company_id:10,permissions:['company.users.manage']};

function surface({user=platform,responses={}}={}){
 const elements={},sidebar=[],requests=[],events={};let stopped=0;
 function element(){const classes=new Set();return {innerHTML:'',textContent:'',hidden:false,dataset:{},attrs:{},focused:0,setAttribute(key,value){this.attrs[key]=value},getAttribute(key){return this.attrs[key]},focus(){this.focused++},contains(target){return target===this},appendChild(child){sidebar.push(child)},classList:{add(value){classes.add(value)},remove(value){classes.delete(value)},contains:value=>classes.has(value),toggle(value,on){if(on)classes.add(value);else classes.delete(value)}}}}
 for(const id of ['app','title','admin-panel','nav','platformAdminMenuHost','platformAdminLinks','platformAdminToggle'])elements[id]=element();
 elements.platformAdminLinks.hidden=true;
 let hostHtml='';Object.defineProperty(elements.platformAdminMenuHost,'innerHTML',{get(){return hostHtml},set(value){hostHtml=value;elements.platformAdminLinks.hidden=true;elements.platformAdminToggle.attrs['aria-expanded']='false'}});
 const defaults={'/api/public/settings':{},'/api/auth/me':{user},'/api/admin/platform-summary':{companies:{active:2,total:3,inactive:1},users:{active:4,total:5},company_memberships:{active:3},platform_memberships:{active:2,total:2},recent_audit_30d:9},'/api/core/summary':{users:2,clients:3,active_trips:1}};
 const context={Auth:{user},document:{getElementById:id=>elements[id]||(elements[id]=element()),createElement:element,querySelectorAll:selector=>selector==='#nav button'?sidebar:[],querySelector:()=>null,addEventListener:(event,handler)=>events[event]=handler},stopControlDashboard(){stopped++},fetch:async(url,options={})=>{
  requests.push({url,options});const result=Object.hasOwn(responses,url)?responses[url]:defaults[url]??[];
  if(typeof result==='function')return result(url,options);
  if(result instanceof Error)throw result;
  return {ok:!result?.error,status:result?.error?403:200,json:async()=>result};
 }};
 context.window=context;vm.createContext(context);vm.runInContext(source,context);
 return {context,elements,sidebar,requests,events,get stopped(){return stopped}};
}

test('plataforma usa acceso superior exclusivo y no aparece como administración empresarial',()=>{
 const s=surface();assert.equal(s.elements.platformAdminMenuHost.hidden,false);assert.equal(s.sidebar[0].hidden,true);
 assert.match(s.elements.platformAdminMenuHost.innerHTML,/Resumen global|Empresas y licencias|Usuarios|Roles y permisos|Configuración global|Auditoría/);
 assert.doesNotMatch(s.elements.platformAdminMenuHost.innerHTML,/Propietarios/);
});

test('empresa ve Mi empresa sin opciones globales ni acceso superior',()=>{
 const s=surface({user:company});assert.equal(s.elements.platformAdminMenuHost.hidden,true);assert.equal(s.elements.platformAdminMenuHost.innerHTML,'');
 assert.equal(s.sidebar[0].hidden,false);assert.match(s.sidebar[0].innerHTML,/Mi empresa/);
});

for(const user of [null,{id:3,actor_type:'company',membership_id:3,company_id:10,permissions:['dashboard.read']},{...platform,permissions:[]}])test('oculta administración sin capacidades autorizadas: '+JSON.stringify(user),()=>{
 const s=surface({user});assert.equal(s.sidebar[0].hidden,true);assert.equal(s.elements.platformAdminMenuHost.hidden,true);
});

test('menú superior refleja permisos parciales sin cambiar autorizaciones',()=>{
 const s=surface({user:{...platform,permissions:['platform.companies.manage']}});
 assert.match(s.elements.platformAdminMenuHost.innerHTML,/Empresas y licencias|Configuración global/);
 assert.doesNotMatch(s.elements.platformAdminMenuHost.innerHTML,/>Usuarios<|Roles y permisos|Propietarios/);
});

test('propietarios solo aparece para ownership activo, no por nombre del rol',()=>{
 const s=surface({user:{...platform,ownership_role:'primary',ownership_active:true}});assert.match(s.elements.platformAdminMenuHost.innerHTML,/Propietarios/);
 s.context.renderAdminNavigation({...platform,ownership_role:'primary',ownership_active:false});assert.doesNotMatch(s.elements.platformAdminMenuHost.innerHTML,/Propietarios/);
 s.context.renderAdminNavigation({...platform,role_code:'ROOT_OWNER'});assert.doesNotMatch(s.elements.platformAdminMenuHost.innerHTML,/Propietarios/);
});

test('compatibilidad legacy conserva entrada empresarial sin atribuir identidad de plataforma',()=>{
 const s=surface({user:{id:1,actor_type:'legacy',role_code:'admin',company_id:10}});
 assert.equal(s.sidebar[0].hidden,false);assert.equal(s.elements.platformAdminMenuHost.hidden,true);
});

test('desplegable abre sin consultar API ni cambiar empresa; Escape cierra y devuelve foco',()=>{
 const s=surface();const before=s.requests.length;s.context.togglePlatformAdminMenu();
 assert.equal(s.elements.platformAdminLinks.hidden,false);assert.equal(s.elements.platformAdminToggle.attrs['aria-expanded'],'true');assert.equal(s.requests.length,before);
 s.events.keydown({key:'Escape'});assert.equal(s.elements.platformAdminLinks.hidden,true);assert.equal(s.elements.platformAdminToggle.focused,1);
 s.context.togglePlatformAdminMenu(true);s.events.click({target:{}});assert.equal(s.elements.platformAdminLinks.hidden,true);
 assert.doesNotMatch(source,/localStorage\.setItem|company-context/);
});

test('cada acceso superior abre el destino solicitado y mantiene título, selección y clics repetidos',async()=>{
 const s=surface();
 for(const tab of ['organization','users','settings','audit','overview','audit']){
  await s.context.platformAdministration(tab);
  assert.match(s.elements.title.textContent,/^Plataforma · /);
  assert.match(s.elements.app.innerHTML,new RegExp(`aria-current="page" onclick="adminTab\\('${tab}'\\)"`));
  assert.equal(s.sidebar[0].classList.contains('active'),false);
  assert.match(s.elements.platformAdminMenuHost.innerHTML,new RegExp(`aria-current="page" onclick="platformAdministration\\('${tab}'\\)"`));
 }
 assert.equal(s.requests.some(request=>request.options.method),false);assert.equal(s.stopped,6);
});

test('Mi empresa y Usuarios tienen acción y solo una opción activa al alternar',async()=>{
 const s=surface({user:company});await s.context.configuration();
 await s.context.adminTab('users');assert.equal((s.elements.app.innerHTML.match(/aria-current="page"/g)||[]).length,1);
 assert.equal(s.elements.title.textContent,'Mi empresa · Usuarios');
 await s.context.adminTab('overview');assert.equal(s.elements.title.textContent,'Mi empresa · Mi empresa');
 assert.match(s.elements.app.innerHTML,/onclick="adminTab\('overview'\)"/);
 assert.equal(s.sidebar[0].classList.contains('active'),true);
 assert.equal(s.requests.some(request=>request.url.startsWith('/api/admin/')),false);
});

for(const tab of ['organization','roles','settings','audit','owners'])test('empresa no despacha pestaña exclusiva '+tab,async()=>{
 const s=surface({user:company});await s.context.configuration();const before=s.requests.length;
 await s.context.adminTab(tab);assert.match(s.elements.app.innerHTML,/Acceso restringido/);assert.equal(s.requests.length,before);
});

test('entrada superior revalida identidad y niega acceso si el servidor devuelve empresa',async()=>{
 const s=surface({responses:{'/api/auth/me':{user:company}}});await s.context.platformAdministration('audit');
 assert.match(s.elements.app.innerHTML,/Acceso restringido/);assert.equal(s.elements.platformAdminMenuHost.hidden,true);
 assert.equal(s.requests.some(request=>request.url==='/api/admin/audit'),false);
});

test('owner sin permisos generales conserva gobierno de propietarios sin habilitar configuración',async()=>{
 const s=surface({user:{...platform,permissions:[],ownership_role:'primary',ownership_active:true}});
 await s.context.platformAdministration('owners');assert.equal(s.context.adminOwner,true);assert.match(s.elements['admin-panel'].innerHTML,/Gobierno de propietarios/);
 await s.context.adminTab('settings');assert.match(s.elements.app.innerHTML,/Acceso restringido/);
});

test('resumen global usa solo summary y funciona con permisos parciales',async()=>{
 const s=surface({user:{...platform,permissions:['platform.companies.manage']}});await s.context.platformAdministration('overview');
 assert.match(s.elements['admin-panel'].innerHTML,/Empresas y licencias/);
 assert.equal(s.requests.some(request=>['/api/users','/api/companies'].includes(request.url)),false);
});

test('gestor de usuarios sin permiso de empresas abre Usuarios sin pedir catálogos ajenos',async()=>{
 const s=surface({user:{...platform,permissions:['platform.users.manage']},responses:{'/api/companies':{error:'Sin permiso de empresas'}}});
 await s.context.platformAdministration('users');
 assert.match(s.elements['admin-panel'].innerHTML,/Usuarios de plataforma y empresas/);
 assert.equal(s.requests.some(request=>request.url==='/api/companies'),false);
});

test('errores asíncronos se muestran con Reintentar en lugar de dejar Cargando',async()=>{
 const s=surface({responses:{'/api/admin/settings':{error:'Fallo controlado <script>'}}});await s.context.platformAdministration('settings');
 assert.match(s.elements['admin-panel'].innerHTML,/Fallo controlado &lt;script&gt;/);assert.match(s.elements['admin-panel'].innerHTML,/Reintentar/);
 assert.doesNotMatch(s.elements['admin-panel'].innerHTML,/Cargando/);
});

test('respuestas antiguas no sobrescriben una pestaña más reciente',async()=>{
 let release;const s=surface({responses:{'/api/companies':()=>new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>[]}))}});
 await s.context.platformAdministration('overview');
 const previous=s.context.adminTab('organization');await s.context.adminTab('audit');const html=s.elements['admin-panel'].innerHTML;
 release();await previous;assert.equal(s.elements['admin-panel'].innerHTML,html);assert.equal(s.elements.title.textContent,'Plataforma · Auditoría');
});

test('salir de administración invalida consultas y limpia selección superior',async()=>{
 let release;const s=surface({responses:{'/api/admin/audit':()=>new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>[]}))}});
 await s.context.platformAdministration('overview');const pending=s.context.adminTab('audit');
 s.context.leaveAdminView();s.elements.app.innerHTML='Dashboard operativo';release();await pending;
 assert.equal(s.elements.app.innerHTML,'Dashboard operativo');assert.doesNotMatch(s.elements.platformAdminMenuHost.innerHTML,/aria-current/);
});

test('cierre de sesión limpia opciones y disposición de cabecera incluye menú separado',()=>{
 const s=surface();s.context.renderAdminNavigation(null);assert.equal(s.elements.platformAdminMenuHost.hidden,true);assert.equal(s.sidebar[0].hidden,true);
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8'),auth=fs.readFileSync(require.resolve('../public/auth.js'),'utf8'),app=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 assert.match(html,/<header>[\s\S]*platformAdminMenuHost[\s\S]*activeCompany/);
 assert.match(auth,/renderAdminNavigation\?\.\(null\)/);assert.match(auth,/renderAdminNavigation\?\.\(user\)/);
 assert.match(app,/window\.leaveAdminView\?\.\(\)/);
 const css=fs.readFileSync(require.resolve('../public/admin.css'),'utf8');assert.match(css,/focus-visible/);assert.match(css,/min-height:44px/);assert.match(css,/#nav button\.admin-nav-item\[hidden\]/);
});

test('arranque sin argumento usa Auth.user para mostrar navegación autenticada',()=>{
 const s=surface();s.context.renderAdminNavigation(null);s.context.renderActiveIdentity=()=>{};
 const auth=fs.readFileSync(require.resolve('../public/auth.js'),'utf8');
 vm.runInContext(auth.slice(auth.lastIndexOf('const renderIdentityBase=renderActiveIdentity;')),s.context);
 s.context.renderActiveIdentity();assert.equal(s.elements.platformAdminMenuHost.hidden,false);
 s.context.Auth.user=company;s.context.renderActiveIdentity();assert.equal(s.sidebar[0].hidden,false);assert.equal(s.elements.platformAdminMenuHost.hidden,true);
});
