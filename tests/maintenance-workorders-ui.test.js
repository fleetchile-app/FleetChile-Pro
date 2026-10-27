'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const BASE='/api/fleet/work-orders';
function node(){const children=new Map();let html='';return {isConnected:true,hidden:false,disabled:false,value:'',textContent:'',contains(){return true;},scrollIntoView(){},get innerHTML(){return html;},set innerHTML(v){html=v;children.clear();},querySelector(s){if(!children.has(s))children.set(s,node());return children.get(s);}};}
const order={id:7,truck_id:3,operation_stage:'received',work_order_version:4,patente:'MW-07',item:'Frenos <img src=x>',maintenance_type:'Correctiva',cost_clp:null,received_at:'2026-10-26T10:00:00Z',odometer_km:100,current_odometer_km:105,hour_meter_hours:50,lines:[],findings:[],readings:[],events:[{event_type:'diagnosis',actor_name:'Ana <script>',actor_user_id:9,occurred_at:'2026-10-26T11:00:00Z',details:{order:{diagnosis:'Revisar <img>'}}}],costs:{estimated:null,actual:null},pending_checklist_alerts:[{id:11,title:'Checklist rechazado'}]};
function surface({fetcher,data=order}={}){
 let root;const host=node(),calls=[];
 Object.defineProperty(host,'innerHTML',{get(){return this.html;},set(html){this.html=html;root=node();}});
 const state={Date,URLSearchParams,JSON,console,localStorage:{getItem:()=>null},FormData:class{constructor(f){this.values=f.values||{};}*[Symbol.iterator](){yield* Object.entries(this.values);}},document:{getElementById:id=>id==='app'?host:id==='mw-root'?root:null},Auth:{token:'token-A',user:{id:9,company_id:10},async request(url,options={}){
  calls.push({url,options});const override=fetcher?await fetcher(url,options):undefined;if(override!==undefined)return override;
  if(url===BASE+'/options')return {trucks:[{id:3,patente:'MW-07',km:100,hour_meter_hours:50,status:'Disponible'}],drivers:[{id:4,name:'Conductor'}],users:[{id:9,name:'Ana'}]};
  if(options.method&&options.method!=='GET')return {id:7};
  if(url.startsWith(BASE+'?'))return {rows:[data],total:51,page:Number(new URLSearchParams(url.split('?')[1]).get('page')||1),page_size:25};
  return data;
 }}};state.window=state;vm.createContext(state);vm.runInContext(fs.readFileSync(require.resolve('../public/maintenance-workorders.js'),'utf8'),state);
 return {state,calls,get root(){return root;},mount:()=>state.maintenance(),async click(action,id=''){
  const target={dataset:{action,id},closest(){return this;}};root.onclick({target});await new Promise(setImmediate);
 },async submit(values){const f=root.querySelector('form');f.values=values;await f.onsubmit({preventDefault(){}});return f;}};
}
const mutations=s=>s.calls.filter(c=>c.options.method!=='GET');
test('pantalla mantiene estilos, lista paginada y nombres escapados sin presentar costo desconocido como cero',async()=>{
 const s=surface();await s.mount();assert.match(s.root.innerHTML,/Frenos &lt;img/);assert.doesNotMatch(s.root.innerHTML,/<img src=x>/);assert.match(s.root.innerHTML,/Por determinar/);
 assert.match(s.root.innerHTML,/Ingresar al taller/);assert.match(s.root.innerHTML,/Programar mantención/);await s.click('next');assert.match(s.calls.at(-1).url,/page=2/);
});
test('ingreso simple no pide costos ni diagnóstico y envía vehículo, lectura y conductor opcional sin autoridad empresarial',async()=>{
 const s=surface();await s.mount();await s.click('new-receive');const html=s.root.innerHTML;
 assert.match(html,/Odómetro/);assert.doesNotMatch(html,/name="(?:cost_clp|diagnosis|actual_unit_cost_clp)"/);
 await s.submit({truck_id:'3',maintenance_type:'Correctiva',reason:'Frenos',received_at:'2026-10-26T09:00',odometer_km:'100',hour_meter_hours:'',delivered_by_driver_id:'',responsible_user_id:'',workshop:''});
 const payload=JSON.parse(mutations(s)[0].options.body);assert.equal(payload.mode,'receive');assert.equal(payload.hour_meter_hours,null);assert.equal(payload.delivered_by_driver_id,null);assert.equal('company_id' in payload,false);assert.equal('created_by' in payload,false);
});
test('hallazgos seleccionan checklist de la orden y no piden copiar identificadores manualmente',async()=>{
 const s=surface();await s.mount();await s.click('detail','7');await s.click('finding-new');
 assert.match(s.root.innerHTML,/<select name="source_alert_id">/);assert.match(s.root.innerHTML,/value="11"/);
 await s.submit({description:'Frenos',severity:'critical',responsible_user_id:'9',source_alert_id:'11'});
 const body=JSON.parse(mutations(s)[0].options.body);assert.equal(body.work_order_version,4);assert.equal(body.source_alert_id,'11');
});
test('ficha separa liberación y cierre de costos y explica historial sin HTML arbitrario',async()=>{
 const s=surface();await s.mount();await s.click('detail','7');assert.match(s.root.innerHTML,/Liberar técnicamente/);assert.doesNotMatch(s.root.innerHTML,/data-action="close"/);
 assert.match(s.root.innerHTML,/Ana &lt;script&gt;/);assert.match(s.root.innerHTML,/Revisar &lt;img&gt;/);
 const released=surface({data:{...order,operation_stage:'released'}});await released.mount();await released.click('detail','7');assert.match(released.root.innerHTML,/Cerrar costos/);assert.doesNotMatch(released.root.innerHTML,/data-action="release"/);
});
test('error conserva formulario y reanima Guardar sin fingir éxito',async()=>{
 const s=surface({fetcher:(u,o)=>{if(o.method==='PATCH')throw Error('La orden cambió. Actualiza la ficha.');}});await s.mount();await s.click('detail','7');await s.click('edit');
 const f=await s.submit({reason:'Motivo',diagnosis:'Revisión',work_summary:'Trabajo',workshop:'Taller',responsible_user_id:''});
 assert.match(s.root.querySelector('.mw-error').textContent,/orden cambió/);assert.equal(f.querySelector('[type=submit]').disabled,false);
});
test('respuesta de empresa anterior no se pinta después de cambiar sesión',async()=>{
 let resolve;const waiting=new Promise(r=>resolve=r);const s=surface({fetcher:u=>u===BASE+'/options'?waiting:undefined});const pending=s.mount();s.state.Auth.token='token-B';resolve({trucks:[{id:3,patente:'SECRETO'}],drivers:[],users:[]});await pending;assert.doesNotMatch(s.root.innerHTML,/SECRETO/);
});
test('módulo se carga después del render SPA existente y conserva la paleta sin framework',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8'),css=fs.readFileSync(require.resolve('../public/maintenance-workorders.css'),'utf8');
 assert.ok(html.indexOf('src="maintenance-workorders.js"')>html.indexOf('src="app.js"'));assert.match(html,/maintenance-workorders.css/);assert.match(css,/#0f67a9/);assert.match(css,/@media/);
});
