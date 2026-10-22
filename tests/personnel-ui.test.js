const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/personnel.js'),'utf8');
const admin=fs.readFileSync(require.resolve('../public/admin.js'),'utf8');

// Lightweight DOM/event harness: executes production delegated handlers and inspects
// their resulting markup/requests. This does not establish browser layout or DB integration.
function element(){
  const cache=new Map(),classes=new Set();
  return {_html:'',dataset:{},isConnected:true,hidden:false,disabled:false,value:'',textContent:'',attrs:{},events:{},children:[],
    get innerHTML(){return this._html;},set innerHTML(value){this._html=value;cache.clear();},
    querySelector(selector){
      if(cache.has(selector))return cache.get(selector);
      // Forms submitted by tests have explicit values. Other nodes model focus/errors.
      const child=element();cache.set(selector,child);return child;
    },querySelectorAll(){return [];},contains(){return true;},focus(){this.focused=true;},
    addEventListener(type,handler){this.events[type]=handler;},appendChild(child){this.children.push(child);},
    setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];},
    classList:{add(value){classes.add(value);},remove(value){classes.delete(value);},toggle(value,on){if(on)classes.add(value);else classes.delete(value);},contains:value=>classes.has(value)}
  };
}
function form(kind,values={},dataset={}){
  const node=element();node.dataset={form:kind,...dataset};node.values=values;return node;
}
const roles=[{id:1,code:'company_admin',name:'Administrador de empresa'},{id:2,code:'driver',name:'Conductor'},{id:3,code:'administrative',name:'Administrativo'}];
const defaultRows=[{id:'11',user_id:'71',membership_id:'81',driver_id:'91',name:'Ana <script>secret()</script>',email:'ana@example.test',rut:'12345678-5',role_code:'driver',role_name:'Conductor',condition_label:'vacation',contract_label:'fixed',access:{allowed:false,reasons:['CONDITION_ACTIVE']},license_label:'valid'},
  {id:null,user_id:'72',membership_id:'82',name:'Por regularizar',email:'b@example.test',role_code:'administrative',role_name:'Administrativo',access:{allowed:true,regularization_required:true}}];
