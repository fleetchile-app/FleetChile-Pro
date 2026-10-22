const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// DOM mínimo: ejecuta los handlers reales, sin backend ni ubicación externa.
function element(html=''){
 const cache=new Map();
 return {
  _html:html,hidden:false,disabled:false,dataset:{},open:true,
  get innerHTML(){return this._html},set innerHTML(value){this._html=value;cache.clear()},
  querySelector(selector){
   if(cache.has(selector))return cache.get(selector);
   for(const match of this._html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
    const [,tag,attrs]=match;
    const id=attrs.match(/id="([^"]*)"/)?.[1],classes=attrs.match(/class="([^"]*)"/)?.[1]?.split(' ')||[];
    const data=selector.match(/^\[([^\]]+)\]$/)?.[1];
    if(selector==='#'+id||selector[0]==='.'&&classes.includes(selector.slice(1))||data&&attrs.includes(data)||selector===tag){
     const start=match.index+match[0].length,end=this._html.indexOf('</'+tag+'>',start);
     const child=element(this._html.slice(start,end<0?start:end));
     cache.set(selector,child);return child;
    }
   }
   return null;
  },
  querySelectorAll(){return []},
  addEventListener(type,handler){this['on'+type]=handler},
  focus(){this.focused=true}
 };
}
const driver=fs.readFileSync(require.resolve('../public/driver.js'),'utf8');
const auth=fs.readFileSync(require.resolve('../public/auth.js'),'utf8').split("if(document.addEventListener)")[0];
function surface({user={},fetcher,confirm=true}={}){
 const root=element(),storage=new Map([['fleet_token','token-A'],['fleet_company_context','10']]),calls=[],cleared=[],timers=[];
 const sandbox={
  document:{getElementById:()=>root},navigator:{geolocation:{watchPosition(){return 7},clearWatch:id=>cleared.push(id)}},
  localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  fetch:async(url,options={})=>{
   calls.push({url,options});
   if(fetcher)return fetcher(url,options);
   return {ok:true,status:200,json:async()=>url==='/api/driver/trips'?[]:url==='/api/auth/me'?{user:{...sandbox.Auth.user,must_change_password:false}}:{ok:true}};
  },
  confirm:()=>confirm,AbortController,
  setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length},clearTimeout(){},
  FormData:class{constructor(form){this.form=form}*[Symbol.iterator](){yield* Object.entries(this.form.values||{})}}
 };
 sandbox.window=sandbox;vm.createContext(sandbox);
 vm.runInContext(auth+';window.Auth=Auth;',sandbox);
 sandbox.Auth.user={id:1,name:'Ana Conductor',company_name:'Empresa prueba',email:'ana@example.test',role_code:'driver',driver_id:4,company_id:10,...user};
 vm.runInContext(driver.replace(/\}\)\(\);\s*$/,'window.driverTest={startGps,api,loadTrips,changeStatus};})();'),sandbox);
 return {root,sandbox,storage,calls,cleared,timers};
}

test('conductor tiene identidad escapada, empresa y acciones de cuenta',async()=>{
 const s=surface({user:{name:'<img src=x>',company_name:'Mi empresa'}});
 await s.sandbox.driverBoot({authenticated:true});
 assert.match(s.root.innerHTML,/&lt;img src=x&gt;/);assert.doesNotMatch(s.root.innerHTML,/<img/);
 for(const text of ['Mi cuenta','Mi empresa','ana@example.test','Mis viajes','Actualizar viajes','Cambiar contraseña','Cerrar sesión'])assert.ok(s.root.innerHTML.includes(text),text);
 const account=s.root.querySelector('.driver-account');
 account.onkeydown({key:'Escape'});assert.equal(account.open,false);assert.equal(account.querySelector('summary').focused,true);
});

test('cierre revoca en servidor, limpia token y contexto y regresa al login',async()=>{
 const s=surface();await s.sandbox.driverBoot({authenticated:true});
 await s.root.querySelector('[data-driver-logout]').onclick();
 assert.match(s.root.innerHTML,/Sesión cerrada en este dispositivo/);assert.match(s.root.innerHTML,/Iniciar sesión/);
 assert.equal(s.sandbox.Auth.user,null);assert.equal(s.storage.has('fleet_token'),false);assert.equal(s.storage.has('fleet_company_context'),false);
 const request=s.calls.find(call=>call.url==='/api/auth/logout');
 assert.equal(request.options.method,'POST');assert.equal(request.options.headers.Authorization,'Bearer token-A');
 assert.equal(s.timers[0].ms,8000);
});

