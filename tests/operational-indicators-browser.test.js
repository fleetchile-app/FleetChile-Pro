'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('indicadores operativos abren detalle coherente, fichas, filtros GPS y retorno sin perder contexto',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://operation.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><nav id="nav"><button class="active" data-v="controlDashboard">Dashboard operativo</button></nav><main id="app"></main></body></html>'}));
  await page.goto('https://operation.invalid/');
  for(const file of ['styles.css','operational.css']){
   const fs=require('node:fs'),filePath=path.join(__dirname,'../public',file);if(fs.existsSync(filePath))await page.addStyleTag({path:filePath});
  }
  await page.evaluate(()=>{
   window.A=document.getElementById('app');window.Auth={user:{id:1,company_id:10,actor_type:'legacy',role_code:'admin'}};window.opened=[];window.openTrip=id=>opened.push(['trip',id]);window.openTruck=id=>opened.push(['truck',id]);
   const trip=(id,status,extra={})=>({id,company_id:10,trip_number:'V-'+id,status,truck_id:1,driver_id:2,...extra});
   window.responses={
    '/api/trips':[trip(1,'En tránsito'),trip(2,'Detenido'),trip(3,'Planificado',{driver_id:null}),trip(4,'Completado'),trip(5,'Detenido',{company_id:20})],
    '/api/fleet/live':[{id:1,company_id:10,patente:'AA1111',lat:-36,lng:-73,recorded_at:new Date(Date.now()-60000).toISOString()},{id:2,company_id:10,patente:'BB2222',lat:null,lng:null},{id:3,company_id:20,patente:'AJENO',lat:0,lng:0,recorded_at:new Date().toISOString()}],
    '/api/alerts':[{id:1,company_id:10,title:'Alarma del viaje',text:'Revisar recursos',level:'critical',source_type:'trip',source_id:2,resolved:false},{id:2,company_id:10,title:'Alarma del camión',level:'warning',source_type:'truck',source_id:1,resolved:false},{id:3,company_id:10,title:'Resuelta',resolved:true},{id:4,company_id:20,title:'Ajena',resolved:false}]
   };
   window.fetch=async url=>Response.json(responses[url]||[]);
  });
  await page.addScriptTag({path:path.join(__dirname,'../public/linked-trip.js')});await page.addScriptTag({path:path.join(__dirname,'../public/control-ui.js')});await page.evaluate(()=>controlDashboard());
  assert.equal(await page.locator('.operational-counter').count(),6);assert.equal(await page.locator('#operationalDetail').isVisible(),false);
  const panel=page.locator('#operationalDetail');
  for(const [mode,count,expected,excluded] of [['all',3,'V-1','V-4'],['transit',1,'V-1','V-2'],['stopped',1,'V-2','V-1'],['missing',1,'V-3','V-2']]){
   await page.locator(`[data-indicator="${mode}"]`).click();assert.equal(await panel.isVisible(),true);assert.equal(await panel.locator('.control-trip-row').count(),count);assert.match(await panel.innerText(),new RegExp(expected));assert.doesNotMatch(await panel.innerText(),new RegExp(excluded));assert.equal(await page.locator('#operationalDetailTitle').evaluate(el=>el===document.activeElement),true);
  }
  await page.locator('[data-indicator="stopped"]').click();assert.equal(await panel.locator('.control-trip-row').getAttribute('href'),'/?trip=2&company=10');assert.equal(await panel.locator('.control-trip-row').getAttribute('target'),'_blank');await panel.getByRole('button',{name:'Vista rápida'}).click();assert.deepEqual(await page.evaluate(()=>opened.pop()),['trip',2]);
  await page.evaluate(()=>controlDashboard());assert.match(await panel.innerText(),/Detenidos/);assert.equal(await panel.locator('.control-trip-row').count(),1);
  await page.locator('[data-indicator="alerts"]').click();assert.equal(await panel.locator('.control-alert').count(),2);assert.doesNotMatch(await panel.innerText(),/Resuelta|Ajena/);assert.equal(await panel.getByRole('link',{name:'Ver viaje (nueva pestaña)',exact:true}).getAttribute('href'),'/?trip=2&company=10');await panel.getByRole('button',{name:'Ver camión',exact:true}).click();assert.deepEqual(await page.evaluate(()=>opened.pop()),['truck',1]);
  await page.locator('[data-indicator="gps"]').click();assert.match(await panel.innerText(),/1 con señal reciente de 2/);assert.equal(await panel.locator('.fleet-status-row').count(),2);
  await panel.getByRole('button',{name:'Señal reciente',exact:true}).click();assert.equal(await panel.locator('.fleet-status-row').count(),1);assert.match(await panel.innerText(),/AA1111/);await panel.locator('.fleet-status-row').click();assert.deepEqual(await page.evaluate(()=>opened.pop()),['truck',1]);
  await panel.getByRole('button',{name:'Sin señal reciente',exact:true}).click();assert.match(await panel.innerText(),/BB2222/);assert.doesNotMatch(await panel.innerText(),/AA1111|AJENO/);
  await page.evaluate(()=>controlDashboard());assert.equal(await panel.locator('.fleet-status-row').count(),1);assert.match(await panel.innerText(),/BB2222/);
  await page.setViewportSize({width:390,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.FLEETCHILE_OPERATIONAL_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_OPERATIONAL_REVIEW_DIR,'operational-indicator-detail.png'),fullPage:true});
  await panel.getByRole('button',{name:'Volver al resumen'}).click();assert.equal(await panel.isVisible(),false);assert.equal(await page.locator('[data-indicator="stopped"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-indicator="all"]').focus();await page.keyboard.press('Enter');assert.equal(await panel.locator('.control-trip-row').count(),3);
  // A context switch cannot reveal or reopen the old snapshot.
  await page.evaluate(()=>{Auth.user.company_id=20;openOperationalIndicator('alerts');});assert.doesNotMatch(await panel.innerText(),/Alarma del viaje/);
  await page.evaluate(()=>controlDashboard());assert.equal(await panel.isVisible(),false);await page.locator('[data-indicator="stopped"]').click();assert.match(await panel.innerText(),/V-5/);assert.doesNotMatch(await panel.innerText(),/V-2/);
  await page.evaluate(()=>{stopControlDashboard();document.querySelector('#nav button').dataset.v='trips';openOperationalIndicator('alerts');});assert.doesNotMatch(await panel.innerText(),/Alarma del viaje/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
