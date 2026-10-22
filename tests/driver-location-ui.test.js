const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function element(html=''){
 const nodes=new Map();
 return {_html:html,hidden:false,disabled:false,textContent:'',
  get innerHTML(){return this._html},set innerHTML(value){this._html=value;nodes.clear()},
  querySelector(selector){
   if(nodes.has(selector))return nodes.get(selector);
   for(const match of this._html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
    const [,tag,attrs]=match,id=attrs.match(/id="([^"]*)"/)?.[1],classes=attrs.match(/class="([^"]*)"/)?.[1]?.split(' ')||[];
    const data=selector.match(/^\[([^\]]+)\]$/)?.[1];
    if(selector==='#'+id||selector[0]==='.'&&classes.includes(selector.slice(1))||data&&attrs.includes(data)||selector===tag){
     const start=match.index+match[0].length,end=this._html.indexOf('</'+tag+'>',start),child=element(this._html.slice(start,end<0?start:end));
     nodes.set(selector,child);return child;
    }
   }
   return null;
  },querySelectorAll(){return []},addEventListener(type,fn){this['on'+type]=fn},focus(){}
 };
}
const user={id:1,name:'Conductor A',company_id:10,driver_id:4,role_code:'driver'};
const trip={id:7,truck_id:31,driver_id:4,company_id:10,trip_number:'V-7',patente:'TEST-31',status:'En tránsito'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function surface({permission='prompt',unsupported=false,secure=true,fetcher}={}){
 const root=element(),events={},watches=new Map(),cleared=[],calls=[],timers=new Map(),permit={state:permission};
 let watchId=0,timerId=0,clock=Date.now();
 const identity={...user},current={...trip};
 const sandbox={
  document:{getElementById:()=>root,hidden:false,addEventListener:(type,fn)=>events[type]=fn},
  navigator:{permissions:{query:async()=>permit},...(!unsupported?{geolocation:{watchPosition(success,error){const id=++watchId;watches.set(id,{success,error});return id},clearWatch:id=>{cleared.push(id);watches.delete(id)}}}:{})},
  Auth:{user:{...identity},token:'token-A'},isSecureContext:secure,AbortController,
  localStorage:{removeItem(){}},confirm:()=>true,
  setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
  Date:class extends Date{static now(){return clock}},
  fetch:async(url,options={})=>{
   calls.push({url,options});
   if(fetcher){const out=await fetcher(url,options);if(out)return out}
   return {ok:true,status:200,json:async()=>url==='/api/auth/me'?{user:{...identity}}:url==='/api/driver/trips'?[{...current}]:url.endsWith('/positions')?{recorded_at:new Date(clock).toISOString()}:{...current}};
  },
  addEventListener:(type,fn)=>events[type]=fn
 };
 sandbox.window=sandbox;vm.createContext(sandbox);
 const source=fs.readFileSync(require.resolve('../public/driver.js'),'utf8');
 vm.runInContext(source.replace(/\}\)\(\);\s*$/,'window.gpsTest={startGps,stopGps,prepareGps,loadTrips};})();'),sandbox);
 await sandbox.driverBoot({authenticated:true});sandbox.gpsTest.prepareGps({...current});
 const panel=()=>root.querySelector('.driver-location-panel');
 const click=()=>panel().querySelector('[data-gps-start]').onclick();
 const position=()=>({coords:{latitude:-36.8,longitude:-73.05,speed:5},timestamp:clock});
 const emit=()=>{const watch=[...watches.values()].at(-1);return watch.success(position())};
 return {root,sandbox,events,watches,cleared,calls,timers,permit,identity,current,panel,click,emit,position,advance:ms=>clock+=ms};
}
const posts=s=>s.calls.filter(call=>call.options.method==='POST');

test('bloqueo de personal detiene GPS y conserva el cierre de sesión sin datos sensibles',async()=>{
 const s=await surface({fetcher:async(url,options)=>options.method==='POST'&&url.endsWith('/positions')?
  {ok:false,status:403,json:async()=>({code:'PERSONNEL_ACCESS_BLOCKED',error:'Acceso restringido'})}:null});
 await s.click();await s.emit();
 assert.equal(s.watches.size,0);
 assert.match(s.root.innerHTML,/Acceso temporalmente restringido/);
 assert.match(s.root.innerHTML,/data-driver-logout/);
 assert.doesNotMatch(s.root.innerHTML,/medical_leave|RUT|diagnóstico/);
});

