'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','public','fleet-profiles.js'),'utf8');
const permissions=['fleet.manage','dashboard.read','drivers.manage','gps.read','company.people.read'];
const element=()=>({innerHTML:'',textContent:'',dataset:{},hidden:false,isConnected:true,focus(){this.focused=true;}});
function surface(responses={},options={}){
 const root=element(),host=element(),box=element(),events={},calls=[],downloads=[];
 root.addEventListener=(kind,fn)=>{events[kind]=fn;};
 root.querySelector=selector=>selector.includes('error')?box:element();
 const auth={token:'session',user:{id:1,company_id:10,permissions,...options.user}};
 const storage=new Map(options.context?[['fleet_company_context',String(options.context)]]:[]);
 const sandbox={console,Blob,setTimeout:fn=>{fn();return 0;},localStorage:{getItem:key=>storage.get(key)||null},
  URL:{createObjectURL:()=> 'blob:pdf',revokeObjectURL(){}},
  document:{getElementById:key=>key==='app'?host:key==='fleet-profiles-root'?root:null,
   createElement:()=>({click(){downloads.push(this.download);}})},
  FormData:class{constructor(form){this.values=form.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}}};
 sandbox.fetch=async(url,opt={})=>{
  calls.push({url,opt});const key=url.replace('/api/','').split('?')[0];
  const found=responses[key]??{};
  const value=typeof found==='function'?await found(opt):found;
  return {ok:!value?.testError,status:value?.testError?500:200,json:async()=>value,blob:async()=>new Blob(['%PDF-1.4'])};
 };
 sandbox.window=sandbox;sandbox.trucks=()=>{};sandbox.drivers=()=>{};
 sandbox.openForm=kind=>{sandbox.legacyForm=kind;};sandbox.openTruck=id=>{sandbox.gpsId=id;};
 sandbox.companyPeople=()=>{sandbox.peopleOpened=true;};
 const context=vm.createContext(sandbox);
 if(options.lexical){sandbox.testAuth=auth;vm.runInContext('const Auth=testAuth;',context);delete sandbox.testAuth;}
 else sandbox.Auth=auth;
 vm.runInContext(source,context);
 return {sandbox,auth,root,box,calls,downloads,
  mount:kind=>sandbox[kind||'trucks'](),
  action:(action,id)=>events.click({target:{closest:()=>({dataset:{action,id:String(id??'')}})}}),
  submit:(kind,values,id)=>events.submit({preventDefault(){},target:{dataset:{form:kind,id:id?String(id):''},values,querySelector:()=>box}})};
}
const vehicle={id:7,brand:'Volvo',model:'FH',patente:'BBJJ25',tipo:'Tractocamión',capacidad_t:'18.5',profile_version:4,
 document_expiries:{circulation:{expires_at:'2027-03-31',status:'Vigente'},soap:{expires_at:'2027-03-31',status:'Vigente'},inspection:{expires_at:'2027-06-30',status:'Vigente'}},ready:true};
