'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('checklist móvil: histórico visible, seis respuestas, inspección nueva y lectura de autoría',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://checklist.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="host" class="driver-card driver-checklist"></main></body></html>'}));await page.goto('https://checklist.invalid/');
  await page.addStyleTag({path:path.join(__dirname,'../public/driver.css')});await page.addStyleTag({path:path.join(__dirname,'../public/checklist.css')});
  await page.evaluate(()=>{
   window.sent=[];window.ctx={status:'Asignado',resource_version:1,version:0};window.rows=[{id:7,status:'Aprobado',items:[],observations:'Registro sintético vacío'}];const store=new Map();
   window.DriverVault={owner:()=> 'fixture',create:()=>({get:async k=>store.get(k),put:async(k,v)=>store.set(k,v),remove:async k=>store.delete(k),list:async()=>[...store.values()]})};
   window.Auth={user:{id:1,company_id:1,driver_id:1,name:'Conductor sintético'},request:async(url,options)=>{
    if(url==='/api/auth/me')return {user:Auth.user};if(url.endsWith('/workflow/checklist')){const body=JSON.parse(options.body);sent.push(body);rows.unshift({id:8,status:body.items.some(i=>i.result==='fail')?'Rechazado':'Aprobado',items:body.items,created_by_name:'Conductor sintético',completed_by_name:'Conductor sintético',completed_at:new Date().toISOString(),supersedes_id:body.supersedes_id});return rows[0];}
    if(url.endsWith('/checklist'))return {checklists:rows};return ctx;
   }};
  });
  for(const f of ['checklist-shared.js','driver-mobile.js'])await page.addScriptTag({path:path.join(__dirname,'../public',f)});await page.evaluate(async()=>{DriverMobile.bind();await DriverMobile.checklist(1,document.getElementById('host'));});
  await page.getByText('Registro histórico incompleto', {exact:false}).waitFor();assert.equal(await page.locator('select').count(),6);assert.equal(await page.locator('select').first().inputValue(),'');assert.match(await page.locator('#host').innerText(),/Sin respuesta válida/);
  assert.equal(await page.locator('.driver-check-answer').count(),6);assert.equal(await page.locator('.driver-check-answer').first().textContent(),'');
  await page.locator('select').first().selectOption('ok');assert.equal(await page.locator('.driver-check-answer').first().textContent(),'✓');assert.equal(await page.locator('.driver-check-answer').first().getAttribute('aria-label'),'Conforme');assert.equal(await page.locator('.driver-check-answer').first().evaluate(el=>getComputedStyle(el).color),'rgb(24, 115, 59)');
  await page.locator('select').first().selectOption('fail');assert.equal(await page.locator('.driver-check-answer').first().textContent(),'✕');assert.equal(await page.locator('.driver-check-answer').first().getAttribute('aria-label'),'Con falla');
  assert.equal(await page.locator('.driver-check-answer').first().evaluate(el=>getComputedStyle(el).color),'rgb(180, 35, 24)');
  await page.setViewportSize({width:320,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.FLEETCHILE_CHECKLIST_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_CHECKLIST_REVIEW_DIR,'checklist-indicators.png'),fullPage:true});
  await page.setViewportSize({width:390,height:850});
  await page.waitForFunction(()=>document.querySelector('[data-draft-status]').textContent.includes('Borrador guardado'));
  await page.evaluate(()=>DriverMobile.checklist(1,document.getElementById('host')));assert.equal(await page.locator('select').first().inputValue(),'fail');assert.equal(await page.locator('.driver-check-answer').first().textContent(),'✕');
  await page.locator('select').first().selectOption('');assert.equal(await page.locator('.driver-check-answer').first().textContent(),'');
  await page.getByRole('button',{name:'Registrar nueva inspección'}).click();assert.equal(await page.evaluate(()=>sent.length),0);
  for(const select of await page.locator('select').all())await select.selectOption('ok');await page.locator('[name=reason]').fill('Inspección física nueva sobre histórico incompleto');await page.getByRole('button',{name:'Registrar nueva inspección'}).click();await page.waitForFunction(()=>sent.length===1);await page.waitForFunction(()=>!document.querySelector('#host form'));
  const body=await page.evaluate(()=>sent[0]);assert.equal(body.supersedes_id,7);assert.equal(body.items.length,6);assert.match(await page.locator('#host').innerText(),/Cerrado por: Conductor sintético/);assert.equal(await page.locator('.checklist-record li').count(),6);
  assert.equal(await page.evaluate(()=>rows.find(r=>r.id===7).items.length),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.FLEETCHILE_CHECKLIST_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_CHECKLIST_REVIEW_DIR,'checklist-mobile.png'),fullPage:true});
  await page.evaluate(async()=>{rows=[{id:9,status:'Rechazado',items:[]}];await DriverMobile.checklist(1,document.getElementById('host'));});assert.equal(await page.locator('form').count(),0);assert.match(await page.locator('#host').innerText(),/Falla notificada a operaciones/);
  await page.setViewportSize({width:1280,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>{document.body.innerHTML='<div id="modal" class="hidden"><h2 id="mt"></h2><form id="form"></form></div>';window.Auth.user.permissions=['trips.manage'];window.adminSent=[];window.alerts=[];window.alert=m=>alerts.push(m);window.fetch=async(url,options)=>{if(options?.method==='POST')adminSent.push(JSON.parse(options.body));return Response.json({});};});
  await page.addScriptTag({path:path.join(__dirname,'../public/operations-ui.js')});await page.evaluate(async()=>{window.openTrip=async()=>{};await addTripChecklist(1,1,1);});assert.equal(await page.locator('#form select').count(),6);assert.equal(await page.locator('#form [name=status]').count(),0);
  for(const select of await page.locator('#form select').all())await select.selectOption('ok');await page.locator('#form select').first().selectOption('fail');await page.locator('#form button').click();await page.waitForFunction(()=>alerts.length===1);assert.equal(await page.evaluate(()=>adminSent.length),0);
  await page.locator('#form [name=observations]').fill('Freno requiere revisión sintética');await page.locator('#form button').click();await page.waitForFunction(()=>adminSent.length===1);const admin=await page.evaluate(()=>adminSent[0]);assert.equal(admin.status,'Rechazado');assert.equal(admin.items.length,6);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