const list=()=>({rows:structuredClone(defaultRows),total:60,page:1,page_size:25,roles,policy:{enforced:false},can_manage:true,can_accounts:true,can_licenses:true,notifications_unread:2});
const ficha=()=>({person:{id:'11',membership_id:'81',role_id:2,role_code:'driver',name:'Ana',rut:'12345678-5',birth_date:'1990-01-01',job_title:'Conductora',membership_active:true},contracts:[{id:'5',type:'fixed',start_date:'2026-01-01',end_date:'2026-12-31'}],conditions:[{id:'6',type:'vacation',start_date:'2026-10-01',end_date:'2026-10-30'}],licenses:[{id:'7',classes:['A5'],printed_expiry:'2026-12-31',effective_expiry:'2027-06-30',current:true}],events:[],access:{allowed:false,reasons:['CONDITION_ACTIVE']},roles,can_manage:true,can_licenses:true});
function surface({payload=list(),person=ficha(),user={},fetcher,confirmation=true}={}){
  const nodes={},calls=[],nav=element();let mounted;
  for(const key of ['app','admin-panel','title','activeCompanyName','platformAdminMenuHost','mt','form','modal'])nodes[key]=element();
  nodes.activeCompanyName.textContent='Empresa A';
  for(const key of ['app','admin-panel'])Object.defineProperty(nodes[key],'innerHTML',{get(){return this._html;},set(value){this._html=value;if(value.includes('id="personnel-root"'))mounted=element();}});
  const state={Auth:{token:'session-A',user:{id:71,actor_type:'company',scope:'company',company_id:10,membership_id:81,company_name:'Empresa A',permissions:['company.people.read','company.people.manage','company.licenses.manage','company.users.manage'],...user}},
    document:{getElementById:key=>key==='personnel-root'?mounted:key==='nav'?nav:nodes[key]||(nodes[key]=element()),querySelectorAll:()=>nav.children,createElement:element},
    localStorage:{getItem:()=>null},URLSearchParams,Date,console,confirm:()=>confirmation,
    FormData:class{constructor(node){this.values=node.values||{};}*[Symbol.iterator](){for(const [key,value] of Object.entries(this.values))if(Array.isArray(value)){for(const item of value)yield [key,item];}else yield [key,value];}getAll(key){const value=this.values[key];return value===undefined?[]:Array.isArray(value)?value:[value];}get(key){return this.values[key]??null;}},
    fetch:async(url,options={})=>{
      calls.push({url,options});let value;
      if(fetcher)value=await fetcher(url,options);
      if(value===undefined){
        if(url==='/api/public/settings')value={};
        else if(url==='/api/auth/me')value={user:state.Auth.user};
        else if(url.includes('/policy/readiness'))value={ready:false,missing:1,issues:[{membership_id:82,name:'Por regularizar',reasons:['PERSON_NOT_REGULARIZED']}]};
        else if(url.includes('/notifications')&&!options.method)value={rows:[{id:9,person_id:11,message:'Fin de condición',created_at:'2026-10-22T14:00:00Z'}]};
        else if(url==='/api/company/people/11'&&!options.method)value=person;
        else if(url.startsWith('/api/company/people?')){const params=new URLSearchParams(url.split('?')[1]);value={...payload,page:Number(params.get('page')||1),page_size:Number(params.get('page_size')||25)};}
        else value={person:{id:11}};
      }
      if(value?.deferred)return value.deferred;
      return {ok:!value?.error,status:value?.error?403:200,json:async()=>value};
    },stopControlDashboard(){state.stopped=(state.stopped||0)+1;},leaveAdminView(){state.left=(state.left||0)+1;}
  };
  state.window=state;vm.createContext(state);vm.runInContext(source,state);
  return {state,nodes,nav,calls,get root(){return mounted;},
    async mount(){await state.renderCompanyPeople();},
    async click(action,dataset={}){const target={dataset:{action,...dataset},closest(){return this;}};return mounted.events.click({target});},
    async submit(kind,values={},dataset={}){const node=form(kind,values,dataset);await mounted.events.submit({target:node,preventDefault(){}});return node;},
    change(name,values,kind='wizard'){const node=form(kind,values),target={name,value:values[name],closest:()=>node};mounted.events.change({target});return node;},
    loadAdmin(){vm.runInContext(admin,state);}
  };
}
const posts=s=>s.calls.filter(call=>call.options.method&&call.options.method!=='GET');

test('lista escapa textos, explica restricciones y obtiene readiness sin activar automáticamente',async()=>{
  const s=surface();await s.mount();assert.match(s.root.innerHTML,/Ana &lt;script&gt;/);assert.doesNotMatch(s.root.innerHTML,/<script>/);
  assert.match(s.root.innerHTML,/Vacaciones/);assert.match(s.root.innerHTML,/Condición laboral bloqueante/);assert.match(s.root.innerHTML,/Revisión automática: 1 accesos pendientes/);
  assert.equal(s.calls.filter(call=>call.url.includes('/policy/readiness')).length,1);assert.equal(posts(s).length,0);
});

test('filtros, orden y página viajan al servidor y persisten tras abrir/volver de ficha',async()=>{
  const s=surface();await s.mount();
  await s.submit('filters',{q:'Ana & RUT',role:'driver',condition:'vacation',access:'blocked',contract:'fixed',sort:'role_code',direction:'desc',page_size:'25'});
  await s.click('next');let request=s.calls.filter(call=>call.url.includes('/people?')).at(-1),params=new URLSearchParams(request.url.split('?')[1]);
  assert.equal(params.get('q'),'Ana & RUT');assert.equal(params.get('role'),'driver');assert.equal(params.get('condition'),'vacation');assert.equal(params.get('page'),'2');assert.equal(params.get('sort'),'role_code');
  await s.click('detail',{id:'11'});await s.click('list');request=s.calls.filter(call=>call.url.includes('/people?')).at(-1);params=new URLSearchParams(request.url.split('?')[1]);
  assert.equal(params.get('page'),'2');assert.equal(params.get('q'),'Ana & RUT');assert.match(s.root.innerHTML,/value="driver" selected/);
  await s.click('clear');params=new URLSearchParams(s.calls.filter(call=>call.url.includes('/people?')).at(-1).url.split('?')[1]);assert.equal(params.has('q'),false);assert.equal(params.get('page'),'1');
});

