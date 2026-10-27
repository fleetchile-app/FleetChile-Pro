'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('administración empresarial en navegador: perfiles, importación y soporte responsive',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://enterprise.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="host"></main></body></html>'}));await page.goto('http://enterprise.invalid/');
  await page.addStyleTag({content:'body{font-family:Arial;margin:24px;background:#f4f8fb}*{box-sizing:border-box}'});await page.addStyleTag({path:path.join(__dirname,'../public/enterprise.css')});
  await page.evaluate(()=>{
   window.calls=[];window.profiles=[];window.Auth={token:'test',user:{id:1,company_id:10,role_code:'company_admin'},request:async(url,options={})=>{
    calls.push({url,options});const body=options.body?JSON.parse(options.body):{};
    if(url==='/api/company/access')return {roles:[{id:2,code:'operations',name:'Operaciones',permissions:[{code:'dashboard.read',name:'Consultar dashboard'},{code:'trips.manage',name:'Gestionar viajes'}]}],profiles};
    if(url==='/api/company/access/profiles'){const p={...body,id:5,version:1};profiles.push(p);return p;}
    if(url.startsWith('/api/company/access/memberships?'))return {rows:[{id:8,user_id:9,name:'Operador de prueba',email:'ops@example.invalid',role_id:2,role_name:'Operaciones',role_code:'operations',active:true,stamp:'2026-10-27 10:00:00.000001+00',access_profile_id:null}],total:1,page:1};
    if(url==='/api/company/access/history'||url==='/api/company/imports/history')return {rows:[]};
    if(url.startsWith('/api/company/access/memberships/'))return {ok:true};
    if(url==='/api/company/imports/preview')return {id:'00000000-0000-4000-8000-000000000001',can_commit:true,rows:[{line:2,valid:true,data:{name:'Ana de prueba',rut:'12345678-5'}}]};
    if(url.endsWith('/commit'))return {id:'00000000-0000-4000-8000-000000000001',count:1};
    if(url==='/api/support/management')return {companies:[{id:10,legal_name:'Empresa de prueba'}],users:[{id:20,name:'Soporte de prueba',email:'support@example.invalid'}],grants:[]};
    if(url==='/api/support/companies')return [{id:10,legal_name:'Empresa de prueba'}];
    if(url==='/api/support/current')return {cases:[]};
    if(url==='/api/support/grants')return {id:1};throw Error('URL inesperada: '+url);
   }};
  });
  await page.addScriptTag({path:path.join(__dirname,'../public/enterprise.js')});await page.evaluate(()=>EnterpriseUI.access(document.getElementById('host')));
  await page.locator('[data-en-profile] [name=name]').fill('Coordinación de despacho');await page.locator('[name=permission][value="trips.manage"]').check();await page.locator('[data-en-profile] [name=reason]').fill('Separar responsabilidad de despacho');await page.locator('[data-en-profile] button').click();
  await page.waitForFunction(()=>profiles.length===1);const payload=await page.evaluate(()=>JSON.parse(calls.find(c=>c.url==='/api/company/access/profiles').options.body));assert.deepEqual(payload.permissions,['trips.manage']);assert.equal(payload.company_id,undefined);assert.equal(payload.expected_version,0);
  if(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR,'roles-desktop.png'),fullPage:true});
  await page.evaluate(()=>EnterpriseUI.imports(document.getElementById('host')));await page.locator('[name=kind]').selectOption('people');await page.locator('[name=file]').setInputFiles({name:'personas.csv',mimeType:'text/csv',buffer:Buffer.from('name;rut\nAna de prueba;12345678-5')});await page.locator('[data-en-import] button.en-primary').click();await page.locator('[data-en-confirm]').waitFor();
  assert.equal(await page.evaluate(()=>calls.some(c=>c.url.endsWith('/commit'))),false,'previsualizar no confirma');
  if(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR,'importacion-desktop.png'),fullPage:true});
  await page.locator('[data-en-confirm] [name=reason]').fill('Carga inicial de personas');await page.locator('[name=confirmed]').check();await page.locator('[data-en-confirm] button').click();await page.getByRole('heading',{name:'Importación confirmada'}).waitFor();
  await page.evaluate(()=>EnterpriseUI.support(document.getElementById('host')));await page.locator('[data-en-grant]').waitFor();await page.locator('[name=scope][value=people]').check();await page.locator('[name=expires_at]').fill('2026-11-01T12:00');await page.locator('[data-en-grant] [name=reason]').fill('Atender solicitud del cliente');await page.locator('[data-en-grant] button').click();await page.waitForFunction(()=>calls.some(c=>c.url==='/api/support/grants'));
  if(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR,'soporte-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_ENTERPRISE_REVIEW_DIR,'soporte-mobile.png'),fullPage:true});
  await page.evaluate(async()=>{Auth.user.role_code='platform_support';await EnterpriseUI.support(document.getElementById('host'));});assert.equal(await page.locator('[data-en-grant]').count(),0);assert.equal(await page.locator('[data-en-case]').count(),1);assert.deepEqual(errors,[]);
 }finally{await browser.close()}
});
