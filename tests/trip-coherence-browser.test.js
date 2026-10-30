'use strict';
// Real SPA forms and Chrome; all API responses and points below are synthetic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Chrome: hereda puntos del viaje, añade entrega intermedia y exige confirmar diferencias',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:60000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(7000);const writes=[];
  const locations=[{id:1,name:'Casa origen QA',commune:'Comuna A',region:'Región A',lat:-36,lng:-73},{id:2,name:'Casa final QA',commune:'Comuna B',region:'Región B',lat:-33,lng:-70},{id:3,name:'Bodega de la carga QA',commune:'Comuna C',region:'Región C',lat:-34,lng:-71}];
  const index=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*https:[^>]*>/g,'');
  await page.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   if(url.origin!=='https://qa-coherence.invalid')return route.abort();
   if(p.startsWith('/api/')){
    let data={};if(req.method()==='PUT'){writes.push(req.postDataJSON());data={id:1};}
    else if(p.endsWith('/options'))data={locations,load_locations_token:'synthetic-token',trip:{origin:'Casa origen QA',destination:'Casa final QA',origin_location_id:1,destination_location_id:2,planned_departure:'2026-11-01T08:00:00Z'},loads:[{id:9,cargo:'Carga QA',client_name:'Cliente con domicilio comercial en otra provincia',weight_kg:300,origin_location_id:1,destination_location_id:3,origin:locations[0].name,destination:locations[2].name}]};
    else data={version:0,resource_version:2,trip_status:'Asignado',revision:null,progress:[],events:[],loads:[]};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   if(p==='/')return route.fulfill({contentType:'text/html',body:index});
   const file=path.join(__dirname,'../public',path.basename(p));return route.fulfill({status:fs.existsSync(file)?200:404,contentType:p.endsWith('.css')?'text/css':'text/plain',body:fs.existsSync(file)?fs.readFileSync(file):''});
  });
  await page.goto('https://qa-coherence.invalid/');
  if(process.env.FLEETCHILE_TEST_LEAFLET){
   await page.addScriptTag({path:process.env.FLEETCHILE_TEST_LEAFLET});
   const css=path.join(path.dirname(process.env.FLEETCHILE_TEST_LEAFLET),'leaflet.css');if(fs.existsSync(css))await page.addStyleTag({path:css});
  }
  await page.evaluate(()=>{window.Auth={token:'synthetic',user:{company_id:10},request:async(url,o={})=>(await fetch(url,o)).json()};window.openTrip=async id=>{window.currentTripId=id;document.getElementById('drawer').classList.remove('hidden');document.getElementById('drawerBody').innerHTML='<div id="tripPanelSummary"></div>';};window.setInterval=()=>0;});
  await page.addScriptTag({path:path.join(__dirname,'../public/itinerary.js')});
  await page.evaluate(()=>window.openTrip(7));await page.getByRole('button',{name:'Planificar paradas y ruta',exact:true}).click();
  assert.equal(await page.locator('[name=s0_location_id]').inputValue(),'1');
  assert.equal(await page.locator('[name=s1_location_id]').inputValue(),'3');
  assert.equal(await page.locator('[name=s2_location_id]').inputValue(),'2');
  assert.equal(await page.locator('#it-coherence [name=load_locations_ack]').count(),0);
  assert.match(await page.locator('.it-current-route').innerText(),/Casa origen QA → Casa final QA/);
  assert.match(await page.locator('[name=s1_location_id] option:checked').innerText(),/Región C/);
  if(process.env.FLEETCHILE_TEST_LEAFLET){assert.equal(await page.locator('#it-map-preview').isVisible(),true);assert.equal(await page.locator('#it-map-preview .leaflet-marker-icon').count(),3);}
  assert.equal(await page.locator('[name=l9_delivery]').inputValue(),await page.locator('[name=l9_delivery] option').nth(2).getAttribute('value'));
  await page.locator('[name=s1_location_id]').selectOption('2');
  await page.locator('[name=reason]').fill('Cambio operativo de entrega QA');await page.locator('[name=review]').fill('Revisión de los puntos y restricciones QA');await page.locator('[name=acknowledged]').check();
  await page.getByRole('button',{name:'Calcular ruta y guardar versión',exact:true}).click();assert.equal(writes.length,0);
  assert.match(await page.locator('#it-coherence').innerText(),/Bodega de la carga QA → Casa final QA/);
  if(process.env.FLEETCHILE_TEST_SCREENSHOTS){fs.mkdirSync(process.env.FLEETCHILE_TEST_SCREENSHOTS,{recursive:true});await page.locator('#it-coherence').screenshot({path:path.join(process.env.FLEETCHILE_TEST_SCREENSHOTS,'coherencia-revision.png')});}
  await page.locator('[name=load_locations_ack]').check();
  await page.locator('[name=s2_location_id]').selectOption('3');
  assert.equal(await page.locator('[name=load_locations_ack]').isChecked(),false,'Otro cambio invalida la confirmación anterior');
  await page.locator('[name=endpoint_change_ack]').check();await page.locator('[name=load_locations_ack]').check();await page.locator('[name=review]').fill('Nueva revisión de los puntos QA');
  await page.getByRole('button',{name:'Calcular ruta y guardar versión',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});
  assert.equal(writes.length,1);assert.equal(writes[0].endpoint_change_ack,true);assert.equal(writes[0].load_locations_ack,true);assert.equal(writes[0].load_locations_token,'synthetic-token');
  assert.equal(writes[0].stops[0].location_id,1);assert.equal(writes[0].stops[1].location_id,2);assert.equal(writes[0].stops[2].location_id,3);
 }finally{await browser.close();}
});