test('no solicita ubicación ni envía posiciones hasta activar explícitamente',async()=>{
 const s=await surface();assert.equal(s.watches.size,0);assert.equal(posts(s).length,0);
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/desactivada/);
 await s.click();assert.equal(s.watches.size,1);assert.equal(posts(s).length,0);
 await s.emit();assert.equal(posts(s).length,1);
 const body=JSON.parse(posts(s)[0].options.body);
 assert.equal(body.lat,-36.8);assert.equal(body.lng,-73.05);
 for(const key of ['driver_id','company_id','truck_id'])assert.equal(key in body,false);
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/recibida/);
});

test('identidad y última confirmación permanecen en el panel al volver y actualizar viajes',async()=>{
 const s=await surface();await s.click();await s.emit();
 const watch=[...s.watches.keys()][0];
 await s.sandbox.gpsTest.loadTrips();
 assert.ok(s.watches.has(watch));assert.equal(s.watches.size,1);
 assert.match(s.panel().querySelector('[data-gps-identity]').textContent,/Conductor A.*V-7.*TEST-31/);
 assert.doesNotMatch(s.panel().querySelector('[data-gps-last]').textContent,/Todavía/);
});

test('permiso bloqueado informa pasos Android y se puede reintentar tras habilitarlo',async()=>{
 const s=await surface({permission:'denied'});await s.click();
 assert.equal(s.watches.size,0);assert.equal(posts(s).length,0);
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/bloqueada/);
 assert.equal(s.panel().querySelector('[data-gps-start]').textContent,'Reintentar ubicación');
 s.permit.state='granted';await s.click();assert.equal(s.watches.size,1);
});

test('errores del dispositivo liberan watch y permiten reintentar el mismo viaje',async()=>{
 for(const code of [1,2,3]){
  const s=await surface();await s.click();[...s.watches.values()][0].error({code});
  assert.equal(s.watches.size,0);assert.equal(posts(s).length,0);
  assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/reintenta/i);
  await s.click();assert.equal(s.watches.size,1);
 }
});

test('sin API o HTTPS ofrece error sin solicitar posición',async()=>{
 for(const options of [{unsupported:true},{secure:false}]){
  const s=await surface(options);await s.click();assert.equal(s.watches.size,0);
  assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/HTTPS|navegador/);
 }
});

test('no activa GPS en estados no autorizados ni sin camión',async()=>{
 for(const change of [{status:'Asignado'},{status:'Completado'},{truck_id:null}]){
  const s=await surface();Object.assign(s.current,change);s.sandbox.gpsTest.prepareGps(s.current);
  assert.equal(s.panel().querySelector('[data-gps-start]').disabled,true);
  await s.click();assert.equal(s.watches.size,0);assert.equal(posts(s).length,0);
 }
});

test('POST no se solapa y el envío está limitado a intervalos de diez segundos',async()=>{
 let resolve;
 const s=await surface({fetcher:async(url)=>url.endsWith('/positions')?new Promise(r=>resolve=r):null});
 await s.click();const pending=s.emit();await flush();await s.emit();assert.equal(posts(s).length,1);
 resolve({ok:true,status:201,json:async()=>({recorded_at:new Date().toISOString()})});await pending;
 await s.emit();assert.equal(posts(s).length,1);
 s.advance(10001);const next=s.emit();await flush();assert.equal(posts(s).length,2);
 resolve({ok:true,status:201,json:async()=>({recorded_at:new Date().toISOString()})});await next;
});

test('stop invalida callbacks tardíos, cancela petición pendiente y no reinicia al volver',async()=>{
 let resolve;
 const s=await surface({fetcher:async url=>url.endsWith('/positions')?new Promise(r=>resolve=r):null});
 await s.click();const callback=[...s.watches.values()][0].success,pending=s.emit();await flush();
 s.sandbox.gpsTest.stopGps('Detenido manualmente.');
 assert.equal(posts(s)[0].options.signal.aborted,true);assert.equal(s.watches.size,0);
 resolve({ok:true,status:201,json:async()=>({recorded_at:'vieja'})});await pending;await callback(s.position());
 assert.equal(posts(s).length,1);assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/manualmente/);
 s.events.visibilitychange();await flush();assert.equal(s.watches.size,0);
});

