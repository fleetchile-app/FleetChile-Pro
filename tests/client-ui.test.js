const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const BASE='/api/company/clients';
function node(){const children=new Map();return {dataset:{},events:{},attrs:{},value:'',innerHTML:'',textContent:'',hidden:false,isConnected:true,disabled:false,files:[],focus(){},click(){},contains(){return true;},querySelector(key){if(!children.has(key))children.set(key,node());return children.get(key);},addEventListener(k,fn){this.events[k]=fn;},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}};}
const c={id:'7',company_id:'10',name:'Maderas <img src=x onerror=evil()>',rut:'12345678-5',client_code:'CLI-7',identity_type:'company',active:true,profile_version:3,relationship:'recurring',privacy_status:'pending',assigned_person_name:'Ana',assigned_person_id:'4',address:'Dirección histórica'};
function surface({fetcher}={}){
 let root;const host=node(),calls=[],elements={app:host,title:node(),activeCompanyName:node()};elements.activeCompanyName.textContent='Empresa A';
 Object.defineProperty(host,'innerHTML',{set(html){this.html=html;root=node();},get(){return this.html;}});
 const state={Auth:{token:'session',user:{id:1,company_id:10}},localStorage:{getItem:()=>null},URLSearchParams,Date,URL,console,setTimeout,confirm:()=>true,
  FormData:class{constructor(form){this.values=form.values||{};}*[Symbol.iterator](){yield* Object.entries(this.values);}},
  FileReader:class{readAsDataURL(){this.result='data:application/pdf;base64,JVBERi0xLjQKJSVFT0Y=';this.onload();}},
  document:{getElementById:key=>key==='client-root'?root:elements[key],querySelectorAll:()=>[],createElement:node},
  stopControlDashboard(){},leaveAdminView(){},openForm(v){state.originalForm=v;},
  fetch:async(url,options={})=>{calls.push({url,options});let data=fetcher?await fetcher(url,options):undefined;if(data?.response)return data.response;
   if(data===undefined){if(url===BASE+'/options')data={workers:[{id:'4',name:'Ana',job_title:'Comercial'}],communes:[{id:'2',name:'Concepción',region_name:'Biobío'}]};
    else if(url.startsWith(BASE+'?')){const q=new URLSearchParams(url.split('?')[1]);data={rows:[{...c}],total:51,page:Number(q.get('page')||1),page_size:Number(q.get('page_size')||25)};}
    else if(url.includes('/services'))data={rows:[{id:9,trip_number:'V-9',origin:'Concepción',destination:'Santiago',status:'Completado',actual_arrival:'2026-10-20T12:00:00Z'}],total:26,last_completed_service:'2026-10-20T12:00:00Z'};
    else if(url===BASE+'/7')data={client:{...c},documents:[],events:[{action:'update',actor_user_id:1,actor_name:'Ana',before_data:{name:'Viejo'},after_data:{name:'Nuevo <script>evil</script>'},reason:'Actualización',created_at:'2026-10-22T12:00:00Z'}]};else data={id:7};}
   return {ok:!data?.error,status:data?.error?409:200,json:async()=>data};
  }
 };
 state.window=state;vm.createContext(state);vm.runInContext(fs.readFileSync(require.resolve('../public/clients.js'),'utf8'),state);
 return {state,calls,elements,get root(){return root;},mount:()=>state.clients(),async click(action,params={}){const target={dataset:{clientAction:action,...params},closest(){return this;}};await root.events.click({target});},async submit(kind,values={},extra){const form=node();form.dataset.clientForm=kind;form.values=values;extra?.(form);await root.events.submit({target:form,preventDefault(){}});return form;}};
}
const mutations=s=>s.calls.filter(c=>c.options.method);
test('lista escapa datos, ofrece edición y filtros sin copiar autoridad empresarial',async()=>{
 const s=surface();await s.mount();assert.match(s.root.innerHTML,/Maderas &lt;img/);assert.doesNotMatch(s.root.innerHTML,/<img src=x/);assert.match(s.root.innerHTML,/data-client-action="edit"/);assert.match(s.root.innerHTML,/Pendiente de respaldo/);assert.equal(s.elements.title.textContent,'Clientes');assert.equal(mutations(s).length,0);
 await s.submit('filters',{q:'Maderas & Sur',segment:'wholesale',privacy_status:'pending',page_size:'25',sort:'code',direction:'desc'});await s.click('next');const q=new URLSearchParams(s.calls.at(-1).url.split('?')[1]);assert.equal(q.get('q'),'Maderas & Sur');assert.equal(q.get('page'),'2');assert.equal(q.has('company_id'),false);
});
test('alta no permite RUT inválido; datos opcionales vacíos y código automático son válidos',async()=>{
 const s=surface();await s.mount();await s.click('new');assert.match(s.root.innerHTML,/Catálogo|catálogo oficial/);
 const bad=await s.submit('editor',{name:'Cliente',rut:'12345678-0'});assert.match(bad.querySelector('[data-client-error]').textContent,/RUT incorrecto/);assert.equal(mutations(s).length,0);
 await s.submit('editor',{name:'Cliente',rut:'12345678-5',client_code:'',identity_type:'company',relationship:'customer',active:'true',commune_id:'',assigned_person_id:''});
 const r=mutations(s)[0],body=JSON.parse(r.options.body);assert.equal(r.options.method,'POST');assert.equal(r.url,BASE);assert.equal(body.active,true);assert.equal(body.assigned_person_id,null);assert.equal('client_code' in body,false);assert.equal('company_id' in body,false);
});
test('editar usa PATCH versionado, motivo obligatorio y conserva dirección antigua al dejar estructura vacía',async()=>{
 const s=surface();await s.mount();await s.click('edit',{id:'7'});assert.match(s.root.innerHTML,/Dirección histórica/);
 const data={name:'Nuevo',rut:'12345678-5',client_code:'CLI-7',active:'true',street:'',street_number:'',assigned_person_id:'4',commune_id:''};
 const bad=await s.submit('editor',data);assert.match(bad.querySelector('[data-client-error]').textContent,/motivo/);assert.equal(mutations(s).length,0);
 await s.submit('editor',{...data,reason:'Cambio solicitado'});const r=mutations(s)[0],body=JSON.parse(r.options.body);assert.equal(r.url,BASE+'/7');assert.equal(r.options.method,'PATCH');assert.equal(body.profile_version,3);assert.equal(body.reason,'Cambio solicitado');assert.equal('street' in body,false);assert.equal('address' in body,false);
});
test('historial escapa antes/después y muestra autor; servicios usan enlace nuevo sin inventar fechas',async()=>{
 const s=surface();await s.mount();await s.click('detail',{id:'7'});await s.click('tab',{tab:'history'});assert.match(s.root.innerHTML,/Nuevo &lt;script&gt;/);assert.doesNotMatch(s.root.innerHTML,/<script>/);assert.match(s.root.innerHTML,/Ana/);
 await s.click('tab',{tab:'services'});const html=s.root.querySelector('[data-client-services]').innerHTML;assert.match(html,/target="_blank" rel="noopener noreferrer"/);assert.match(html,/trip=9&amp;company=10/);assert.match(html,/Último servicio completado/);await s.click('service-next');assert.match(s.calls.at(-1).url,/services\?page=2/);
});
test('privacidad informa no bloqueo y subida distingue plantilla y firmado con control de versión',async()=>{
 const s=surface();await s.mount();await s.click('detail',{id:'7'});await s.click('tab',{tab:'privacy'});assert.match(s.root.innerHTML,/no bloquea ni invalida/);assert.match(s.root.innerHTML,/No se envían correos ni WhatsApp automáticamente/);
 const bad=await s.submit('document',{kind:'signed',reason:'Recibido'},f=>{f.querySelector('[name="file"]').files=[{size:20,name:'test.pdf'}];});assert.match(bad.querySelector('[data-client-error]').textContent,/firmante/);assert.equal(mutations(s).length,0);
 await s.submit('document',{kind:'signed',reason:'Recibido',signer_name:'Cliente',signer_capacity:'Representante',signed_on:'2026-10-20'},f=>{f.querySelector('[name="file"]').files=[{size:20,name:'test.pdf'}];});
 const r=mutations(s)[0],body=JSON.parse(r.options.body);assert.equal(r.url,BASE+'/7/documents');assert.equal(body.expected_current_id,null);assert.equal(body.signer_name,'Cliente');assert.equal('company_id' in body,false);assert.match(body.content,/^[A-Za-z0-9+/=]+$/);
});
test('error de concurrencia conserva formulario y no finge guardado',async()=>{
 const s=surface({fetcher:(url,options)=>options.method==='PATCH'?{error:'Otra persona modificó la ficha'}:undefined});await s.mount();await s.click('edit',{id:'7'});
 const form=await s.submit('editor',{name:'Nuevo',rut:'12345678-5',client_code:'CLI-7',active:'true',reason:'Cambio'});assert.match(form.querySelector('[data-client-error]').textContent,/Otra persona/);assert.match(s.root.innerHTML,/Editar cliente/);
});
test('RUT autoformatea y el DV incorrecto se anuncia sin enviar',async()=>{
 const s=surface();await s.mount();await s.click('new');const input={name:'rut',value:'123456785',selectionStart:9,removeAttribute(){},setSelectionRange(a){this.caret=a;},setAttribute(k,v){this[k]=v;}};
 s.root.events.input({target:input});assert.equal(input.value,'12.345.678-5');input.value='12.345.678-0';s.root.events.focusout({target:input});assert.equal(input['aria-invalid'],'true');assert.match(s.root.querySelector('[data-rut-error]').textContent,/RUT incorrecto/);assert.equal(mutations(s).length,0);
});
test('respuesta tardía tras cambiar identidad no revela datos del contexto anterior',async()=>{
 let resolve;const waiting=new Promise(r=>resolve=r);const s=surface({fetcher:url=>url===BASE+'/options'?waiting:undefined});const pending=s.mount();s.state.Auth.token='other-session';resolve({workers:[{id:1,name:'SECRETO ANTERIOR'}],communes:[]});await pending;assert.doesNotMatch(s.root.innerHTML,/SECRETO ANTERIOR/);
});
test('nuevo módulo mantiene delegación de otros formularios y carga scripts/estilos en orden',async()=>{
 const s=surface();s.state.openForm('trucks');assert.equal(s.state.originalForm,'trucks');await s.state.openForm('clients');assert.match(s.root.innerHTML,/Nuevo cliente/);
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');assert.match(html,/href="clients.css"/);assert.ok(html.indexOf('src="clients.js"')>html.indexOf('src="app.js"'));
});