test('alta valida DV y formatea RUT al salir del campo sin enviar solicitudes',async()=>{
  const s=surface();await s.mount();await s.click('new');const f=await s.submit('wizard',{name:'Ana',rut:'12.345.678-0'});
  assert.match(f.querySelector('[data-error]').textContent,/dígito verificador/);assert.equal(posts(s).length,0);
  const input={name:'rut',value:'123456785',removeAttribute(){}};s.root.events.focusout({target:input});assert.equal(input.value,'12.345.678-5');
});

test('alta de borrador conserva pasos y no envía credenciales, licencia ni autoridad empresarial',async()=>{
  const s=surface();await s.mount();await s.click('new');
  await s.submit('wizard',{name:'Borrador',rut:'',birth_date:'',job_title:'Ayudante',email:'personal@example.test'});
  await s.submit('wizard',{contract_type:''});assert.doesNotMatch(s.root.innerHTML,/name="classes"|include_license/);
  await s.submit('wizard',{});await s.submit('wizard',{});
  const payload=JSON.parse(posts(s)[0].options.body);assert.equal(payload.create_account,false);assert.equal(payload.name,'Borrador');
  for(const key of ['company_id','user_id','password','role_id','license','contract_exempt'])assert.equal(Object.hasOwn(payload,key),false,key);
});

test('conductor: formulario de licencia aparece por rol y payload conserva clases al confirmar',async()=>{
  const s=surface();await s.mount();await s.click('new');
  await s.submit('wizard',{name:'Ana',rut:'12345678-5',birth_date:'1990-01-01',email:'a@example.test',job_title:''});
  await s.submit('wizard',{contract_type:'indefinite',contract_start:'2026-01-01'});
  s.change('create_account',{create_account:'on'});s.change('role_id',{create_account:'on',role_id:'2'});assert.match(s.root.innerHTML,/name="classes"/);
  await s.submit('wizard',{create_account:'on',role_id:'2',password:'password-long',classes:['A5','CR'],printed_expiry:'2026-12-31'});
  await s.submit('wizard',{});const payload=JSON.parse(posts(s)[0].options.body);
  assert.deepEqual(payload.license.classes,['A5','CR']);assert.equal(payload.role_id,'2');assert.equal(payload.contract.type,'indefinite');assert.equal(payload.contract.end_date,null);
});

test('cambiar a no conductor elimina licencia del alta y el borrador no toca localStorage',async()=>{
  const s=surface();await s.mount();await s.click('new');await s.submit('wizard',{name:'Ana',rut:'12345678-5',birth_date:'1990-01-01',email:'a@example.test'});await s.submit('wizard',{contract_type:'indefinite',contract_start:'2026-01-01'});
  s.change('role_id',{create_account:'on',role_id:'2',classes:['A5']});s.change('role_id',{create_account:'on',role_id:'3'});assert.doesNotMatch(s.root.innerHTML,/name="classes"/);
  await s.submit('wizard',{create_account:'on',role_id:'3',password:'password-long'});await s.submit('wizard',{});assert.equal(Object.hasOwn(JSON.parse(posts(s)[0].options.body),'license'),false);
});

test('regularizar id nulo envía membership exacta sin crear cuenta ni modificar rol',async()=>{
  const s=surface();await s.mount();await s.click('regularize',{row:'1'});await s.submit('wizard',{name:'Por regularizar',rut:'12345678-5',birth_date:'1990-01-01'});await s.submit('wizard',{contract_type:'indefinite',contract_start:'2026-01-01'});await s.submit('wizard',{});await s.submit('wizard',{});
  const payload=JSON.parse(posts(s)[0].options.body);assert.equal(payload.membership_id,'82');assert.equal(payload.create_account,false);assert.equal(Object.hasOwn(payload,'role_id'),false);
});

