'use strict';
{
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function operationsSurface({trip={},permissions=['trips.manage'],trips=[]}={}){
  const record={id:7,company_id:10,status:'Planificado',client_id:11,origin:'Origen de prueba',destination:'Destino de prueba',planned_departure:'2026-10-22T10:00:00Z',planned_arrival:'2026-10-22T12:00:00Z',loads:[],...trip};
  const options={routes:[],clients:[],trucks:[{id:8,patente:'PRUEBA',tipo:'Camión',status:'Disponible'}],drivers:[{id:9,name:'Conductor de prueba',status:'Activo'}]};
  const elements={};
  const requests=[];
  const alerts=[];
  const element=()=>({innerHTML:'',classList:{add(){},remove(){}},data:[]});
  const document={getElementById:id=>elements[id]||(elements[id]=element()),querySelector:()=>null};
  const context={document,Auth:{user:{role_code:'operations',permissions}},money:()=>'',badge:()=>'',alert:message=>alerts.push(message),FormData:class{constructor(form){return form.data}},fetch:async(url,opt={})=>{
    requests.push({url,opt});
    const payload=url==='/api/trips'?trips:url.endsWith('/clients')?[{id:11,name:'Mi cliente',rut:'RUT prueba'}]:url==='/api/operations/options'?options:record;
    return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
  }};
  context.window=context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/operations-ui.js'),'utf8'),context);
  return {context,elements,requests,alerts};
}


test('carga nueva hereda por defecto y reabrir consulta los puntos actuales del viaje',async()=>{
 const s=operationsSurface({trip:{origin_location_id:101,destination_location_id:102,origin:'Acceso <A>',destination:'Acceso B'}});
 s.context.currentTripId=7;await s.context.addTripLoad(7);
 assert.match(s.elements.form.innerHTML,/value="true" selected>Usar origen/);
 assert.match(s.elements.form.innerHTML,/id="tripLoadAlternateLocations" hidden/);
 assert.match(s.elements.form.innerHTML,/data-location-picker="yes"/);
 assert.match(s.elements.form.innerHTML,/Acceso &lt;A&gt;/);
 s.elements.form.data=[['cargo','Carga'],['client_id','11'],['inherit_trip_locations','true'],['origin','Texto residual'],['destination','Otro residual']];
 await s.elements.form.onsubmit({preventDefault(){},target:s.elements.form});
 const body=JSON.parse(s.requests.find(r=>r.opt.method==='POST').opt.body);
 assert.equal(body.inherit_trip_locations,true);assert.equal('origin' in body,false);assert.equal('destination' in body,false);
 assert.equal('origin_location_id' in body,false);assert.equal('destination_location_id' in body,false);
 await s.context.addTripLoad(7);assert.match(s.elements.form.innerHTML,/Acceso &lt;A&gt;/);
 assert.equal(s.requests.filter(r=>r.url==='/api/operations/trips/7'&&!r.opt.method).length,3);
});
test('ubicación alternativa explícita conserva sus IDs al POST y alternar modos no borra selección',async()=>{
 const s=operationsSurface({trip:{origin_location_id:101,destination_location_id:102}});s.context.currentTripId=7;
 let choice; s.context.LocationPicker={pick:async options=>{choice=options;}};
 const controls=new Map();
 const control=()=>({value:'',hidden:true,isConnected:true,after(button){this.button=button;}});
 s.context.document.getElementById('form').querySelector=selector=>{if(!controls.has(selector))controls.set(selector,control());return controls.get(selector);};
 s.context.document.createElement=()=>({});
 await s.context.addTripLoad(7);
 const form=s.elements.form,mode=controls.get('[name=inherit_trip_locations]'),box=controls.get('#tripLoadAlternateLocations');
 mode.value='false';mode.onchange();assert.equal(box.hidden,false);
 const origin=controls.get('[name=origin]');assert.equal(origin.readOnly,true);
 await origin.button.onclick();choice.onSelect({id:303,name:'Acceso distinto'});
 mode.value='true';mode.onchange();assert.equal(box.hidden,true);
 mode.value='false';mode.onchange();assert.equal(origin.value,'Acceso distinto');
 form.data=[['cargo','Otra carga'],['client_id','11'],['inherit_trip_locations','false'],['origin',origin.value],['destination','Destino de prueba']];
 await form.onsubmit({preventDefault(){},target:form});
 const body=JSON.parse(s.requests.find(r=>r.opt.method==='POST').opt.body);
 assert.equal(body.inherit_trip_locations,false);assert.equal(body.origin_location_id,303);assert.equal(body.destination_location_id,102);
});
test('viaje sin puntos no inventa ubicaciones y alternativa sin mapa conserva texto declarado',async()=>{
 const s=operationsSurface({trip:{origin:null,destination:null}});s.context.currentTripId=7;await s.context.addTripLoad(7);
 assert.match(s.elements.form.innerHTML,/Origen pendiente/);assert.match(s.elements.form.innerHTML,/Destino pendiente/);
 s.elements.form.data=[['cargo','Carga'],['client_id','11'],['inherit_trip_locations','false'],['origin','Retiro declarado'],['destination','Entrega declarada']];
 await s.elements.form.onsubmit({preventDefault(){},target:s.elements.form});
 const body=JSON.parse(s.requests.find(r=>r.opt.method==='POST').opt.body);
 assert.equal(body.inherit_trip_locations,false);assert.equal(body.origin,'Retiro declarado');assert.equal('origin_location_id' in body,false);
});

test('cambio de empresa durante edición impide guardar los puntos de otro contexto',async()=>{
 const s=operationsSurface();s.context.currentTripId=7;let company='10';s.context.localStorage={getItem:()=>company};await s.context.addTripLoad(7);company='20';
 s.elements.form.data=[['cargo','Carga'],['client_id','11'],['inherit_trip_locations','true']];
 await s.elements.form.onsubmit({preventDefault(){},target:s.elements.form});
 assert.equal(s.requests.some(r=>r.opt.method==='POST'),false);assert.match(s.alerts[0],/viaje o la sesi/);
});

}
{
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function node(){const children=new Map(),classes=new Set(['hidden']);let html='';return {isConnected:true,dataset:{},disabled:false,textContent:'',hidden:false,value:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},get innerHTML(){return html;},set innerHTML(v){html=v;children.clear();},querySelector(s){if(!children.has(s))children.set(s,node());return children.get(s);},prepend(n){this.child=n;}};}
const plan={departure:'2026-11-01T08:00:00Z',arrival:'2026-11-01T10:00:00Z',contingency_minutes:10,distance_meters:1000,driving_seconds:600,stop_seconds:1200,total_seconds:2400,vehicle_review:{notes:'Revisión <script>'},stops:[{key:'a',location_id:1,purpose:'pickup',service_minutes:10,wait_minutes:0,rest_minutes:0,location:{name:'Origen <img src=x>'}},{key:'b',location_id:2,purpose:'delivery',service_minutes:10,wait_minutes:0,rest_minutes:0,location:{name:'Destino'}}],loads:[{load_id:9,pickup:'a',delivery:'b'}],legs:[{provider:'fixture',calculated_at:'2026-10-26T00:00:00Z'}]};
const data={version:2,resource_version:3,trip_status:'Asignado',revision:{plan},progress:plan.stops,loads:[{id:9,cargo:'Madera',weight_kg:6000,status:'Planificada'}],events:[],capacity:{verified:true,overloaded:false,segments:[{weight_kg:6000,capacity_kg:10000,unknown_weights:0}]},eta:{state:'stale_gps',estimated_arrival:plan.arrival}};
const opts={locations:[{id:1,name:'Origen'},{id:2,name:'Destino'}],loads:[{id:9,cargo:'Madera',client_name:'Cliente',weight_kg:6000}],vehicle:{capacity_t:10}};
function itinerarySurface(fetcher){
 const elements={drawerBody:node(),form:node(),modal:node(),mt:node()},calls=[],state={Date,Math,JSON,console,document:{hidden:false,getElementById:id=>elements[id],createElement:()=>node()},localStorage:{getItem:()=>null},FormData:class{constructor(f){this.values=f.values||{};}*[Symbol.iterator](){yield*Object.entries(this.values);}},crypto:{randomUUID:()=> 'fixture-event-key'},alert:m=>state.alert=m,Auth:{token:'A',user:{company_id:1},async request(url,o={}){calls.push({url,o});const v=fetcher?await fetcher(url,o):undefined;if(v!==undefined)return v;if(o.method==='PUT'||o.method==='POST')return {};if(url.endsWith('/options'))return structuredClone(opts);return structuredClone(data);}},openTrip:async id=>{state.currentTripId=id;state.loadedOperationalTrip={id,planned_departure:plan.departure};}};state.window=state;vm.createContext(state);vm.runInContext(fs.readFileSync(require.resolve('../public/itinerary.js'),'utf8'),state);
 return {state,elements,calls,async open(){await state.openTrip(7);},get panel(){return elements.drawerBody.querySelector('#tripPanelSummary').child;},async click(action,stop){const b={dataset:{action,stop},isConnected:true,closest(){return this;}};await this.panel.onclick({target:b});},async submit(values){elements.form.values=values;await elements.form.onsubmit({preventDefault(){}});}};
}

