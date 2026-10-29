'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const CAT='/api/fleet/compositions',TRIP='/api/operations/trips/7/resources';
function node(){const children=new Map(),classes=new Set(['hidden']);let html='';return {isConnected:true,hidden:false,disabled:false,dataset:{},value:'',textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},get innerHTML(){return html;},set innerHTML(v){html=v;children.clear();},querySelector(s){if(!children.has(s))children.set(s,node());return children.get(s);}};}
const comp={id:1,name:'Equipo <img src=x>',truck_id:3,trailer_id:4,truck_patente:'TRAC01',trailer_patente:'TRAIL1',valid_from:'2000-01-01T00:00:00Z',valid_until:null,active:true,version:2,capacity_t:15};
const opts={compositions:[comp],trucks:[{id:3,patente:'TRAC01',tipo:'Tractocamión',status:'Disponible'},{id:4,patente:'TRAIL1',tipo:'Semirremolque',status:'Disponible',capacidad_t:15}],drivers:[{id:5,name:'Conductor',status:'Activo'}],clients:[{id:6,name:'Cliente'}],routes:[]};
function surface({fetcher,canManage=true}={}){
 let root;const elements={app:node(),modal:node(),form:node(),mt:node(),drawerBody:node()},calls=[];
 Object.defineProperty(elements.app,'innerHTML',{set(v){this.html=v;if(root)root.isConnected=false;root=node();},get(){return this.html;}});
 const state={Date,JSON,console,URLSearchParams,localStorage:{getItem:()=>null},alert:m=>{state.alerted=m;},FormData:class{constructor(f){this.values=f.values||{};}*[Symbol.iterator](){yield* Object.entries(this.values);}},document:{getElementById:id=>id==='eq-root'?root:elements[id]},currentTripId:7,openTrip:async id=>{state.opened=id;},trucks:async()=>{state.vehiclesOpened=true;},Auth:{token:'A',user:{company_id:10},async request(url,options={}){
  calls.push({url,options});const r=fetcher?await fetcher(url,options):undefined;if(r!==undefined)return r;
  if(options.method&&options.method!=='GET')return {id:1};
  if(url===CAT)return {rows:Array.from({length:53},(_,i)=>({...comp,id:i+1})),can_manage:canManage};
  if(url===CAT+'/options')return opts.trucks;
  if(url===TRIP+'/options')return opts;
  if(url===TRIP)return {trip:{id:7,resource_version:3,truck_id:3,trailer_id:4,driver_id:5,client_id:6,route_id:null,composition_id:null},history:[]};
  if(url.includes('/history?'))return {rows:[{id:1,version:1,actor_name:'Ana <script>',actor_user_id:2,recorded_at:'2026-10-26T12:00:00Z',reason:'Cambio autorizado',snapshot:{truck:{patente:'TRAC01'},trailer:{patente:'TRAIL1'},capacity_t:15}}],page:1,page_size:25,total:26};
  throw Error(url);
 }}};state.window=state;vm.createContext(state);vm.runInContext(fs.readFileSync(require.resolve('../public/equipment.js'),'utf8'),state);
 return {state,calls,elements,get root(){return root;},mount:()=>state.openFleetCompositions(),async click(action,id=''){const b={dataset:{eqAction:action,id},closest(){return this;}};await root.onclick({target:b});},async submit(values){const f=elements.form;f.values=values;await f.onsubmit({preventDefault(){}});return f;}};
}
const mutations=s=>s.calls.filter(c=>c.options.method&&c.options.method!=='GET');
test('catálogo filtra/pagina y escapa nombres sin crear asignaciones ni conductores fijos',async()=>{
 const s=surface();await s.mount();assert.match(s.root.innerHTML,/Equipo &lt;img/);assert.doesNotMatch(s.root.innerHTML,/<img src=x>/);assert.match(s.root.innerHTML,/53 conjuntos/);assert.match(s.root.innerHTML,/Página 1 de 3/);
 await s.click('next');assert.match(s.root.innerHTML,/Página 2 de 3/);assert.equal(mutations(s).length,0);
 await s.click('new');assert.doesNotMatch(s.elements.form.innerHTML,/name="driver_id"/);assert.match(s.elements.form.innerHTML,/semirremolque/i);
});
test('crear/editar conjunto usa recursos seleccionados y versión; no envía autoridad empresarial',async()=>{
 const s=surface();await s.mount();await s.click('edit','1');await s.submit({name:'Conjunto 1',truck_id:'3',trailer_id:'4',valid_from:'2026-10-26T10:00',valid_until:'',active:'false',reason:'Retiro temporal'});
 const r=mutations(s)[0],body=JSON.parse(r.options.body);assert.equal(r.options.method,'PATCH');assert.equal(body.version,2);assert.equal(body.active,false);assert.equal(body.trailer_id,'4');assert.equal('company_id' in body,false);
});
test('asignación por conjunto envía versión del viaje/conjunto sin copiar vehículos deshabilitados',async()=>{
 const s=surface();await s.state.assignTrip(7);const form=s.elements.form,choose=form.querySelector('[name=composition_id]');choose.value='1';choose.onchange();
 assert.equal(form.querySelector('[name=truck_id]').disabled,true);assert.equal(form.querySelector('[name=trailer_id]').disabled,true);assert.match(form.querySelector('#eq-composition-preview').textContent,/TRAC01 \+ TRAIL1/);
 await s.submit({composition_id:'1',truck_id:'999',trailer_id:'999',driver_id:'5',client_id:'6',route_id:'',reason:'Reemplazo autorizado'});
 const r=mutations(s)[0],b=JSON.parse(r.options.body);assert.equal(r.url,TRIP);assert.equal(b.resource_version,3);assert.equal(b.composition_version,2);assert.equal(b.composition_id,1);assert.equal('truck_id' in b,false);assert.equal('company_id' in b,false);assert.equal(s.state.opened,7);
});
test('asignación individual admite acoplado seleccionado y motivo sin campo de texto libre para patente',async()=>{
 const s=surface();await s.state.assignTrip(7);assert.match(s.elements.form.innerHTML,/<select name="trailer_id">/);
 await s.submit({composition_id:'',truck_id:'3',trailer_id:'4',driver_id:'5',client_id:'6',route_id:'',reason:'Cambio en ruta'});
 const b=JSON.parse(mutations(s)[0].options.body);assert.equal(b.composition_id,null);assert.equal(b.trailer_id,'4');assert.equal(b.resource_version,3);
});
test('versión obsoleta conserva formulario y no finge confirmación',async()=>{
 const s=surface({fetcher:(u,o)=>{if(o.method==='PATCH')throw Error('La asignación cambió');}});await s.state.assignTrip(7);
 await s.submit({composition_id:'',truck_id:'3',trailer_id:'4',driver_id:'5',client_id:'6',route_id:'',reason:'Reemplazo'});
 assert.match(s.elements.form.querySelector('.eq-error').textContent,/asignación cambió/);assert.equal(s.elements.form.querySelector('[type=submit]').disabled,false);assert.equal(s.state.opened,undefined);
});
test('asignar recursos no vuelve a elegir recorrido ni borra su referencia histórica',async()=>{
 const s=surface({fetcher:u=>u===TRIP?{trip:{id:7,resource_version:3,truck_id:3,driver_id:5,client_id:6,route_id:42},history:[]}:undefined});
 await s.state.assignTrip(7);assert.doesNotMatch(s.elements.form.innerHTML,/<select name="route_id"/);assert.match(s.elements.form.innerHTML,/Itinerario, cargas y tiempos/);
 await s.submit({composition_id:'',truck_id:'3',driver_id:'5',client_id:'6',route_id:'999',reason:'Conservar recorrido histórico'});
 assert.equal(JSON.parse(mutations(s)[0].options.body).route_id,42);
});
test('historial identifica al autor y revisión; consulta no habilita editar',async()=>{
 const s=surface({canManage:false});await s.mount();assert.doesNotMatch(s.root.innerHTML,/data-eq-action="edit"/);await s.click('history','1');
 assert.match(s.root.querySelector('#eq-history').innerHTML,/Ana &lt;script&gt;/);assert.match(s.root.querySelector('#eq-history').innerHTML,/Más revisiones/);
});
test('respuesta de contexto anterior se descarta tanto en catálogo como en asignación',async()=>{
 let resolve;const waiting=new Promise(r=>resolve=r);const s=surface({fetcher:u=>u===CAT?waiting:undefined});const pending=s.mount();s.state.Auth.token='B';resolve({rows:[{...comp,name:'SECRETO'}],can_manage:true});await pending;assert.doesNotMatch(s.root.innerHTML,/SECRETO/);
});
test('carga SPA conserva orden y presenta remolque al conductor sin framework nuevo',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8'),driver=fs.readFileSync(require.resolve('../public/driver.js'),'utf8');
 assert.ok(html.indexOf('src="equipment.js"')>html.indexOf('src="operations-ui.js"'));assert.match(html,/equipment.css/);assert.match(driver,/composition_snapshot\?\.trailer/);
});