test('vista de solo licencias no expone RUT, salud, contratos, historial ni alta',async()=>{
  const payload={...list(),can_manage:false,can_accounts:false,roles:[],policy:null};
  const s=surface({payload,user:{permissions:['company.licenses.manage']}});await s.mount();
  for(const text of ['ana@example.test','12.345.678-5','Vacaciones','data-action="new"','name="condition"','data-action="notifications"'])assert.equal(s.root.innerHTML.includes(text),false,text);
  await s.click('detail',{id:'11'});assert.match(s.root.innerHTML,/Registrar o renovar licencia/);assert.doesNotMatch(s.root.innerHTML,/Datos personales|Contratos|Condiciones|Historial|12\.345/);
});

test('no conductor no ofrece formulario ni pestaña de licencias',async()=>{
  const person=ficha();person.person.role_code='administrative';const s=surface({person});await s.mount();await s.click('detail',{id:'11'});assert.doesNotMatch(s.root.innerHTML,/data-tab="licenses"/);
});

test('renovación por conductor usa driver_id del servidor y POST licencia sin company/driver_id',async()=>{
  const s=surface();await s.state.renewPersonnelLicenseForDriver('91');assert.match(s.calls.find(call=>call.url.includes('driver_id=')).url,/driver_id=91/);
  assert.match(s.root.innerHTML,/Vigencia efectiva/);await s.submit('license',{classes:['A5'],printed_expiry:'2026-12-31',reason:'Renovación revisada'});
  const request=posts(s)[0];assert.equal(request.url,'/api/company/people/11/licenses');const payload=JSON.parse(request.options.body);assert.equal(Object.hasOwn(payload,'driver_id'),false);assert.equal(Object.hasOwn(payload,'company_id'),false);
});

test('historial muestra antes/después escapado con whitelist, nunca contraseñas ni tokens',async()=>{
  const person=ficha();person.events=[{action:'update',actor_name:'Admin',reason:'Corrección',before_data:{name:'Anterior',password:'SECRET_A',token:'TOKEN_A'},after_data:{name:'<img src=x>',password_hash:'SECRET_B',person:{rut:'12345678-5',password:'SECRET_C'}}}];
  const s=surface({person});await s.mount();await s.click('detail',{id:'11'});await s.click('tab',{tab:'events'});
  assert.match(s.root.innerHTML,/Datos anteriores/);assert.match(s.root.innerHTML,/Datos actualizados/);assert.match(s.root.innerHTML,/Anterior/);assert.match(s.root.innerHTML,/&lt;img src=x&gt;/);
  assert.doesNotMatch(s.root.innerHTML,/SECRET_|TOKEN_A|password_hash|<img/);
});

test('edición, condición, acceso y rol usan endpoints distintos con motivo y sin exención',async()=>{
  const s=surface();await s.mount();await s.click('detail',{id:'11'});
  await s.submit('person',{name:'Ana nueva',rut:'12345678-5',birth_date:'1990-01-01',job_title:'Cargo',reason:'Corrección'});
  await s.submit('condition',{type:'vacation',start_date:'2026-11-01',end_date:'2026-11-10',reason:'Programación'});
  await s.submit('access',{active:'true',reason:'Revisión'});await s.submit('role',{role_id:'3',reason:'Cambio autorizado'});
  assert.deepEqual(posts(s).map(call=>[call.options.method,call.url]),[['PATCH','/api/company/people/11'],['POST','/api/company/people/11/conditions'],['PATCH','/api/company/people/11/access'],['PUT','/api/company/people/11/role']]);
  assert.ok(posts(s).every(call=>!call.options.body.includes('contract_exempt')));
});

test('anular contrato y prolongar/cancelar condición conservan endpoints de historial',async()=>{
  const s=surface();await s.mount();await s.click('detail',{id:'11'});
  await s.submit('void-contract',{reason:'Registro incorrecto'},{id:'5'});
  await s.submit('replace-contract',{reason:'Cambio a indefinido',contract_type:'indefinite',contract_start:'2026-01-01'},{id:'5'});
  await s.submit('extend-condition',{end_date:'2026-11-02',reason:'Prórroga autorizada'},{id:'6'});
  await s.submit('cancel-condition',{reason:'Cancelación autorizada'},{id:'6'});
  assert.deepEqual(posts(s).map(call=>call.url),['/api/company/people/11/contracts/5/void','/api/company/people/11/contracts/5/replace','/api/company/people/11/conditions/6/extend','/api/company/people/11/conditions/6/cancel']);
});