function selected(html,name,value){const contents=html.match(new RegExp('<select name="'+name+'"[^>]*>([\\s\\S]*?)</select>'))?.[1];assert.ok(contents,'Existe selector '+name);assert.match(contents,new RegExp('<option value="'+value+'" selected>'));}
test('reabrir itinerario conserva paradas y vínculos y precarga carga nueva con IDs confirmados',async()=>{
 const s=itinerarySurface((u)=>u.endsWith('/options')?{...structuredClone(opts),trip:{origin_location_id:1,destination_location_id:2},loads:[{id:9,origin_location_id:2,destination_location_id:1},{id:10,origin_location_id:1,destination_location_id:2}]}:undefined);
 await s.open();await s.click('edit');let html=s.elements.form.innerHTML;
 selected(html,'s0_location_id',1);selected(html,'s1_location_id',2);
 selected(html,'l9_pickup','a');selected(html,'l9_delivery','b');
 selected(html,'l10_pickup','a');selected(html,'l10_delivery','b');
 await s.open();await s.click('edit');html=s.elements.form.innerHTML;
 selected(html,'l9_pickup','a');selected(html,'l10_delivery','b');
});
test('carga nueva con acceso diferente agrega parada sin reemplazar extremos del plan',async()=>{
 const s=itinerarySurface((u)=>u.endsWith('/options')?{...structuredClone(opts),locations:[...opts.locations,{id:3,name:'Acceso alternativo'}],loads:[...opts.loads,{id:10,origin_location_id:3,destination_location_id:2}]}:undefined);
 await s.open();await s.click('edit');const html=s.elements.form.innerHTML;
 selected(html,'s0_location_id',1);selected(html,'s1_location_id',3);selected(html,'s2_location_id',2);
 selected(html,'l9_pickup','a');selected(html,'l9_delivery','b');selected(html,'l10_pickup','fixture-event-key');selected(html,'l10_delivery','b');
});
test('texto alternativo sin ID no se convierte en ubicación confirmada por coincidencia de nombre',async()=>{
 const s=itinerarySurface((u)=>u.endsWith('/options')?{...structuredClone(opts),loads:[...opts.loads,{id:10,origin:'Origen',destination:'Destino'}]}:undefined);
 await s.open();await s.click('edit');const html=s.elements.form.innerHTML;
 for(const name of ['l10_pickup','l10_delivery']){
  const select=html.match(new RegExp('<select name="'+name+'"[^>]*>([\\s\\S]*?)</select>'))[1];assert.doesNotMatch(select,/ selected/);
 }
});

}
