'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Chrome: documentos claros, sin menú Rutas y recorridos opcionales dentro del planificador',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:60000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);const writes=[];
  const locations=[{id:1,name:'Aserradero sintético',lat:-36,lng:-73},{id:2,name:'Bodega sintética',lat:-33,lng:-70}];
  const index=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*https:[^>]*>/g,'');
  await page.route('https://qa-planner.invalid/**',route=>{
   const req=route.request(),p=new URL(req.url()).pathname;let data=[];
   if(p.startsWith('/api/')){
    if(req.method()==='POST'||req.method()==='PUT'){writes.push({p,body:req.postDataJSON()});data={id:40};}
    else if(p.endsWith('/saved-routes'))data={rows:[{id:40,origin:'<img src=x>',destination:'Bodega sintética',origin_location_id:1,destination_location_id:2,can_use:true},{id:41,origin:'Origen histórico',destination:'Destino histórico',can_use:false}],total:2,page:1,page_size:25};
    else if(p.endsWith('/itinerary/options'))data={locations,loads:[{id:9,cargo:'Madera',client_name:'Cliente',weight_kg:1000}]};
    else if(p.endsWith('/itinerary'))data={version:0,resource_version:3,trip_status:'Planificado',revision:null,progress:[],loads:[],events:[],capacity:null};
    else if(p==='/api/documents/options')data={trucks:[],drivers:[]};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   if(p==='/')return route.fulfill({contentType:'text/html',body:index});
   const file=path.join(__dirname,'../public',path.basename(p));return route.fulfill({status:fs.existsSync(file)?200:404,contentType:p.endsWith('.css')?'text/css':'text/plain',body:fs.existsSync(file)?fs.readFileSync(file):''});
  });
  await page.goto('https://qa-planner.invalid/');await page.evaluate(()=>{window.Auth={token:'synthetic',user:{id:1,actor_type:'company',company_id:10,permissions:['trips.manage','documents.manage']},request:async(url,o={})=>{const r=await fetch(url,o);return r.json();}};window.setInterval=()=>0;});
  await page.addScriptTag({path:path.join(__dirname,'../public/app.js')});
  assert.equal(await page.locator('#nav button[data-v=routes]').count(),0);
  await page.getByRole('button',{name:'Documentos y vencimientos',exact:true}).click();await page.getByRole('heading',{name:'Documentos y vencimientos',exact:true,level:2}).waitFor();
  assert.equal(await page.locator('#nav').getByText('Documentos SII',{exact:true}).count(),0);
  assert.equal(await page.locator('#nav [data-v=documents] span').evaluate(e=>e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.parentElement.clientHeight),true);
  if(process.env.FLEETCHILE_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.FLEETCHILE_TEST_SCREENSHOTS,'documentos.png')});
  await page.evaluate(()=>{window.openTrip=async id=>{window.currentTripId=id;document.getElementById('drawer').classList.remove('hidden');document.getElementById('drawerBody').innerHTML='<div class="trip-detail"><h2>Viaje QA</h2><div id="tripPanelSummary"></div></div>';};});
  await page.addScriptTag({path:path.join(__dirname,'../public/itinerary.js')});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.evaluate(()=>window.openTrip(7));await page.getByRole('button',{name:'Planificar paradas y ruta',exact:true}).click();
   await page.getByText('Recorridos guardados (opcional)',{exact:true}).click();await page.getByRole('button',{name:'Ver recorridos guardados',exact:true}).click();await page.getByText('Origen histórico → Destino histórico',{exact:true}).waitFor();
   if(process.env.FLEETCHILE_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.FLEETCHILE_TEST_SCREENSHOTS,'planificador-'+viewport.width+'.png')});
   assert.equal(await page.locator('#it-saved-routes img').count(),0);assert.equal(await page.locator('[data-it-use="41"]').isDisabled(),true);
   await page.locator('[data-it-use="40"]').click();assert.equal(await page.locator('[name=s0_location_id]').inputValue(),'1');assert.equal(await page.locator('[name=s1_location_id]').inputValue(),'2');
   assert.equal(writes.length,viewport.width===1440?0:2,'Seleccionar no debe guardar ni activar el servicio');
   await page.getByText('Recorridos guardados (opcional)',{exact:true}).click();await page.getByRole('button',{name:'Guardar origen y destino como recorrido',exact:true}).click();await page.getByText('Origen y destino guardados. No se asignaron recursos ni se activó el viaje.',{exact:true}).waitFor();
   assert.deepEqual(writes.at(-1).body,{origin_location_id:1,destination_location_id:2});assert.match(writes.at(-1).p,/saved-routes$/);
   await page.locator('[name=reason]').fill('Planificación sintética');await page.locator('[name=review]').fill('Accesos y restricciones revisados');await page.locator('[name=acknowledged]').check();
   await page.getByRole('button',{name:'Calcular ruta y guardar versión',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});
   assert.match(writes.at(-1).p,/\/itinerary$/);assert.equal(writes.at(-1).body.resource_version,3);assert.equal(writes.at(-1).body.stops[0].location_id,1);assert.equal(writes.at(-1).body.stops[1].location_id,2);assert.equal(writes.at(-1).body.loads[0].load_id,9);assert.equal('truck_id' in writes.at(-1).body,false);
  }
 }finally{await browser.close();}
});