test('readiness pendiente no ofrece activación; cero pendientes exige contraseña y confirmación',async()=>{
  const s=surface();await s.mount();await s.click('readiness');assert.doesNotMatch(s.root.innerHTML,/data-form="activate"/);assert.match(s.root.innerHTML,/Regularizar/);
  let ready=false;const z=surface({fetcher:url=>url.includes('/policy/readiness')?{ready,missing:ready?0:1,issues:[]}:undefined});await z.mount();ready=true;await z.click('readiness');assert.match(z.root.innerHTML,/data-form="activate"/);
  await z.submit('activate',{password:'secret'});assert.equal(posts(z).length,0);
  await z.submit('activate',{password:'secret',confirm:'on'});assert.equal(posts(z)[0].url,'/api/company/people/policy/activate');assert.deepEqual(JSON.parse(posts(z)[0].options.body),{password:'secret'});
});

test('notificaciones se escapan y marcar leída usa el ID exacto',async()=>{
  const s=surface();await s.mount();await s.click('notifications');assert.match(s.root.innerHTML,/Ver ficha/);assert.match(s.root.innerHTML,/data-id="11"/);assert.match(s.root.innerHTML,/11:00/);
  await s.click('read-notification',{id:'9'});assert.equal(posts(s)[0].url,'/api/company/people/notifications/9/read');await s.click('detail',{id:'11'});assert.match(s.root.innerHTML,/Datos personales/);
});

test('RUT se formatea al ingresar conservando posición del cursor y anuncia DV incorrecto al salir',async()=>{
  const s=surface();await s.mount();await s.click('new');
  const input={name:'rut',value:'123456785',selectionStart:9,attrs:{},removeAttribute(key){delete this.attrs[key];},setAttribute(key,value){this.attrs[key]=value;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
  s.root.events.input({target:input});assert.equal(input.value,'12.345.678-5');assert.equal(input.selectionStart,input.value.length);
  input.value='12.345.678-0';s.root.events.focusout({target:input});assert.equal(input.attrs['aria-invalid'],'true');assert.equal(s.root.querySelector('[data-rut-error]').hidden,false);
  assert.match(s.root.querySelector('[data-rut-error]').textContent,/dígito verificador/);assert.equal(posts(s).length,0);
});

test('asociación se conserva en filas de conductor con y sin perfil y nunca crea otra entidad',async()=>{
  const payload=list();payload.rows.push({id:null,user_id:'73',membership_id:'83',name:'Sin ficha',role_code:'driver',driver_id:null});
  const s=surface({payload}),associated=[];s.state.associateUserDriver=async userId=>associated.push(userId);await s.mount();
  assert.match(s.root.innerHTML,/Ver asociación/);assert.match(s.root.innerHTML,/Asociar conductor/);
  await s.click('associate-driver',{row:'0'});await s.click('associate-driver',{row:'2'});assert.deepEqual(associated,['71','73']);assert.equal(posts(s).length,0);
  await s.click('regularize',{row:'2'});assert.match(s.root.innerHTML,/Primero asocia la ficha/);await s.click('associate-driver',{user:'73'});assert.deepEqual(associated,['71','73','73']);
});

test('plataforma owner sin permisos empresariales explícitos no obtiene menú Personas',()=>{
  const s=surface({user:{actor_type:'platform',platform_membership_id:1,ownership_role:'primary',ownership_active:true,permissions:['platform.users.manage']}});
  s.state.localStorage.getItem=()=> '10';s.loadAdmin();assert.equal(s.nav.children.find(button=>button.dataset.v==='companyPeople').hidden,true);
});

test('administrative redirige solo una vez desde dashboard inicial sin apropiarse de otra vista',async()=>{
  const s=surface({user:{role_code:'administrative',permissions:['company.people.read','company.people.manage']}});
  const dashboard=element();dashboard.dataset.v='dashboard';dashboard.classList.add('active');s.nav.children.push(dashboard);
  s.state.document.querySelector=()=>s.nav.children.find(button=>button.classList.contains('active'));
  s.loadAdmin();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.nodes.title.textContent,'Personas y accesos');
  const before=s.calls.filter(call=>call.url.includes('/people?')).length;s.state.renderAdminNavigation(s.state.Auth.user);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.calls.filter(call=>call.url.includes('/people?')).length,before);
});