test('cancelar salida conserva la sesión',async()=>{
 const s=surface({confirm:false});await s.sandbox.driverBoot({authenticated:true});
 await s.root.querySelector('[data-driver-logout]').onclick();
 assert.equal(s.sandbox.Auth.token,'token-A');assert.equal(s.calls.some(call=>call.url==='/api/auth/logout'),false);
});

test('también permite salir sin conductor asociado o con rol incorrecto',async()=>{
 for(const user of [{driver_id:null},{role_code:'operations'}]){
  const s=surface({user});await s.sandbox.driverBoot({authenticated:true});
  assert.ok(s.root.querySelector('[data-driver-logout]'));assert.equal(s.calls.length,0);
  assert.equal(s.root.querySelector('[data-driver-home]'),null);
  await s.root.querySelector('[data-driver-logout]').onclick();assert.equal(s.sandbox.Auth.user,null);
 }
});

test('logout de red fallido cierra localmente sin afirmar revocación remota',async()=>{
 const s=surface({fetcher:async url=>{if(url==='/api/auth/logout')throw Error('offline');return {ok:true,status:200,json:async()=>[]}}});
 await s.sandbox.driverBoot({authenticated:true});await s.root.querySelector('[data-driver-logout]').onclick();
 assert.equal(s.sandbox.Auth.token,'');assert.match(s.root.innerHTML,/no fue posible confirmar el cierre en el servidor/);
});

test('salida con petición pendiente oculta datos, detiene GPS, bloquea doble salida y tiene timeout',async()=>{
 const s=surface({fetcher:async(url,options)=>{
  if(url==='/api/auth/logout')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
  if(url==='/api/driver/trips/9')return {ok:true,status:200,json:async()=>({id:9,truck_id:31,status:'En tránsito'})};
  return {ok:true,status:200,json:async()=>[]};
 }});
 await s.sandbox.driverBoot({authenticated:true});
 const logout=s.root.querySelector('[data-driver-logout]').onclick;
 s.root.innerHTML+='<div class="driver-gps"></div>';
 await s.sandbox.driverTest.startGps({id:9,truck_id:31,status:'En tránsito'});
 const pending=logout();assert.match(s.root.innerHTML,/Cerrando sesión/);assert.deepEqual(s.cleared,[7]);
 await logout();assert.equal(s.calls.filter(call=>call.url==='/api/auth/logout').length,1);
 s.timers.find(timer=>timer.ms===8000).callback();await pending;assert.equal(s.sandbox.Auth.token,'');
});

test('respuesta de viajes pendiente no restaura información después de salir',async()=>{
 let resolve;
 const s=surface({fetcher:async url=>url==='/api/driver/trips'?new Promise(r=>{resolve=r}):{ok:true,status:200,json:async()=>({ok:true})}});
 const boot=s.sandbox.driverBoot({authenticated:true});
 await s.root.querySelector('[data-driver-logout]').onclick();
 resolve({ok:true,status:200,json:async()=>[{trip_number:'V-PRIVADO'}]});await boot;
 assert.match(s.root.innerHTML,/Iniciar sesión/);assert.doesNotMatch(s.root.innerHTML,/V-PRIVADO/);
});

test('sesión vencida limpia identidad y muestra login, sin confundir un 403',async()=>{
 for(const status of [401,403]){
  const s=surface({fetcher:async()=>({ok:false,status,json:async()=>({error:'Acceso denegado'})})});
  await s.sandbox.driverBoot({authenticated:true});
  if(status===401){assert.equal(s.sandbox.Auth.user,null);assert.match(s.root.innerHTML,/sesión venció/)}
  else{assert.notEqual(s.sandbox.Auth.user,null);assert.ok(s.root.querySelector('[data-driver-logout]'))}
 }
});

test('401 de sesión antigua no cierra la nueva sesión',async()=>{
 let resolve;
 const s=surface({fetcher:async()=>new Promise(r=>{resolve=r})});
 const old=s.sandbox.driverBoot({authenticated:true});
 s.sandbox.Auth.user={name:'Otro',role_code:'driver',driver_id:null};s.sandbox.Auth.token='token-B';
 await s.sandbox.driverBoot({authenticated:true});
 resolve({ok:false,status:401,json:async()=>({error:'Venció A'})});await old;
 assert.equal(s.sandbox.Auth.token,'token-B');assert.equal(s.sandbox.Auth.user.name,'Otro');
});