function formValues(html){
 const values={};for(const match of html.matchAll(/<input\b([^>]*)>/g)){
  const name=/name="([^"]+)"/.exec(match[1]),value=/value="([^"]*)"/.exec(match[1]);if(name)values[name[1]]=value?.[1]||'';
 }
 for(const match of html.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
  const selected=/<option value="([^"]*)" selected/.exec(match[2])||/<option value="([^"]*)"/.exec(match[2]);values[match[1]]=selected?.[1]||'';
 }
 return values;
}
test('navegación real y Auth lexical funcionan sin window.Auth; GPS conserva drawer existente',async()=>{
 const s=surface({'fleet/vehicles':[vehicle]},{lexical:true});assert.equal(s.sandbox.Auth,undefined);
 await s.mount();assert.match(s.root.innerHTML,/BBJJ25/);
 await s.action('vehicle-gps',7);assert.equal(s.sandbox.gpsId,'7');
 s.sandbox.openForm('routes');assert.equal(s.sandbox.legacyForm,'routes');
 await s.sandbox.openForm('trucks');assert.match(s.root.innerHTML,/Nuevo vehículo/);
 assert.ok(s.calls.some(c=>c.opt.headers.Authorization==='Bearer session'));
});
test('edición conserva capacidad, tipo legacy y fechas canónicas al enviar PATCH sin cambios',async()=>{
 let body;
 const s=surface({'fleet/vehicles':[vehicle],'fleet/vehicles/7':opt=>{if(opt.method==='PATCH')body=JSON.parse(opt.body);return vehicle;}});
 await s.mount();await s.sandbox.fleetProfiles.vehicleEditor(7);
 assert.doesNotMatch(s.root.innerHTML,/name="(?:driver|location)"/);
 const values=formValues(s.root.innerHTML);assert.equal(values.capacity_t,'18.5');
 assert.equal(values.circulation_expiry,'2027-03-31');assert.equal(values.soap_expiry,'2027-03-31');assert.equal(values.inspection_expiry,'2027-06-30');
 assert.equal(values.tipo,'Tractocamión');
 await s.submit('vehicle',values,7);
 assert.equal(body.capacity_t,18.5);assert.equal(body.profile_version,'4');
 for(const key of ['circulation_expiry','soap_expiry','inspection_expiry'])if(Object.hasOwn(body,key))assert.equal(body[key],values[key],'PATCH no puede borrar un documento sin cambios');
 assert.equal({...vehicle,...body}.tipo,'Tractocamión');
});
test('formulario exige identidad pero admite capacidad y documentos opcionales',async()=>{
 const s=surface();await s.mount();await s.sandbox.openForm('trucks');
 assert.match(s.root.innerHTML,/name="brand"[^>]*required/);assert.match(s.root.innerHTML,/name="model"[^>]*required/);
 assert.match(s.root.innerHTML,/name="circulation_expiry"/);assert.doesNotMatch(s.root.innerHTML,/name="capacity_t"[^>]*required/);
});
test('paginación de 101 vehículos inicia en cero y permite avanzar y filtrar tipos con tildes',async()=>{
 const list=Array.from({length:101},(_,i)=>({...vehicle,id:i+1,patente:'PAT-'+String(i+1).padStart(3,'0'),tipo:'Camión'}));
 const s=surface({'fleet/vehicles':list});await s.mount();
 assert.match(s.root.innerHTML,/PAT-001/);assert.match(s.root.innerHTML,/PAT-025/);assert.doesNotMatch(s.root.innerHTML,/PAT-026/);
 await s.action('vehicle-next');assert.match(s.root.innerHTML,/PAT-026/);assert.doesNotMatch(s.root.innerHTML,/PAT-001/);
 await s.submit('filters',{q:'PAT-101',type:'camion',status:''});assert.match(s.root.innerHTML,/PAT-101/);
});
test('candidatos reales excluyen selección bloqueada y no usan user_id como driver_id',async()=>{
 const s=surface({'fleet/drivers':{rows:[]},'fleet/drivers/candidates':{rows:[
  {user_id:20,driver_id:null,name:'Nueva Ana',rut:'12345678-5',eligible:true,license_summary:'A5',effective_expiry:'2027-12-31'},
  {user_id:21,driver_id:9,name:'Luis',eligible:false,reasons:['LICENSE_EXPIRED_OR_MISSING']}]}
 });await s.mount('drivers');assert.doesNotMatch(s.root.innerHTML,/data-action="driver-detail" data-id="20"/);
 await s.sandbox.openForm('drivers');assert.match(s.root.innerHTML,/value="20"/);assert.doesNotMatch(s.root.innerHTML,/value="21"/);
 assert.match(s.root.innerHTML,/A5 · Vence 31-12-2027/);
 assert.doesNotMatch(s.root.innerHTML,/name="(?:name|rut)"/);await s.action('personas');assert.equal(s.sandbox.peopleOpened,true);
});
test('detalle plano muestra licencia, suspensiones y fechas del evento; PDF autenticado usa drivers.manage',async()=>{
 const s=surface({'fleet/drivers/8':{id:8,name:'Ana',rut:'12345678-5',status:'Activo',
  licenses:[{current:true,classes:['A5'],effective_expiry:'2027-12-31'}],
  trips:[{trip_number:'V-001',status:'Completado'}],
  conditions:[{type:'suspended',start_date:'2025-01-01',end_date:'2025-01-02'}],
  events:[{event_type:'fine',event_date:'2026-01-01',created_at:'2026-02-01',amount_clp:1000,notes:'Nota'}]}
 },{user:{permissions:['drivers.manage']},context:10});
 await s.mount('drivers');await s.sandbox.fleetProfiles.driverDetail(8);
 assert.match(s.root.innerHTML,/Ana/);assert.match(s.root.innerHTML,/A5/);assert.match(s.root.innerHTML,/12345678-5/);
 assert.match(s.root.innerHTML,/Suspensión/);assert.match(s.root.innerHTML,/01-01-2026/);assert.doesNotMatch(s.root.innerHTML,/01-02-2026/);
 await s.action('driver-pdf',8);assert.equal(s.downloads.length,1);
 const call=s.calls.find(c=>c.url.endsWith('/8/pdf'));assert.equal(call.opt.headers.Authorization,'Bearer session');assert.equal(call.opt.headers['X-Company-Context'],'10');
});
test('evento sin término opcional no envía fecha vacía y exige monto y notas',async()=>{
 let body;
 const s=surface({'fleet/drivers/8':{id:8,name:'Ana'},'fleet/drivers/8/events':opt=>{body=JSON.parse(opt.body);return {id:1};}});
 await s.mount('drivers');await s.sandbox.fleetProfiles.driverDetail(8);
 await s.submit('event',{event_type:'fine',event_date:'2026-10-22',ends_on:'',amount_clp:'1000',notes:'Registro'},8);
 assert.equal(body.amount_clp,1000);assert.equal(Object.hasOwn(body,'ends_on'),false);
 body=null;await s.submit('event',{event_type:'fine',event_date:'2026-10-22',ends_on:'',amount_clp:'',notes:'Registro'},8);
 assert.equal(body,null);assert.match(s.box.textContent,/monto/i);
});
test('consulta no ofrece ni ejecuta mutaciones de flota ni conductores',async()=>{
 const s=surface({'fleet/vehicles':[vehicle]},{user:{permissions:['dashboard.read']}});await s.mount();
 assert.doesNotMatch(s.root.innerHTML,/data-action="(?:new-vehicle|vehicle-edit)"/);
 await s.action('new-vehicle');await s.sandbox.openForm('drivers');assert.equal(s.calls.length,1);
 await s.action('vehicle-detail',7);assert.match(s.root.innerHTML,/fieldset disabled/);assert.doesNotMatch(s.root.innerHTML,/Guardar vehículo/);
});
test('propietario real requiere contexto; rol nominal o ownership inactivo no concede privilegios',async()=>{
 for(const active of [true,false]){
  const s=surface({'fleet/vehicles':[vehicle]},{context:10,user:{actor_type:'platform',platform_membership_id:2,ownership_role:'primary',ownership_active:active,permissions:[]}});
  await s.mount();assert.equal(s.root.innerHTML.includes('data-action="new-vehicle"'),active);
 }
 const s=surface({'fleet/vehicles':[vehicle]},{user:{actor_type:'platform',platform_membership_id:2,ownership_role:'primary',ownership_active:true,permissions:[]}});await s.mount();assert.equal(s.calls.length,0);
});
test('respuesta anterior no sobrescribe otra vista y errores de carga se hacen visibles',async()=>{
 const s=surface({'fleet/vehicles':{testError:true,error:'Fallo controlado'}});await s.mount();assert.equal(s.box.hidden,false);assert.match(s.box.textContent,/Fallo controlado/);
});
