const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/admin.js'),'utf8');

// Real browser handlers with in-memory DOM/network; not PostgreSQL/browser integration.
function surface({confirm=true,memberships=[{id:81,user_id:71,company_id:20}],switchResult={company:{id:20,legal_name:'Empresa B'}},hook,user={}}={}){
  const nodes={},requests=[],opened=[],alerts=[],storage=new Map([['fleet_company_context','10']]),sidebar=[];
  function element(){return {innerHTML:'',textContent:'',hidden:false,value:'',dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;},appendChild(x){sidebar.push(x);},contains(){return false;},classList:{add(){},remove(){},toggle(){}},focus(){}};}
  const actor={id:1,actor_type:'platform',platform_membership_id:2,permissions:['platform.users.manage'],...user};
  const context={Auth:{user:actor,token:'token-A'},document:{getElementById:id=>nodes[id]||(nodes[id]=element()),createElement:element,querySelectorAll:()=>sidebar,querySelector:()=>null,addEventListener(){}},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},confirm:()=>confirm,alert:msg=>alerts.push(msg),
    openCompanyPersonForUser:async uid=>opened.push({uid,company:storage.get('fleet_company_context')}),
    fetch:async(url,options={})=>{
      requests.push({url,options});const custom=await hook?.(url,options,context);
      const result=custom??(url==='/api/auth/me'?{user:actor}:url.includes('/memberships?')?memberships:url==='/api/auth/company-context'?switchResult:
        url==='/api/users'?[{id:71,name:'Ana',email:'a@example.test',modern_company_id:20,company_id:10,modern_role_code:'driver',modern_membership_id:81},
          {id:72,name:'Legacy',email:'b@example.test',company_id:10},{id:73,name:'Plataforma',platform_role_code:'platform_admin',modern_company_id:20}]:{});
      return {ok:!result.error,json:async()=>result};
    }};
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  return {context,nodes,requests,opened,alerts,storage};
}
test('acción empresarial utiliza company moderna explícita, nunca company legacy ni cuenta plataforma',async()=>{
  const s=surface();await s.context.platformAdministration('users');const html=s.nodes['admin-panel'].innerHTML;
  assert.match(html,/openPlatformCompanyUser\('71','20'\)/);assert.doesNotMatch(html,/openPlatformCompanyUser\('71','10'\)|openPlatformCompanyUser\('72'|openPlatformCompanyUser\('73'/);
});
test('confirma y registra contexto antes de abrir usuario, conservando permisos plataforma',async()=>{
  const s=surface();await s.context.openPlatformCompanyUser('71','20');
  const request=s.requests.find(call=>call.url==='/api/auth/company-context');assert.equal(request.options.method,'POST');assert.deepEqual(JSON.parse(request.options.body),{company_id:'20'});
  assert.deepEqual(s.opened,[{uid:'71',company:'20'}]);assert.equal(s.nodes.activeCompanyName.textContent,'Empresa B');
  assert.deepEqual(s.context.Auth.user.permissions,['platform.users.manage']);assert.equal(s.context.Auth.user.actor_type,'platform');
  assert.ok(s.requests.findIndex(x=>x.url.includes('/memberships?'))<s.requests.indexOf(request));
});
test('cancelar confirmación no registra cambio ni abre ficha',async()=>{
  const s=surface({confirm:false});await s.context.openPlatformCompanyUser('71','20');assert.equal(s.storage.get('fleet_company_context'),'10');assert.deepEqual(s.opened,[]);assert.equal(s.requests.some(x=>x.options.method),false);
});
for(const memberships of [[{id:81,user_id:71,company_id:30}],[{id:81,user_id:72,company_id:20}],[],[{id:81,user_id:71,company_id:20},{id:82,user_id:71,company_id:20}]])test('membership ausente, ajena o ambigua impide cambio: '+JSON.stringify(memberships),async()=>{
  const s=surface({memberships});await s.context.openPlatformCompanyUser('71','20');assert.equal(s.requests.some(x=>x.options.method),false);assert.equal(s.storage.get('fleet_company_context'),'10');assert.deepEqual(s.opened,[]);
});
for(const switchResult of [{error:'No autorizado'},{company:{id:30}}])test('rechazo o contexto distinto del servidor no habilita edición: '+JSON.stringify(switchResult),async()=>{
  const s=surface({switchResult});await s.context.openPlatformCompanyUser('71','20');assert.deepEqual(s.opened,[]);assert.equal(s.storage.get('fleet_company_context'),'10');assert.equal(s.alerts.length,1);
});
test('pérdida de sesión durante verificación no abre ni cambia contexto',async()=>{
  const s=surface({hook:(url,options,context)=>{if(url.includes('/memberships?'))context.Auth.token='token-B';}});
  await s.context.openPlatformCompanyUser('71','20');assert.deepEqual(s.opened,[]);assert.equal(s.requests.some(x=>x.options.method),false);
});
test('owner inactivo y rol nominal no obtienen soporte',async()=>{
  const s=surface({user:{permissions:[],ownership_role:'primary',ownership_active:false}});await s.context.openPlatformCompanyUser('71','20');assert.equal(s.requests.some(x=>x.url.includes('/memberships?')),false);assert.deepEqual(s.opened,[]);
});
test('cambio concurrente de empresa durante verificación impide registrar otro cambio',async()=>{
  let s;s=surface({hook:url=>{if(url.includes('/memberships?'))s.storage.set('fleet_company_context','30');}});
  await s.context.openPlatformCompanyUser('71','20');assert.deepEqual(s.opened,[]);assert.equal(s.requests.some(x=>x.options.method),false);assert.equal(s.storage.get('fleet_company_context'),'30');
});
test('doble clic concurrente registra una sola selección y apertura',async()=>{
  const s=surface();await Promise.all([s.context.openPlatformCompanyUser('71','20'),s.context.openPlatformCompanyUser('71','20')]);
  assert.equal(s.requests.filter(x=>x.url==='/api/auth/company-context').length,1);assert.equal(s.opened.length,1);
});