test('ocultar pausa; volver revalida identidad y viaje antes de reanudar',async()=>{
 const s=await surface();await s.click();s.sandbox.document.hidden=true;s.events.visibilitychange();
 assert.equal(s.watches.size,0);assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/pausada/);
 const previous=s.calls.length;s.sandbox.document.hidden=false;s.events.visibilitychange();await flush();
 assert.equal(s.watches.size,1);
 assert.ok(s.calls.slice(previous).some(call=>call.url==='/api/auth/me'));
 assert.ok(s.calls.slice(previous).some(call=>call.url==='/api/driver/trips/7'));
});

test('no reanuda tras reasignación de camión o cambio de identidad al recuperar foco',async()=>{
 for(const changed of ['truck','driver']){
  const s=await surface();await s.click();s.sandbox.document.hidden=true;s.events.visibilitychange();
  if(changed==='truck')s.current.truck_id=99;
  else s.identity.driver_id=99;
  s.sandbox.document.hidden=false;s.events.visibilitychange();await flush();
  assert.equal(s.watches.size,0);assert.equal(posts(s).length,0);
 }
});

test('validación periódica detiene GPS al terminar viaje incluso sin nuevos movimientos',async()=>{
 const s=await surface();await s.click();s.current.status='Completado';
 const validation=[...s.timers.values()].find(timer=>timer.ms===30000);
 await validation.fn();assert.equal(s.watches.size,0);
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/terminó/);
});

test('errores HTTP no se presentan todos como falta de conexión y nunca confirman posición',async()=>{
 for(const status of [403,404,409,500]){
  const s=await surface({fetcher:async url=>url.endsWith('/positions')?{ok:false,status,json:async()=>({error:'rechazado'})}:null});
  await s.click();await s.emit();assert.equal(s.watches.size,0);
  assert.doesNotMatch(s.panel().querySelector('[data-gps-summary]').textContent,/Sin conexión|recibida/);
  assert.match(s.panel().querySelector('[data-gps-last]').textContent,/Todavía/);
 }
});

test('red fallida permite reintentar sin almacenar coordenadas para reenviarlas después',async()=>{
 let offline=true;
 const s=await surface({fetcher:async url=>{if(offline&&url.endsWith('/positions'))throw Error('offline')}});
 await s.click();await s.emit();assert.equal(s.watches.size,0);
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/conexión/);
 offline=false;await s.click();await s.emit();assert.equal(posts(s).length,2);
});

test('permiso retirado durante seguimiento detiene el watch',async()=>{
 const s=await surface({permission:'granted'});await s.click();
 s.permit.state='denied';s.permit.onchange();
 assert.equal(s.watches.size,0);assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/retirado/);
});

test('validación inicial tiene timeout y deja reintentar sin quedar anclada',async()=>{
 const s=await surface({fetcher:async(url,options)=>url==='/api/driver/trips/7'?new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{name:'AbortError'})))):null});
 const pending=s.click();await flush();
 const timeout=[...s.timers.values()].find(timer=>timer.ms===15000);assert.ok(timeout);
 timeout.fn();await pending;
 assert.equal(s.watches.size,0);assert.equal(s.panel().querySelector('[data-gps-start]').hidden,false);
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/no respondió a tiempo/);
});

test('reabrir el mismo viaje conserva error de permisos y actualiza controles sin duplicar watch',async()=>{
 const s=await surface({permission:'denied'});await s.click();
 s.sandbox.gpsTest.prepareGps({...s.current});
 assert.match(s.panel().querySelector('[data-gps-summary]').textContent,/bloqueada/);
 s.permit.state='granted';await s.click();s.sandbox.gpsTest.prepareGps({...s.current});
 assert.equal(s.watches.size,1);assert.equal(s.panel().querySelector('[data-gps-stop]').hidden,false);
});

test('rechazo por asignación exige abrir datos vigentes antes de reactivar',async()=>{
 const s=await surface({fetcher:async url=>url.endsWith('/positions')?{ok:false,status:409,json:async()=>({error:'cambio'})}:null});
 await s.click();await s.emit();assert.equal(s.panel().querySelector('[data-gps-start]').disabled,true);
 s.sandbox.gpsTest.prepareGps({...s.current});assert.equal(s.panel().querySelector('[data-gps-start]').disabled,false);
});