test('respuesta tardía no restaura datos en una sesión distinta',async()=>{
  let release;const s=surface({fetcher:url=>url.includes('/people?')?new Promise(resolve=>{release=resolve;}):undefined});
  const pending=s.mount();s.state.Auth.token='session-B';release({rows:defaultRows,total:2});await pending;
  assert.doesNotMatch(s.root.innerHTML,/Ana &lt;script&gt;/);
});

test('navegación se muestra a administrative y operations sin users.manage; companyPeople limpia admin y título',async()=>{
  for(const permission of ['company.people.read','company.people.manage','company.licenses.manage']){
    const s=surface({user:{permissions:[permission]}});s.loadAdmin();const people=s.nav.children.find(button=>button.dataset.v==='companyPeople');assert.equal(people.hidden,false);
    assert.equal(s.nav.children.find(button=>button.dataset.v==='configuration').hidden,true);
    await people.onclick();assert.equal(s.nodes.title.textContent,'Personas y accesos');assert.equal(people.classList.contains('active'),true);
  }
  const s=surface({user:{permissions:[]}});s.loadAdmin();assert.equal(s.nav.children.find(button=>button.dataset.v==='companyPeople').hidden,true);
});

test('Mi empresa usuarios delega al renderer nuevo; plataforma conserva su tabla',async()=>{
  const s=surface();s.loadAdmin();s.state.adminSurface='company';await s.state.adminTab('users');assert.match(s.root.innerHTML,/Personas y accesos/);
  const p=surface({user:{actor_type:'platform',platform_membership_id:1,permissions:['platform.users.manage']},fetcher:url=>url==='/api/users'?[]:undefined});p.loadAdmin();p.state.adminSurface='platform';await p.state.adminTab('users');assert.match(p.nodes['admin-panel'].innerHTML,/Usuarios de plataforma y empresas/);
});

test('bootstrap requiere selección explícita y motivo; cambiar rol retira flag y motivo',async()=>{
  const s=surface({user:{actor_type:'platform',platform_membership_id:1,permissions:['platform.users.manage']},fetcher:url=>url==='/api/company-roles'?roles:url==='/api/platform-roles'?[{id:9,code:'platform_superadmin',name:'Plataforma'}]:url==='/api/companies'?[{id:10,legal_name:'Empresa A'}]:url==='/api/users'?[]:undefined});
  s.state.close=()=>{};s.state.alert=message=>assert.fail(message);s.loadAdmin();s.state.adminSurface='platform';
  const scope=element(),role=element(),company=element();scope.value='COMPANY';role.options=[{value:'1',dataset:{scope:'COMPANY',code:'company_admin'}},{value:'3',dataset:{scope:'COMPANY',code:'administrative'}},{value:'9',dataset:{scope:'PLATFORM',code:'platform_superadmin'}}];
  const controls={scope,role_id:role,company_id:company};s.state.document.querySelector=selector=>controls[selector.match(/name="([^"]+)"/)?.[1]];
  await s.state.newAdminUser();const f=s.nodes.form,fields=f.querySelector('[data-bootstrap-fields]'),check=f.querySelector('[name="bootstrap_exempt"]'),reason=f.querySelector('[name="bootstrap_exemption_reason"]');
  assert.equal(fields.hidden,false);assert.equal(reason.disabled,true);check.checked=true;check.events.change();assert.equal(reason.required,true);
  f.values={name:'Admin',email:'admin@example.test',password:'password-long',scope:'COMPANY',role_id:'1',company_id:'10'};
  await f.onsubmit({preventDefault(){}});assert.equal(posts(s).length,0);
  reason.value='Administrador inicial autorizado';await f.onsubmit({preventDefault(){}});let body=JSON.parse(posts(s)[0].options.body);assert.equal(body.bootstrap_exempt,true);assert.equal(body.bootstrap_exemption_reason,'Administrador inicial autorizado');
  role.value='3';role.events.change();assert.equal(fields.hidden,true);assert.equal(check.checked,false);assert.equal(reason.value,'');
  f.values.role_id='3';await f.onsubmit({preventDefault(){}});body=JSON.parse(posts(s)[1].options.body);assert.equal(Object.hasOwn(body,'bootstrap_exempt'),false);assert.equal(Object.hasOwn(body,'bootstrap_exemption_reason'),false);
});

