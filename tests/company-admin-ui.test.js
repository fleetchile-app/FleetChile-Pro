const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function surface({platform=false,memberId='12',memberActive=true,accountActive=true,fail=false,confirm=true}={}){
 const user=platform?{id:1,actor_type:'platform',platform_membership_id:2,permissions:['platform.users.manage','platform.companies.manage']}:{id:1,actor_type:'company',company_id:10,membership_id:11,permissions:['company.users.manage','dashboard.read']};
 const row={id:2,name:'Usuario compartido',company_id:10,active:accountActive,modern_membership_id:memberId,modern_membership_active:memberActive,modern_role_code:'operations',modern_company_name:'Empresa A'};
 const elements={},requests=[],alerts=[],confirmations=[];
 const element=()=>({hidden:false,innerHTML:'',dataset:{},appendChild(){},setAttribute(){},classList:{add(){},remove(){},toggle(){}}});
 const context={Auth:{user},document:{getElementById:id=>elements[id]||(elements[id]=element()),createElement:element,querySelectorAll:()=>[]},alert:message=>alerts.push(message),confirm:message=>{confirmations.push(message);return confirm},fetch:async(url,options={})=>{
  requests.push({url,options});let data={};
  if(url==='/api/auth/me')data={user};
  else if(url==='/api/users')data=[row];
  else if(url==='/api/core/summary')data={users:1,clients:1,active_trips:0};
  else if(url.startsWith('/api/user-memberships/')&&options.method){
   if(fail)return {ok:false,json:async()=>({error:'Empresa no autorizada'})};
   row.modern_membership_active=JSON.parse(options.body).active;data={id:memberId,active:row.modern_membership_active};
  }
  return {ok:true,json:async()=>data};
 }};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../public/admin.js'),'utf8'),context);
 return {context,elements,requests,alerts,confirmations,row};
}

test('empresa desactiva membership propia, no la cuenta global del usuario compartido',async()=>{
 const s=surface();await s.context.configuration();await s.context.adminTab('users');
 assert.match(s.elements['admin-panel'].innerHTML,/toggleCompanyMembership\('12',false\)/);
 assert.doesNotMatch(s.elements['admin-panel'].innerHTML,/onclick="toggleAdminUser/);
 await s.context.toggleCompanyMembership('12',false);
 const writes=s.requests.filter(request=>request.options.method);
 assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/user-memberships/12');
 assert.deepEqual(JSON.parse(writes[0].options.body),{active:false});assert.equal(s.row.active,true);
 assert.match(s.elements['admin-panel'].innerHTML,/Activar acceso empresa/);
 assert.match(s.confirmations[0],/otras empresas no se modificarán/);
});

test('membership inactiva puede reactivarse sin modificar bloqueo global',async()=>{
 const s=surface({memberActive:false,accountActive:false});await s.context.configuration();await s.context.adminTab('users');
 assert.match(s.elements['admin-panel'].innerHTML,/Cuenta bloqueada por plataforma/);
 await s.context.toggleCompanyMembership('12',true);
 assert.equal(s.row.modern_membership_active,true);assert.equal(s.row.active,false);
 assert.match(s.elements['admin-panel'].innerHTML,/Cuenta bloqueada por plataforma/);
});

test('sin membership no ofrece mutación global como sustituto',async()=>{
 const s=surface({memberId:null});await s.context.configuration();await s.context.adminTab('users');
 assert.match(s.elements['admin-panel'].innerHTML,/Sin membership empresarial/);
 assert.doesNotMatch(s.elements['admin-panel'].innerHTML,/onclick="toggleCompanyMembership|onclick="toggleAdminUser/);
});

test('plataforma conserva gestión global diferenciada de acceso empresarial',async()=>{
 const s=surface({platform:true});await s.context.platformAdministration('users');
 assert.match(s.elements['admin-panel'].innerHTML,/Desactivar cuenta/);
 assert.match(s.elements['admin-panel'].innerHTML,/toggleAdminUser\(2,false\)/);
 const before=s.requests.length;await s.context.toggleCompanyMembership('12',false);assert.equal(s.requests.length,before);
});

test('cancelar confirmación o usar id inválido no envía cambios',async()=>{
 const s=surface({confirm:false});await s.context.configuration();await s.context.toggleCompanyMembership('12',false);
 for(const id of [null,undefined,0,-1,'12/otro'])await s.context.toggleCompanyMembership(id,false);
 assert.equal(s.requests.some(request=>request.options.method),false);
});

test('denegación del servidor se muestra sin afirmar cambio de estado',async()=>{
 const s=surface({fail:true});await s.context.configuration();await s.context.toggleCompanyMembership('12',false);
 assert.equal(s.row.modern_membership_active,true);assert.equal(s.alerts[0],'Empresa no autorizada');
});

test('id BIGINT de membership no pierde precisión al enviarse',async()=>{
 const id='9007199254740993',s=surface({memberId:id});await s.context.configuration();await s.context.adminTab('users');
 assert.match(s.elements['admin-panel'].innerHTML,new RegExp("toggleCompanyMembership\\('"+id+"',false\\)"));
 await s.context.toggleCompanyMembership(id,false);
 assert.ok(s.requests.some(request=>request.url==='/api/user-memberships/'+id));
});

test('dashboard ejecutivo propaga rechazo asíncrono hacia la navegación',async()=>{
 const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const start=source.indexOf('const baseKpiDashboard=renderKpiDashboard;'),end=source.indexOf(';dashboard=',start);
 const context={document:{querySelector:()=>({})},renderKpiDashboard:async()=>{throw Error('Permiso requerido: economics.read')}};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 await assert.rejects(context.renderKpiDashboard(),/economics.read/);
});
