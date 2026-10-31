'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('confirmación manual: campos vacíos, autocompletado rechazado, frase visible y empresa precisa',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:60000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.route('https://purge-qa.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<main id="host"></main>'}));await page.goto('https://purge-qa.invalid/');
  await page.evaluate(()=>{window.calls=[];window.identityRefreshes=0;window.renderActiveIdentity=async()=>{window.identityRefreshes++;};let deleted=false,complete=false;window.Auth={user:{id:1},request:async(path,options)=>{window.calls.push({path,options});if(path.endsWith('/challenge'))return {company:{id:7,legal_name:'Empresa QA'},challenge_id:'00000000-0000-4000-8000-000000000007',phrase:'cobre bosque luna cerro faro'};if(path.endsWith('/execute')){deleted=true;return {job_id:'job-qa'};}if(path.endsWith('/cleanup')){complete=true;return {status:'complete'};}return {companies:deleted?[]:[{id:7,legal_name:'Empresa QA',rut:'QA'}],jobs:deleted?[{id:'job-qa',target_company_id:7,company_name:'Empresa QA',status:complete?'complete':'files_pending'}]:[]};}};});
  await page.addScriptTag({content:fs.readFileSync(require.resolve('../public/company-purge.js'),'utf8')});
  await page.evaluate(()=>CompanyPurgeUI.render(document.getElementById('host')));
  await page.locator('[data-purge-company]').selectOption('7');await page.getByRole('button',{name:'Preparar eliminación'}).click();
  assert.equal(await page.locator('[data-password]').inputValue(),'');assert.equal(await page.locator('[data-phrase]').inputValue(),'');assert.equal(await page.locator('blockquote').textContent(),'cobre bosque luna cerro faro');
  await page.evaluate(()=>{for(const key of ['password','phrase']){const el=document.querySelector('[data-'+key+']');el.value='autocompletado';el.dispatchEvent(new Event('input',{bubbles:true}));}});
  assert.equal(await page.locator('[data-password]').inputValue(),'');assert.equal(await page.locator('[data-phrase]').inputValue(),'');
  await page.locator('[data-password]').click();await page.keyboard.type('Password-tecleada-QA');await page.locator('[data-phrase]').click();await page.keyboard.type('cobre bosque luna cerro faro');
  await page.locator('[data-reason]').fill('Datos ficticios para borrar');await page.locator('[data-ack]').check();await page.getByRole('button',{name:'Vaciar y eliminar esta empresa'}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.path.endsWith('/cleanup')));
  const calls=await page.evaluate(()=>window.calls),execution=calls.filter(c=>c.path.endsWith('/execute'));assert.equal(execution.length,1);assert.equal(execution[0].path,'/api/admin/company-purge/7/execute');assert.equal(JSON.parse(execution[0].options.body).password,'Password-tecleada-QA');
  await page.getByText('Eliminación completada',{exact:true}).waitFor();assert.equal(await page.locator('[data-purge-company] option[value="7"]').count(),0);assert.ok(await page.evaluate(()=>window.identityRefreshes>=2));
 }finally{await browser.close();}
});