test('borrador crea cuenta desde Acceso usando la misma ficha y refresca su membership',async()=>{
  const person=ficha();Object.assign(person.person,{user_id:null,membership_id:null,role_id:null,role_code:null});
  const s=surface({person,fetcher:(url,options)=>{
    if(url==='/api/company/people/11/account'&&options.method==='POST'){
      Object.assign(person.person,{user_id:74,membership_id:84,role_id:3,role_code:'administrative'});return {person:person.person};
    }
  }});
  await s.mount();await s.click('detail',{id:'11'});await s.click('tab',{tab:'access'});
  assert.match(s.root.innerHTML,/data-form="draft-account"/);assert.match(s.root.innerHTML,/misma ficha/);assert.doesNotMatch(s.root.innerHTML,/data-form="wizard"/);
  await s.submit('draft-account',{email:'nueva@example.test',phone:'123456',password:'password-long',role_id:'3'});
  assert.equal(posts(s).length,1);assert.equal(posts(s)[0].url,'/api/company/people/11/account');
  assert.deepEqual(JSON.parse(posts(s)[0].options.body),{email:'nueva@example.test',phone:'123456',password:'password-long',role_id:'3'});
  assert.match(s.root.innerHTML,/data-form="access"/);assert.doesNotMatch(s.root.innerHTML,/data-form="draft-account"/);
});

test('cuenta de conductor desde borrador exige y envía licencia solo para ese rol',async()=>{
  const person=ficha();Object.assign(person.person,{user_id:null,membership_id:null,role_code:null});
  const s=surface({person});await s.mount();await s.click('detail',{id:'11'});await s.click('tab',{tab:'access'});
  const form=s.change('role_id',{role_id:'2'},'draft-account');assert.match(form.querySelector('[data-account-license]').innerHTML,/name="classes"/);
  const invalid=await s.submit('draft-account',{email:'a@example.test',password:'password-long',role_id:'2'});
  assert.match(invalid.querySelector('[data-error]').textContent,/clase/);assert.equal(posts(s).length,0);
  await s.submit('draft-account',{email:'a@example.test',password:'password-long',role_id:'2',classes:['A5'],printed_expiry:'2026-12-31'});
  assert.equal(posts(s)[0].url,'/api/company/people/11/account');assert.deepEqual(JSON.parse(posts(s)[0].options.body).license,{classes:['A5'],issued_date:null,printed_expiry:'2026-12-31'});
  const other=s.change('role_id',{role_id:'3'},'draft-account');assert.equal(other.querySelector('[data-account-license]').innerHTML,'');
});

test('correo existente conserva formulario y error, sin asociar identidad ni crear otra persona',async()=>{
  const person=ficha();Object.assign(person.person,{user_id:null,membership_id:null,role_code:null});
  const s=surface({person,fetcher:url=>url.endsWith('/account')?{error:'El correo ya existe. No se asocia automáticamente.'}:undefined});
  await s.mount();await s.click('detail',{id:'11'});await s.click('tab',{tab:'access'});
  const form=await s.submit('draft-account',{email:'existente@example.test',password:'password-long',role_id:'3'});
  assert.match(form.querySelector('[data-error]').textContent,/correo ya existe/);assert.match(s.root.innerHTML,/data-form="draft-account"/);
  assert.equal(posts(s).length,1);assert.equal(posts(s)[0].url,'/api/company/people/11/account');
  assert.equal(s.calls.some(call=>call.url==='/api/users'||call.url==='/api/company/people'),false);
});

test('sin permiso de cuentas o con identidad global ya asociada no ofrece crear cuenta de borrador',async()=>{
  for(const existingUser of [null,74]){
    const person=ficha();Object.assign(person.person,{user_id:existingUser,membership_id:null,role_code:null});
    const payload=list();payload.can_accounts=existingUser!==null;
    const s=surface({payload,person});await s.mount();await s.click('detail',{id:'11'});await s.click('tab',{tab:'access'});
    assert.doesNotMatch(s.root.innerHTML,/data-form="draft-account"/);
  }
});
