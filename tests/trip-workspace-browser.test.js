'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('ficha completa abre otra pestaña, conserva origen, secciones, formularios y vista rápida',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:90000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext(),errors=[],writes=[];
  const trip={id:7,company_id:10,trip_number:'V-QA-7',status:'Planificado',origin:'Aserradero de prueba',destination:'Bodega de prueba',driver_name:'Conductora QA',client_name:'Cliente QA',truck_id:1,driver_id:2,client_id:3,patente:'AA1111',itinerary_version:0,resource_version:4,loads:[],events:[],checklists:[],proofs:[]};
  const scripts=['app.js','checklist-shared.js','operations-ui.js','linked-trip.js','control-ui.js','equipment.js','itinerary.js','finance.js','pod-evidence.js','trip-workspace.js'];
  let index=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*https:[^>]*>/g,'');
  const fixture=`<script>window.Auth={token:'synthetic',user:{id:1,company_id:10,actor_type:'company',role_code:'operations',permissions:['trips.manage','economics.read']},request:async(url,o={})=>{const r=await fetch(url,o);const d=await r.json();if(!r.ok)throw Error(d.error);return d;}};</script>`;
  index=index.replace('</body>',fixture+scripts.map(f=>'<script src="/'+f+'"></script>').join('')+'</body>');
  await context.route('https://workspace.invalid/**',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;let data=[];
   if(p.startsWith('/api/')){
    if(p==='/api/operations/trips/8')return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Sin permiso para consultar este viaje.'})});
    if(req.method()!=='GET'){writes.push({p,body:req.postDataJSON()});return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'El viaje cambió; recarga antes de guardar.'})});}
    if(p==='/api/trips')data=[trip];
    else if(p==='/api/operations/trips/7')data=trip;
    else if(p==='/api/operations/options')data={trucks:[],drivers:[],clients:[],routes:[]};
    else if(p==='/api/operations/trips/7/itinerary')data={version:0,resource_version:4,trip_status:'Planificado',revision:null,progress:[],loads:[],events:[],capacity:null};
    else if(p==='/api/operations/trips/7/pod')data={proofs:[]};
    else if(p==='/api/economics/trips/7')data={revenue_clp:null,revenue_defined:false};
    else if(p==='/api/economics/trips/7/finance')data={control:{state:'open',version:3},summary:{},costs:[],authorizations:[],sources:[],distributions:[],loads:[],events:[]};
    else if(p==='/api/health')data={ok:true};
    else if(p==='/api/fleet/live')data=[];
    else if(p==='/api/economics/kpis')data={};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   if(p==='/')return route.fulfill({contentType:'text/html',body:index});
   const file=path.join(__dirname,'../public',path.basename(p));return route.fulfill({status:fs.existsSync(file)?200:404,contentType:p.endsWith('.css')?'text/css':'text/javascript',body:fs.existsSync(file)?fs.readFileSync(file):''});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});await page.goto('https://workspace.invalid/');await page.evaluate(()=>trips());
  const link=page.getByRole('link',{name:'Abrir viaje ↗ (nueva pestaña)',exact:true});assert.equal(await link.getAttribute('href'),'/?trip=7&company=10');
  const [full]=await Promise.all([page.waitForEvent('popup'),link.click()]);full.on('pageerror',e=>errors.push(e.message));await full.waitForLoadState();assert.equal(await full.evaluate(()=>window.opener),null);await full.evaluate(()=>openLinkedTrip());
  await full.locator('.trip-workspace-note').waitFor();assert.match(await full.title(),/V-QA-7/);assert.equal(await page.locator('#drawer').isVisible(),false);assert.match(await page.locator('#app').innerText(),/Viajes operacionales/);assert.match(full.url(),/trip=7&company=10/);
  assert.ok(await full.locator('#drawer .drawer').evaluate(el=>el.getBoundingClientRect().width>1100));
  assert.equal(await full.locator('#dx').isVisible(),false);assert.equal(await full.locator('#nav').isVisible(),false);
  for(const name of ['Control económico','Resumen','Actividad','Carga','Checklist','Entrega / POD','Economía','Resumen']){
   await full.locator('.trip-tabs').getByRole('button',{name,exact:true}).click();assert.equal(await full.locator('#drawerBody .trip-panel:visible').count(),1);
  }
  await full.locator('.trip-tabs').getByRole('button',{name:'Carga',exact:true}).click();await full.evaluate(()=>openTrip(7));assert.equal(await full.locator('#tripPanelLoad').isVisible(),true);assert.equal(context.pages().length,2);
  // Existing backend concurrency rejection is still visible; no new tab on save.
  const messages=[];full.on('dialog',async dialog=>{messages.push(dialog.message());await dialog.dismiss();});await full.locator('#tripStatus').selectOption({label:'Asignado'});await full.getByRole('button',{name:'Guardar estado',exact:true}).click();await full.waitForFunction(()=>document.querySelector('#tripPanelLoad')&&!document.querySelector('#tripPanelLoad').classList.contains('hidden'));
  assert.equal(writes.length,1);assert.deepEqual(writes[0],{p:'/api/operations/trips/7/status',body:{status:'Asignado'}});assert.match(messages[0],/El viaje cambió/);assert.equal(context.pages().length,2);
  for(const viewport of [{width:1440,height:1000},{width:390,height:850}]){
   await full.setViewportSize(viewport);await full.locator('.trip-tabs').getByRole('button',{name:'Resumen',exact:true}).click();
   if(process.env.FLEETCHILE_TRIP_WORKSPACE_REVIEW_DIR)await full.screenshot({path:path.join(process.env.FLEETCHILE_TRIP_WORKSPACE_REVIEW_DIR,'trip-workspace-'+viewport.width+'.png'),fullPage:true});
   assert.ok(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await full.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>[el.tagName,el.className,el.id,el.getBoundingClientRect().right])}))));
  }
  await page.getByRole('button',{name:'Vista rápida',exact:true}).click();await page.locator('.trip-workspace-actions').waitFor();assert.equal(await page.locator('#drawer .drawer').isVisible(),true);assert.equal(await page.locator('.trip-workspace-actions a').getAttribute('href'),'/?trip=7&company=10');assert.equal(context.pages().length,2);
  // External session/context change immediately clears the full ficha and its modal.
  await full.evaluate(()=>{document.getElementById('modal').classList.remove('hidden');document.getElementById('form').innerHTML='<input value="borrador sintético">';localStorage.setItem('fleet_company_context','20');dispatchEvent(new StorageEvent('storage',{key:'fleet_company_context',newValue:'20'}));});
  assert.match(await full.locator('#drawerBody').innerText(),/Sesión o empresa modificada/);assert.equal(await full.locator('#modal').isVisible(),false);assert.equal(await full.locator('#form input').count(),0);
  const wrong=await context.newPage();await wrong.goto('https://workspace.invalid/?trip=7&company=20');await wrong.evaluate(()=>openLinkedTrip());assert.match(await wrong.locator('#drawerBody').innerText(),/no coincide/);assert.equal(await wrong.locator('.trip-detail').count(),0);await wrong.close();
  const denied=await context.newPage();await denied.goto('https://workspace.invalid/?trip=8&company=10');await denied.evaluate(()=>openLinkedTrip());assert.match(await denied.locator('#drawerBody').innerText(),/Sin permiso para consultar/);assert.equal(await denied.locator('.trip-detail').count(),0);await denied.close();
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
