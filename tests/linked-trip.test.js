const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/linked-trip.js'),'utf8');
function surface({search='?trip=7&company=10',user={id:2,company_id:10,role_code:'operations'},context='',openTrip}={}){
 const elements={},classes=new Set(),calls=[],writes=[];
 const element=()=>({innerHTML:'',textContent:'',classList:{add(){},remove(){}}});
 const sandbox={URLSearchParams,Auth:{user,token:'token-A'},location:{search},localStorage:{getItem:()=>context,setItem:(...args)=>writes.push(args)},
  document:{body:{classList:{add:name=>classes.add(name)}},getElementById:id=>elements[id]||(elements[id]=element())},
  openTrip:async id=>{calls.push(id);if(openTrip)await openTrip(id)}};
 sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(source,sandbox);
 return {sandbox,elements,classes,calls,writes};
}
test('enlace abre el viaje una sola vez tras autenticación, sin cambiar empresa',async()=>{
 const s=surface();await s.sandbox.openLinkedTrip();await s.sandbox.openLinkedTrip();
 assert.deepEqual(s.calls,[7]);assert.equal(s.classes.has('linked-trip-view'),true);assert.deepEqual(s.writes,[]);
 assert.equal(s.sandbox.isLinkedTripCurrent(),true);
});
test('no altera la pantalla normal cuando no hay enlace',async()=>{
 const s=surface({search:''});await s.sandbox.openLinkedTrip();assert.equal(s.classes.size,0);assert.deepEqual(s.calls,[]);
});
test('IDs ausentes duplicados o no enteros no se interpolan en la ficha',async()=>{
 for(const search of ['?trip=7','?trip=7x&company=10','?trip=1e2&company=10','?trip=-1&company=10','?trip=7&trip=8&company=10','?trip=9007199254740992&company=10','?trip=7&company=10&company=20']){
  const s=surface({search});await s.sandbox.openLinkedTrip();assert.deepEqual(s.calls,[]);assert.match(s.elements.linkedTripError.textContent,/no es válido/);
 }
});
test('otra empresa y plataforma global no fuerzan contexto desde URL',async()=>{
 for(const options of [{user:{id:2,company_id:20}},{user:{id:1,actor_type:'platform',platform_membership_id:3},context:''}]){
  const s=surface(options);await s.sandbox.openLinkedTrip();assert.deepEqual(s.calls,[]);assert.deepEqual(s.writes,[]);
  assert.match(s.elements.linkedTripError.textContent,/no coincide/);
 }
 const s=surface({user:{id:1,actor_type:'platform',platform_membership_id:3},context:'10'});
 await s.sandbox.openLinkedTrip();assert.deepEqual(s.calls,[7]);
});
test('error de consulta no dispara logout ni inserta texto arbitrario',async()=>{
 const s=surface({openTrip:async()=>{throw Error('<script>')}});await s.sandbox.openLinkedTrip();
 assert.equal(s.sandbox.Auth.token,'token-A');assert.match(s.elements.linkedTripError.textContent,/sesión y permisos/);
});
test('cierre de sesión invalida la ficha y cambios de identidad/contexto invalidan respuestas',async()=>{
 const s=surface();await s.sandbox.openLinkedTrip();s.sandbox.stopLinkedTrip();assert.equal(s.sandbox.isLinkedTripCurrent(),false);
 assert.equal(s.elements.drawerBody.innerHTML,'');
 const a=surface();await a.sandbox.openLinkedTrip();a.sandbox.Auth.user={id:9,company_id:10};assert.equal(a.sandbox.isLinkedTripCurrent(),false);
 const b=surface();await b.sandbox.openLinkedTrip();b.sandbox.localStorage.getItem=()=> '20';assert.equal(b.sandbox.isLinkedTripCurrent(),false);
});
test('hook de enlace se ejecuta después de resolver identidad y contexto',()=>{
 const auth=fs.readFileSync(require.resolve('../public/auth.js'),'utf8');
 const boot=auth.slice(auth.indexOf('async function authBoot()'),auth.indexOf("window.addEventListener('DOMContentLoaded'"));
 assert.ok(boot.indexOf('await Auth.me()')<boot.indexOf('await window.openLinkedTrip?.()'));
 assert.ok(boot.indexOf('await renderActiveIdentity()')<boot.indexOf('await window.openLinkedTrip?.()'));
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
 assert.ok(html.indexOf('operations-ui.js')<html.indexOf('linked-trip.js'));
 const operations=fs.readFileSync(require.resolve('../public/operations-ui.js'),'utf8');
 assert.match(operations,/if\(window\.linkedTripView&&!window\.isLinkedTripCurrent\?\.\(\)\)return/);
});
