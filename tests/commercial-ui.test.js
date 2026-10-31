'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
function surface({platform=false,data,requestOverride}={}){
 const requests=[],elements={};
 const fields={reason:{value:'Necesito cuatro camiones'}};for(const k of ['truck','tractor','trailer','equipment'])fields['qty_'+k]={value:k==='truck'?'4':'0'};for(const k of ['operations','maintenance','gps','fuel','reports','pod','economics'])fields['module_'+k]={checked:k==='operations'};
 const button={disabled:false},message={hidden:true};
 const form={elements:fields,querySelector:key=>key==='[type=submit]'?button:message};
 const node=()=>({innerHTML:'',querySelector:selector=>selector==='form'?form:{},querySelectorAll:()=>[]});
 const host={innerHTML:'',isConnected:true,querySelector:key=>elements[key]||(elements[key]=node()),querySelectorAll:()=>[]};
 const sandbox={window:{},crypto:{randomUUID},Auth:{async request(path,options){requests.push({path,options});if(requestOverride)return requestOverride(path,options);if(path.endsWith('/plans'))return [];if(options?.method==='POST')return {id:1};return data;}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/commercial'),'utf8'),sandbox);
 const render=()=>sandbox.window.CommercialUI.company(host,{platform,companyId:2});
 return {host,elements,form,requests,sandbox,render};
}
function fixture(){const configuration={plan_name:'Plan fixture',max_equipment:5,quantities:{truck:3,tractor:0,trailer:0,equipment:0},modules:['operations'],period_price_clp:3000};return {company:{id:2,legal_name:'Empresa fixture',commercial_version:1},state:'active',active:{configuration,period_from:'2026-10-01',period_until:'2026-11-01'},equipment:Array.from({length:5},(_,i)=>({id:i+1,patente:'EQ-'+i,category:'truck',enabled:i<3,seat_version:i<3?1:0})),quotes:[],requests:[],periods:[]};}
test('empresa ve techo, cupos y estado de unidades; no recibe controles de habilitación o pago',async()=>{
 const s=surface({data:fixture()});await s.render();assert.match(s.host.innerHTML,/Máximo del plan/);assert.match(s.host.innerHTML,/Cupos del período mostrado/);assert.match(s.host.innerHTML,/No habilitado/);assert.doesNotMatch(s.host.innerHTML,/data-seat=/);assert.doesNotMatch(s.host.innerHTML,/data-payment=/);assert.match(s.elements['[data-new-form]'].innerHTML,/solicitud no modifica/);
});
test('solicitud empresarial usa su API propia y cantidades totales, nunca confirma pagos',async()=>{
 const s=surface({data:fixture()});await s.render();await s.form.onsubmit({preventDefault(){}});const writes=s.requests.filter(r=>r.options?.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/company/commercial/requests');assert.equal(JSON.parse(writes[0].options.body).quantities.truck,4);assert.equal(JSON.parse(writes[0].options.body).company_id,undefined);
});
test('textos empresariales se escapan y una respuesta tardía no reemplaza otra vista',async()=>{
 const data=fixture();data.company.legal_name='<img src=x onerror=bad>';data.equipment[0].patente='<svg onload=bad>';
 const s=surface({data});await s.render();assert.doesNotMatch(s.host.innerHTML,/<img|<svg/);assert.match(s.host.innerHTML,/&lt;img/);
 let finish;const old=surface({requestOverride:()=>new Promise(resolve=>{finish=resolve;})});const pending=old.render();old.host.isConnected=false;old.host.innerHTML='Vista nueva';finish(data);await pending;assert.equal(old.host.innerHTML,'Vista nueva');
});
test('plataforma ofrece habilitación explícita, manteniendo las acciones separadas del inventario',async()=>{const s=surface({platform:true,data:fixture()});await s.render();assert.match(s.host.innerHTML,/data-seat="4"/);assert.match(s.elements['[data-new-form]'].innerHTML,/Preparar propuesta comercial/);});
test('CSS comercial queda acotado al componente, sin iconos SVG ni reglas globales de sidebar',()=>{const css=fs.readFileSync(require.resolve('../public/commercial.css'),'utf8');assert.doesNotMatch(css,/\bsvg\b|\bsidebar\b|\baside\b/);assert.match(css,/min-height:44px/);assert.match(css,/@media\(max-width:700px\)/);});

test('estado comercial distingue aceptación, pago, período futuro y habilitación sin exigir ocupar todos los cupos',async()=>{
 for(const [state,events,expected] of [['unconfigured',[],'Aceptación pendiente'],['unconfigured',[{kind:'accepted'}],'Pago pendiente'],['scheduled',[],'Período pagado: inicio pendiente'],['expired',[],'Período vencido: renovar'],['active',[],'Habilitación comercial vigente']]){
  const data=fixture();data.state=state;if(state!=='active')data.active=null;
  if(state==='unconfigured')data.quotes=[{id:1,kind:'initial',configuration:fixture().active.configuration,events,base_version:1,valid_until:new Date(Date.now()+86400000).toISOString()}];
  const s=surface({data});await s.render();assert.ok(s.host.innerHTML.includes(expected),expected);
 }
});
