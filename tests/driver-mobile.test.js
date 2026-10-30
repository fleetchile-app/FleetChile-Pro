'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
const V=require('../public/driver-vault');
function surface({online=true,post=async()=>({ok:true})}={}){
 const records=new Map(),store={get:async id=>records.get(id),all:async()=>[...records.values()],put:async r=>records.set(r.id,structuredClone(r)),remove:async id=>records.delete(id),purge:async prefix=>{for(const id of records.keys())if(id.startsWith(prefix))records.delete(id);}};
 const user={id:1,company_id:2,driver_id:3,role_code:'driver'},calls=[];
 const Auth={user,token:'not-for-storage',async request(path,options){calls.push({path,options});if(path==='/api/auth/me')return {user:Auth.user};return post(path,options);}};
 const sandbox={Auth,DriverVault:{owner:V.owner,create:u=>V.create(u,{store,crypto:webcrypto})},crypto:webcrypto,AbortController,setTimeout,clearTimeout,FormData,console,confirm:()=>true,navigator:{onLine:online},document:{querySelector:()=>null},window:{addEventListener(){}}};
 const code=fs.readFileSync(require.resolve('../public/driver-mobile'),'utf8').replace(/\}\)\(\);\s*$/,'window.inspectMobile={queue,contexts,getVault:()=>vault};})();');
 vm.runInNewContext(code,sandbox);const api=sandbox.window.DriverMobile,internals=sandbox.window.inspectMobile;
 api.bind();internals.contexts.set('7',{version:2,resource_version:4});
 return {api,internals,Auth,calls,sandbox,records};
}
test('móvil conserva pendientes cifrados sin conexión y sincroniza la misma clave una vez',async()=>{
 const s=surface({online:false});await s.internals.queue(7,'events',{event_key:'stable-1',kind:'arrive',stop_key:'s0'},'stable-1');
 assert.equal(s.calls.length,0);assert.equal((await s.internals.getVault().list()).length,1);
 s.sandbox.navigator.onLine=true;await s.api.sync();await s.api.sync();
 const sends=s.calls.filter(c=>c.path.endsWith('/events'));assert.equal(sends.length,1);const payload=JSON.parse(sends[0].options.body);assert.equal(payload.event_key,'stable-1');assert.equal(payload.version,2);assert.equal(payload.resource_version,4);
 assert.equal((await s.internals.getVault().list()).length,0);assert.equal(JSON.stringify([...s.records.values()]).includes('not-for-storage'),false);
});
test('móvil no reescribe versiones obsoletas, marca revisión y detiene el resto de ese viaje',async()=>{
 const s=surface({online:false,post:async()=>{throw Object.assign(Error('Cambió el itinerario'),{status:409});}});
 await s.internals.queue(7,'events',{event_key:'old',kind:'arrive',stop_key:'s0'},'old');await s.internals.queue(7,'events',{event_key:'later',kind:'depart',stop_key:'s0'},'later');
 s.internals.contexts.set('7',{version:99,resource_version:99});s.sandbox.navigator.onLine=true;await s.api.sync();
 const rows=await s.internals.getVault().list();assert.equal(rows[0].state,'review');assert.equal(rows[0].payload.version,2);assert.equal(rows[1].state,'queued');assert.equal(s.calls.filter(c=>c.options?.method==='POST').length,1);
});
test('fallo de red y sesión bloqueada conservan datos; reintentar no genera otro POD',async()=>{
 let mode='network';const s=surface({post:async()=>{if(mode==='network')throw Error('offline');if(mode==='blocked')throw Object.assign(Error('bloqueado'),{status:403});return {};}});
 const payload={load_id:8,client_submission_id:'pod-fixed',recipient_name:'Receptor',signature:'data:image/png;base64,fixture'};
 let r=await s.api.delivery(7,payload);assert.equal(r.pending,true);
 mode='blocked';await s.api.sync();assert.equal((await s.internals.getVault().list()).length,1);
 mode='ok';await s.api.sync();assert.equal((await s.internals.getVault().list()).length,0);
 const payloads=s.calls.filter(c=>c.path.endsWith('/deliveries')).map(c=>JSON.parse(c.options.body));assert.ok(payloads.every(p=>p.client_submission_id==='pod-fixed'));
});
test('cambio de cuenta no expone ni envía pendientes de otro conductor',async()=>{
 const s=surface({online:false});await s.internals.queue(7,'accept',{client_key:'accept-1'},'accept-1');
 s.Auth.user={...s.Auth.user,id:9,company_id:10,driver_id:11};s.api.bind();s.sandbox.navigator.onLine=true;await s.api.sync();assert.equal((await s.internals.getVault().list()).length,0);assert.equal(s.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('combustible offline conserva foto y clave; un conflicto no bloquea eventos posteriores',async()=>{
 let fail=true;const s=surface({online:false,post:async path=>{if(path.endsWith('/fuel')&&fail)throw Object.assign(Error('Versión antigua'),{status:409});return {};}});
 await s.api.fuel(7,{client_key:'fuel-stable',photo:'data:image/jpeg;base64,fixture',total_clp:65000});
 await s.internals.queue(7,'events',{event_key:'arrive-after-fuel',kind:'arrive',stop_key:'s0'},'arrive-after-fuel');
 s.sandbox.navigator.onLine=true;await s.api.sync();
 const rows=await s.internals.getVault().list();assert.equal(rows.length,1);assert.equal(rows[0].kind,'fuel');assert.equal(rows[0].state,'review');assert.equal(rows[0].payload.photo,'data:image/jpeg;base64,fixture');
 assert.equal(s.calls.filter(c=>c.path.endsWith('/events')).length,1);
 fail=false;await s.api.sync();assert.equal((await s.internals.getVault().list()).length,1,'No reenvía automáticamente un conflicto');
});

test('comprobar recepción de POD solo retira un pendiente con evidencia y la misma clave',async()=>{
 let received=false;const s=surface({post:async(path,options)=>{
  if(options?.method==='POST')throw Object.assign(Error('Viaje cerrado'),{status:409});
  return {deliveries:[{id:8,deliveries:received?[{status:'CLOSED',client_submission_id:'pod-review',evidence:[{type:'signature',exists:true},{type:'photo',exists:true}]}]:[]}]};
 }});
 await s.api.delivery(7,{client_submission_id:'pod-review',load_id:8,signature:'firma',photo:'foto'});
 await assert.rejects(s.api.reconcile('pod-review'),/conserva íntegro/);assert.equal((await s.internals.getVault().list()).length,1);
 received=true;assert.equal(await s.api.reconcile('pod-review'),true);assert.equal((await s.internals.getVault().list()).length,0);
 assert.equal(s.calls.filter(c=>c.options?.method==='POST').length,1);
});
test('doble sincronización comparte trabajo y logout elimina solo el almacén local confirmado por usuario',async()=>{
 let finish;const s=surface({online:false,post:()=>new Promise(resolve=>{finish=resolve;})});
 await s.internals.queue(7,'accept',{client_key:'fixed'},'fixed');s.sandbox.navigator.onLine=true;
 const first=s.api.sync(),second=s.api.sync();while(!finish)await new Promise(resolve=>setImmediate(resolve));finish({});await Promise.all([first,second]);assert.equal(s.calls.filter(c=>c.options?.method==='POST').length,1);
 s.sandbox.navigator.onLine=false;await s.internals.queue(7,'accept',{client_key:'discard'},'discard');s.sandbox.confirm=()=>false;assert.equal(await s.api.logout(),false);assert.equal((await s.internals.getVault().list()).length,1);
 s.sandbox.confirm=()=>true;assert.equal(await s.api.logout(),true);assert.equal(s.records.size,0);
});