test('contraseña temporal exige cambio antes de consultar viajes y mantiene salida',async()=>{
 const s=surface({user:{must_change_password:true}});await s.sandbox.driverBoot({authenticated:true});
 assert.match(s.root.innerHTML,/contraseña temporal/);assert.equal(s.calls.length,0);
 assert.ok(s.root.querySelector('[data-driver-logout]'));assert.equal(s.root.querySelector('[data-driver-home]'),null);
 const form=s.root.querySelector('#driverPassword');form.values={current_password:'Temporal123',new_password:'nuevaPassword123',confirm_password:'nuevaPassword123'};
 await form.onsubmit({preventDefault(){}});
 assert.equal(s.sandbox.Auth.user.must_change_password,false);
 assert.ok(s.calls.find(call=>call.url==='/api/auth/change-password'));
 assert.ok(s.calls.find(call=>call.url==='/api/driver/trips'));
});

test('contraseña nueva inválida no envía solicitud',async()=>{
 const s=surface({user:{must_change_password:true}});await s.sandbox.driverBoot({authenticated:true});
 const form=s.root.querySelector('#driverPassword');form.values={current_password:'old',new_password:'corta',confirm_password:'otra'};
 await form.onsubmit({preventDefault(){}});
 assert.equal(s.calls.length,0);assert.equal(form.querySelector('.driver-password-error').hidden,false);
});

test('identidad pendiente tras cambiar contraseña no restaura usuario después de cerrar sesión',async()=>{
 let resolve;
 const s=surface({user:{must_change_password:true},fetcher:async url=>{
  if(url==='/api/auth/me')return new Promise(r=>{resolve=r});
  return {ok:true,status:200,json:async()=>({ok:true})};
 }});
 await s.sandbox.driverBoot({authenticated:true});
 const form=s.root.querySelector('#driverPassword');form.values={current_password:'Temporal123',new_password:'NuevaSegura123',confirm_password:'NuevaSegura123'};
 const pending=form.onsubmit({preventDefault(){}});
 await new Promise(r=>setImmediate(r));
 await s.root.querySelector('[data-driver-logout]').onclick();
 resolve({ok:true,status:200,json:async()=>({user:{name:'Identidad anterior'}})});await pending;
 assert.equal(s.sandbox.Auth.user,null);assert.match(s.root.innerHTML,/Iniciar sesión/);
});

test('error de carga conserva acceso a salir y acción de reintento',async()=>{
 const s=surface({fetcher:async()=>{throw Error('Sin red')}});
 await s.sandbox.driverBoot({authenticated:true});
 assert.match(s.root.querySelector('.driver-detail').innerHTML,/Reintentar/);assert.ok(s.root.querySelector('[data-driver-logout]'));
});

test('cambio de estado pendiente no reabre detalle tras volver a viajes',async()=>{
 let resolve;
 const s=surface({fetcher:async url=>{
  if(url.endsWith('/status'))return new Promise(r=>{resolve=r});
  return {ok:true,status:200,json:async()=>[]};
 }});
 await s.sandbox.driverBoot({authenticated:true});
 const pending=s.sandbox.driverTest.changeStatus(9,{dataset:{status:'En carga'},disabled:false});
 await s.sandbox.driverTest.loadTrips();
 resolve({ok:true,status:200,json:async()=>({ok:true})});await pending;
 assert.equal(s.calls.some(call=>call.url==='/api/driver/trips/9'),false);
});

test('sesión vencida al cambiar contraseña lleva al login, pero clave actual incorrecta no',async()=>{
 for(const status of [401,403]){
  const s=surface({user:{must_change_password:true},fetcher:async()=>({ok:false,status,json:async()=>({error:'Contraseña incorrecta'})})});
  await s.sandbox.driverBoot({authenticated:true});
  const form=s.root.querySelector('#driverPassword');form.values={current_password:'Temporal123',new_password:'NuevaSegura123',confirm_password:'NuevaSegura123'};
  await form.onsubmit({preventDefault(){}});
  if(status===401){assert.equal(s.sandbox.Auth.user,null);assert.match(s.root.innerHTML,/sesión venció/)}
  else{assert.notEqual(s.sandbox.Auth.user,null);assert.equal(form.querySelector('.driver-password-error').textContent,'Contraseña incorrecta')}
 }
});
