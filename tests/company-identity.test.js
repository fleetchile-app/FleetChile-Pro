const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function loadIdentity(){const elements={activeCompanyName:{},activeCompanyMark:{},activeCompanyUser:{}};const context={Auth:{user:null},document:{getElementById:id=>elements[id]||null,querySelector:()=>null},localStorage:{getItem(){return''},setItem(){},removeItem(){}},fetch(){},Headers};context.window=context;context.addEventListener=()=>{};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','auth.js'),'utf8'),context);return {context,elements}}

test('selector excluye inactivas y restaura empresa anterior si el cambio es rechazado',async()=>{
 const {context,elements}=loadIdentity();let stored='10',reloaded=0;
 elements.companyContextControl={appendChild(select){elements[select.id]=select;}};
 context.document.createElement=()=>({value:'',selectedIndex:0,options:[],setAttribute(){},after(el){elements[el.id]=el;},set innerHTML(html){this.options=[...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m=>({value:m[1],text:m[2]}));},set value(v){this._value=v;this.selectedIndex=this.options.findIndex(o=>o.value===v);},get value(){return this._value||'';}});
 context.localStorage.getItem=()=>stored;context.localStorage.setItem=(k,v)=>stored=v;context.localStorage.removeItem=()=>stored='';context.location={reload(){reloaded++;}};
 context.Auth.request=async path=>{if(path==='/api/companies')return [{id:10,legal_name:'R & S',active:true},{id:20,legal_name:'Inactiva QA',active:false},{id:30,legal_name:'Otra QA',active:true}];throw Error('Empresa no encontrada');};
 await context.renderActiveIdentity({id:1,name:'Owner',actor_type:'platform',platform_membership_id:1,role_code:'platform_superadmin'});
 const select=elements.companyContextSelect;assert.equal(select.options.some(o=>o.value==='20'),false);
 select.value='30';await select.onchange();assert.equal(select.value,'10');assert.equal(elements.activeCompanyName.textContent,'R & S');assert.equal(stored,'10');assert.equal(reloaded,0);assert.match(elements.companyContextError.textContent,/No se cambió de empresa/);
});

test('identidad activa usa company_name real, usuario y rol sin alterar company_id',()=>{const {context,elements}=loadIdentity();const user={id:7,name:'Ana Pérez',company_id:10,company_name:'Transportes del Sur',role_code:'operations'};context.renderActiveIdentity(user);assert.equal(elements.activeCompanyName.textContent,'Transportes del Sur');assert.equal(elements.activeCompanyMark.textContent,'TD');assert.equal(elements.activeCompanyUser.textContent,'Usuario: Ana Pérez\nRol: Operaciones');assert.equal(user.company_id,10)});

test('cabecera identifica roles conocidos sin asignar privilegios por su etiqueta',()=>{
 for(const [role_code,label] of Object.entries({admin:'Administrador',company_admin:'Administrador de empresa',manager:'Gerente',operations:'Operaciones',maintenance:'Mantención',driver:'Conductor',viewer:'Consulta'})){
  const {context,elements}=loadIdentity(),user={name:'Omar Silva',role_code,company_id:10,permissions:[]};
  context.renderActiveIdentity(user);
  assert.equal(elements.activeCompanyUser.textContent,'Usuario: Omar Silva\nRol: '+label);
  assert.equal(elements.activeCompanyUser.title,'Usuario: Omar Silva · Rol: '+label);
  assert.deepEqual(user.permissions,[]);
 }
});

test('nombre del rol procede de membership activa exacta y no de otra empresa ni rol legacy',()=>{
 const {context,elements}=loadIdentity();
 context.renderActiveIdentity({name:'Ana',actor_type:'company',membership_id:'12',company_id:10,role_code:'company_admin',role_name:'company_admin',legacy_role_code:'admin',
  memberships:[{id:3,active:true,company_id:20,role_code:'manager',role_name:'Gerente otra empresa'},{id:12,active:true,company_id:10,role_code:'company_admin',role_name:'Administración de flota'}]});
 assert.match(elements.activeCompanyUser.textContent,/Rol: Administración de flota/);
 assert.doesNotMatch(elements.activeCompanyUser.textContent,/Gerente otra empresa/);
});

test('membership inactiva o con rol diferente no aporta su nombre',()=>{
 for(const changes of [{active:false},{role_code:'manager'},{company_id:20}]){
  const {context,elements}=loadIdentity();
  context.renderActiveIdentity({name:'Ana',actor_type:'company',membership_id:12,company_id:10,role_code:'driver',role_name:'driver',
   memberships:[{id:12,active:true,company_id:10,role_code:'driver',role_name:'Etiqueta incorrecta',...changes}]});
  assert.match(elements.activeCompanyUser.textContent,/Rol: Conductor/);
 }
});

test('rol personalizado conserva nombre configurado y texto no ejecuta HTML',()=>{
 const {context,elements}=loadIdentity();
 context.renderActiveIdentity({name:'<img src=x>',company_id:10,role_code:'custom_role',role_name:'Administrativo'});
 assert.equal(elements.activeCompanyUser.textContent,'Usuario: <img src=x>\nRol: Administrativo');
 assert.equal(elements.activeCompanyUser.innerHTML,undefined);
 context.renderActiveIdentity({name:'Ana',role_code:'custom_role'});
 assert.match(elements.activeCompanyUser.textContent,/Rol: custom_role/);
});

test('identidad no resuelta no aparenta un rol legacy de administrador',()=>{
 const {context,elements}=loadIdentity();context.renderActiveIdentity({name:'Ana',actor_type:'unresolved',role_code:'admin',role_name:'Administrador'});
 assert.match(elements.activeCompanyUser.textContent,/Rol: Rol no determinado/);
});

test('admin sin empresa no recibe una empresa inventada',()=>{const {context,elements}=loadIdentity();context.renderActiveIdentity({id:1,name:'Administrador',company_id:null,company_name:null,role_code:'admin'});assert.equal(elements.activeCompanyName.textContent,'Administración transversal');assert.equal(elements.activeCompanyMark.textContent,'AT')});

test('selector de plataforma se crea en cabecera y mantiene cambio empresarial autenticado',async()=>{
 const {context,elements}=loadIdentity();let stored='20',reloaded=0;const requests=[];
 elements.companyContextControl={appendChild(select){elements[select.id]=select}};
 context.document.createElement=()=>({value:'',selectedIndex:0,options:[],setAttribute(){},set innerHTML(html){this.options=[...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(match=>({value:match[1],text:match[2]}))},set value(value){this._value=value;this.selectedIndex=this.options.findIndex(option=>option.value===value)},get value(){return this._value||''}});
 context.localStorage.getItem=()=>stored;context.localStorage.setItem=(key,value)=>stored=value;context.localStorage.removeItem=()=>stored='';
 context.location={reload(){reloaded++}};
 context.Auth.request=async(path,options)=>{requests.push({path,options});return path==='/api/companies'?[{id:10,legal_name:'Empresa Uno'},{id:20,legal_name:'Empresa Dos'}]:{}};
 await context.renderActiveIdentity({id:1,name:'Owner',actor_type:'platform',platform_membership_id:2,role_code:'platform_superadmin',role_name:'platform_superadmin',platform_memberships:[{id:2,active:true,role_code:'platform_superadmin',role_name:'Superadmin de plataforma'}]});
 const select=elements.companyContextSelect;
 assert.ok(select);assert.equal(select.value,'20');assert.equal(elements.activeCompanyName.textContent,'Empresa Dos');
 assert.match(elements.activeCompanyUser.textContent,/Rol: Superadmin de plataforma/);
 select.value='10';await select.onchange();
 assert.equal(requests[1].path,'/api/auth/company-context');assert.deepEqual(JSON.parse(requests[1].options.body),{company_id:10});assert.equal(stored,'10');assert.equal(reloaded,1);
});
