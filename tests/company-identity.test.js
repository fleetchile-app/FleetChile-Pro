const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function loadIdentity(){const elements={activeCompanyName:{},activeCompanyMark:{},activeCompanyUser:{}};const context={Auth:{user:null},document:{getElementById:id=>elements[id]||null,querySelector:()=>null},localStorage:{getItem(){return''},setItem(){},removeItem(){}},fetch(){},Headers};context.window=context;context.addEventListener=()=>{};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','auth.js'),'utf8'),context);return {context,elements}}

test('identidad activa usa company_name real, usuario y fallback visual sin alterar company_id',()=>{const {context,elements}=loadIdentity();const user={id:7,name:'Ana Pérez',company_id:10,company_name:'Transportes del Sur',role_code:'operations'};context.renderActiveIdentity(user);assert.equal(elements.activeCompanyName.textContent,'Transportes del Sur');assert.equal(elements.activeCompanyMark.textContent,'TD');assert.equal(elements.activeCompanyUser.textContent,'Usuario: Ana Pérez');assert.equal(user.company_id,10)});

test('admin sin empresa no recibe una empresa inventada',()=>{const {context,elements}=loadIdentity();context.renderActiveIdentity({id:1,name:'Administrador',company_id:null,company_name:null,role_code:'admin'});assert.equal(elements.activeCompanyName.textContent,'Administración transversal');assert.equal(elements.activeCompanyMark.textContent,'AT')});

test('selector de plataforma se crea en cabecera y mantiene cambio empresarial autenticado',async()=>{
 const {context,elements}=loadIdentity();let stored='20',reloaded=0;const requests=[];
 elements.companyContextControl={appendChild(select){elements[select.id]=select}};
 context.document.createElement=()=>({value:'',selectedIndex:0,options:[],setAttribute(){},set innerHTML(html){this.options=[...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(match=>({value:match[1],text:match[2]}))},set value(value){this._value=value;this.selectedIndex=this.options.findIndex(option=>option.value===value)},get value(){return this._value||''}});
 context.localStorage.getItem=()=>stored;context.localStorage.setItem=(key,value)=>stored=value;context.localStorage.removeItem=()=>stored='';
 context.location={reload(){reloaded++}};
 context.Auth.request=async(path,options)=>{requests.push({path,options});return path==='/api/companies'?[{id:10,legal_name:'Empresa Uno'},{id:20,legal_name:'Empresa Dos'}]:{}};
 await context.renderActiveIdentity({id:1,name:'Owner',actor_type:'platform',platform_membership_id:2});
 const select=elements.companyContextSelect;
 assert.ok(select);assert.equal(select.value,'20');assert.equal(elements.activeCompanyName.textContent,'Empresa Dos');
 select.value='10';await select.onchange();
 assert.equal(requests[1].path,'/api/auth/company-context');assert.deepEqual(JSON.parse(requests[1].options.body),{company_id:10});assert.equal(stored,'10');assert.equal(reloaded,1);
});
