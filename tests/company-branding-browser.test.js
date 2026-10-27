'use strict';
// Optional real browser test using an explicitly supplied local Playwright runtime.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('personalización en navegador: vista previa, guardado, permisos visuales y cambio de empresa sin residuos',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),failures=[];
  page.on('pageerror',e=>failures.push(e.message));
  await page.route('http://branding.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><aside><div class="brand"><b>FC</b><strong>FleetChile</strong></div></aside><div id="activeCompanyName"></div><b id="activeCompanyMark">FC</b><div class="driver-brand">FleetChile · Conductor</div><main id="host"></main></body></html>'}));
  await page.goto('http://branding.invalid/');
  await page.addStyleTag({content:'body{font-family:Arial,sans-serif;margin:24px;background:#f4f8fb}*{box-sizing:border-box}'});
  await page.addStyleTag({path:path.join(__dirname,'../public/company-branding.css')});
  await page.evaluate(()=>{
   window.fixture={company_id:10,version:0,legal_name:'Transportes Ejemplo SpA',rut:'RUT de prueba',display_name:'Transportes Ejemplo',palette:'ocean',contact_name:'',contact_email:'',contact_phone:'',logo_url:null};window.calls=[];
   window.Auth={token:'fixture',user:{id:1,company_id:10},request:async(url,options={})=>{calls.push({url,options});if(url.endsWith('/history'))return {rows:[]};if(options.method==='PUT'){const b=JSON.parse(options.body);fixture={...fixture,...b,version:fixture.version+1,updated_by:1,updated_at:new Date().toISOString()};}return {...fixture};}};
  });
  await page.addScriptTag({path:path.join(__dirname,'../public/company-branding.js')});
  await page.evaluate(()=>CompanyBranding.editor(document.getElementById('host')));
  await page.locator('[name=display_name]').fill('Identidad de prueba');await page.locator('[name=palette]').selectOption('forest');
  assert.match(await page.locator('[data-cb-preview]').innerText(),/Identidad de prueba/);
  assert.equal(await page.locator('aside strong').innerText(),'FleetChile','previsualizar no modifica la interfaz');
  await page.locator('[name=reason]').fill('Primera configuración visual');await page.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('[data-cb-status]')?.textContent.includes('guardada'));
  assert.equal(await page.locator('aside strong').innerText(),'Identidad de prueba');assert.equal(await page.locator('body').getAttribute('data-company-palette'),'forest');
  const payload=await page.evaluate(()=>JSON.parse(calls.find(c=>c.options.method==='PUT').options.body));assert.equal(payload.expected_version,0);assert.equal(payload.company_id,undefined);assert.equal(payload.legal_name,undefined);
  for(const width of [1280,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  if(process.env.FLEETCHILE_BRANDING_REVIEW_DIR){await page.setViewportSize({width:1280,height:1000});await page.screenshot({path:path.join(process.env.FLEETCHILE_BRANDING_REVIEW_DIR,'personalizacion-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:900});await page.screenshot({path:path.join(process.env.FLEETCHILE_BRANDING_REVIEW_DIR,'personalizacion-mobile.png'),fullPage:true});}
  await page.evaluate(async()=>{Auth.token='another';Auth.user.company_id=20;fixture={...fixture,company_id:20,display_name:'Empresa B',palette:'slate'};await CompanyBranding.load();});
  assert.equal(await page.locator('aside strong').innerText(),'Empresa B');assert.doesNotMatch(await page.locator('.driver-brand').innerText(),/Identidad de prueba/);
  await page.evaluate(()=>CompanyBranding.reset());assert.equal(await page.locator('aside strong').innerText(),'FleetChile');assert.equal(await page.locator('body').getAttribute('data-company-palette'),null);
  assert.deepEqual(failures,[]);
 }finally{await browser.close()}
});
