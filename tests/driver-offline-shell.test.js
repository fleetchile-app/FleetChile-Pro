'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function shell(){
 const listeners={},deleted=[],cache=new Map([['/driver.html','static html'],['/driver.js','static js']]);
 const sandbox={URL,self:{location:{origin:'https://fixture.invalid'},clients:{claim:async()=>{}},addEventListener:(type,handler)=>listeners[type]=handler},caches:{open:async()=>({match:async path=>cache.get(path)}),keys:async()=>['fleetchile-driver-shell-v1','fleetchile-driver-shell-v2','other-cache'],delete:async key=>deleted.push(key)},fetch:async()=>{throw Error('offline');}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/service-worker'),'utf8'),sandbox);
 const fetch=(path,mode='cors')=>{let promise;listeners.fetch({request:{url:'https://fixture.invalid'+path,method:'GET',mode},respondWith:p=>{promise=p;}});return promise;};
 return {listeners,deleted,cache,fetch};
}
test('shell offline nunca intercepta APIs, evidencias ni recursos desconocidos',async()=>{
 const s=shell();assert.equal(s.fetch('/api/driver/trips'),undefined);assert.equal(s.fetch('/api/files/evidence'),undefined);assert.equal(s.fetch('/unknown.js'),undefined);assert.equal(await s.fetch('/driver.js'),'static js');
});
test('fallback HTML solo para navegación driver, nunca para JavaScript faltante',async()=>{
 const s=shell();assert.equal(await s.fetch('/driver?trip=1','navigate'),'static html');s.cache.delete('/driver.js');await assert.rejects(s.fetch('/driver.js'),/offline/);
});
test('actualización del shell elimina únicamente sus versiones anteriores',async()=>{
 const s=shell();let promise;s.listeners.activate({waitUntil:p=>{promise=p;}});await promise;assert.deepEqual(s.deleted,['fleetchile-driver-shell-v1']);
});
test('authBoot de conductor preserva token ante red caída pero cierra sesión inválida',async()=>{
 const source=fs.readFileSync(require.resolve('../public/auth'),'utf8').split(/\r?\n/).find(l=>l.startsWith('async function authBoot'));
 for(const status of [undefined,401]){
  let logouts=0,screen;
  const Auth={token:'fixture-token',user:null,status:async()=>{throw Object.assign(Error('unavailable'),status?{status}:{});},logout:async()=>{logouts++;Auth.token='';}};
  const sandbox={Auth,document:{body:{dataset:{surface:'driver'}}},window:{driverBoot:value=>{screen=value;}}};vm.runInNewContext(source,sandbox);await sandbox.authBoot();assert.equal(logouts,status?1:0);assert.equal(Boolean(Auth.token),!status);assert.equal(screen.authenticated,false);
 }
});
