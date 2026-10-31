'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {registerLocationPickerRoutes}=require('../location-picker-api');
function endpoint(pool){
 const routes=[],app={get:(path,...handlers)=>routes.push({path,handlers}),post(){}};registerLocationPickerRoutes(app,pool,{},{});
 const route=routes.find(r=>r.path==='/api/location-picker/locations/:id');
 return async({id='12',user={id:1,actor_type:'company',scope:'company',company_id:10,role_code:'operations',permissions:['trips.manage']}}={})=>{
  const req={params:{id},query:{company_id:99},user},res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  let pending;await route.handlers[0](req,res,()=>pending=route.handlers[1](req,res));if(pending)await pending;return res;
 };
}
test('GET por ID consulta sólo la empresa resuelta, valida ID y no cambia permisos',async()=>{
 const calls=[],run=endpoint({query:async(sql,args)=>{calls.push({sql,args});return {rows:args[1]===12?[{id:12,company_id:10,name:'Acceso confirmado'}]:[]};}});
 assert.equal((await run()).body.name,'Acceso confirmado');assert.deepEqual(calls[0].args,[10,12]);assert.match(calls[0].sql,/where company_id=\$1 and id=\$2/);
 assert.equal((await run({id:'13'})).statusCode,404);
 for(const id of ['0','bad','1.2','9007199254740992'])assert.equal((await run({id})).statusCode,400);
 const before=calls.length;
 assert.equal((await run({user:null})).statusCode,401);
 assert.equal((await run({user:{id:1,actor_type:'company',scope:'company',company_id:10,role_code:'viewer',permissions:[]}})).statusCode,403);
 assert.equal(calls.length,before);
});
function node(){
 const children=new Map();let html='';
 return {parentElement:{before(){}},value:'',dataset:{},isConnected:true,children:[],listeners:[],hidden:false,classList:{set:new Set(),add(c){this.set.add(c);},remove(c){this.set.delete(c);},contains(c){return this.set.has(c);}},
 get innerHTML(){return html;},set innerHTML(v){html=v;children.clear();},
 querySelector(s){if(!children.has(s))children.set(s,node());return children.get(s);},
 querySelectorAll(s){if(s==='button')return this.buttons=[...html.matchAll(/data-index="(\d+)"/g)].map(m=>{const b=node();b.dataset.index=m[1];return b;});return [];},
 appendChild(n){this.children.push(n);this.lastChild=n;},after(n){this.actions=n;},before(){},closest(){return null;},setAttribute(){},focus(){},remove(){this.isConnected=false;},
 addEventListener(type,fn){this.listeners.push({type,fn});}};
}
function surface(fetcher){
 const form=node(),modal=node(),body=node();let fields={},company='10';const calls=[],opens=[];
 form.querySelector=s=>{
  const name=s.match(/\[name=["']?([^\]"']+)/)?.[1];if(name)return fields[name]||null;
  return s==='.formgrid'?form:null;
 };
 form.appendChild=n=>{if(n.name)fields[n.name]=n;else form.lastChild=n;};
 const elements={form,modal,mt:node()},document={body,activeElement:null,getElementById:id=>elements[id],querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>node()};
 const state={document,console,URLSearchParams,localStorage:{getItem:()=>company},alert:()=>{},Auth:{token:'token',user:{id:1,company_id:10,role_code:'admin'},async request(url,options={}){
  calls.push({url,options});if(fetcher){const value=await fetcher(url,options);if(value!==undefined)return value;}
  if(url.includes('/locations/'))return {id:12,company_id:10,name:'Origen del servidor',lat:-33,lng:-70};
  if(url.includes('/catalog'))return {regions:[],communes:[],localities:[],locality_notice:''};
  if(url.endsWith('/clients'))return [];
  if(url.includes('/locations?'))return [{id:20,company_id:10,name:'Destino nuevo',lat:-34,lng:-71}];
  if(url.endsWith('/route'))return {id:30,distance_meters:5000,duration_seconds:600,provider:'fixture',snapped_points:[]};
 }},openForm:async view=>{opens.push(view);for(const f of Object.values(fields))f.isConnected=false;fields={};for(const name of ['origin','destination','client_id','distance_km'])fields[name]=node();modal.classList.remove('hidden');}};
 state.window=state;vm.createContext(state);
 for(const file of ['operations-ui.js','location-picker.js'])vm.runInContext(fs.readFileSync(require.resolve('../public/'+file),'utf8'),state);
 return {state,form,modal,body,calls,opens,get fields(){return fields;},setCompany(value){company=value;},async submit(){const event={blocked:false,preventDefault(){this.blocked=true;},stopImmediatePropagation(){}};for(const listener of form.listeners.filter(l=>l.type==='submit')){listener.fn(event);if(event.blocked)break;}return event;}};
}
test('continuación confirma ID sin mapa, deja cliente/destino vacíos y permite elegir sólo destino para calcular',async()=>{
 const s=surface();await s.state.prepareContinuationTrip({company_id:10,origin_location_id:12,origin:'Texto no confiable'});
 assert.deepEqual(s.opens,['trips']);assert.equal(s.fields.origin.value,'Origen del servidor');assert.equal(s.fields.origin_location_id.value,12);
 assert.equal(s.fields.destination.value,'');assert.equal(s.fields.client_id.value,'');assert.equal(s.fields.truck_id,undefined);assert.equal(s.fields.driver_id,undefined);
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,'/api/location-picker/locations/12');
 assert.equal((await s.submit()).blocked,true);
 // Select only the new destination through the existing saved-location picker.
 await s.fields.destination.actions.children[0].onclick();
 const saved=s.body.lastChild.querySelector('[data-saved]');
 // Keep the actual button handlers assigned by pick() when enumerating.
 const buttons=saved.buttons;assert.equal(buttons.length,1);await buttons[0].onclick();
 assert.equal(s.fields.destination_location_id.value,20);
 const box=s.form.lastChild;await box.querySelector('[data-calculate]').onclick();
 const route=s.calls.find(c=>c.url.endsWith('/route'));assert.deepEqual(JSON.parse(route.options.body),{origin_location_id:12,destination_location_id:20});
 assert.equal(s.fields.distance_km.value,5);assert.equal((await s.submit()).blocked,false);
});
test('rechaza empresa distinta antes de abrir y no rellena un punto inexistente',async()=>{
 const s=surface();await assert.rejects(s.state.prepareContinuationTrip({company_id:99,origin_location_id:12}),/misma empresa/);assert.equal(s.opens.length,0);
 const missing=surface(url=>{if(url.includes('/locations/'))throw Error('Ubicación no encontrada');});
 await assert.rejects(missing.state.prepareContinuationTrip({company_id:10,origin_location_id:12}),/no encontrada/);assert.equal(missing.fields.origin.value,'');assert.equal(missing.fields.origin_location_id,undefined);
});
test('respuesta tardía no precarga si cambia empresa o se reemplaza el formulario',async()=>{
 for(const change of ['company','form']){
  let release;const s=surface(url=>url.includes('/locations/')?new Promise(r=>release=r):undefined);
  const pending=s.state.prepareContinuationTrip({company_id:10,origin_location_id:12});await new Promise(r=>setImmediate(r));
  if(change==='company')s.setCompany('99');else await s.state.openForm('trips');
  release({id:12,company_id:10,name:'Obsoleto',lat:-33,lng:-70});await assert.rejects(pending,/cambi/);
  assert.equal(s.fields.origin.value,'');assert.equal(s.fields.origin_location_id,undefined);
 }
});
test('picker rechaza respuesta cruzada o sin coordenadas confirmadas',async()=>{
 for(const row of [{id:12,company_id:99,name:'Ajeno',lat:-33,lng:-70},{id:12,company_id:10,name:'Sin punto',lat:null,lng:null}]){
  const s=surface(url=>url.includes('/locations/')?row:undefined);
  await assert.rejects(s.state.prepareContinuationTrip({company_id:10,origin_location_id:12}),/no est/);assert.equal(s.fields.origin.value,'');
 }
});

test('sesión que cambia al abrir formulario no consulta origen y oculta el borrador obsoleto',async()=>{
 const s=surface(),open=s.state.openForm;
 s.state.openForm=async view=>{await open(view);s.state.Auth.token='otra sesión';};
 await assert.rejects(s.state.prepareContinuationTrip({company_id:10,origin_location_id:12}),/cambi/);
 assert.equal(s.calls.length,0);assert.equal(s.modal.classList.contains('hidden'),true);assert.equal(s.fields.origin.value,'');
});
test('precarga pendiente no sobrescribe una elección de destino que hizo el usuario',async()=>{
 let release;const s=surface(url=>url.includes('/locations/')?new Promise(r=>release=r):undefined);
 const pending=s.state.prepareContinuationTrip({company_id:10,origin_location_id:12});await new Promise(r=>setImmediate(r));
 await s.fields.destination.actions.children[0].onclick();await s.body.lastChild.querySelector('[data-saved]').buttons[0].onclick();
 release({id:12,company_id:10,name:'Origen',lat:-33,lng:-70});await assert.rejects(pending,/cambi/);
 assert.equal(s.fields.origin.value,'');assert.equal(s.fields.destination_location_id.value,20);
});
