'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('asistente comercial: techo, revisión, publicación sin pago y ampliación con fechas conservadas',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:60000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.route('https://commercial-qa.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<main id="host"></main>'}));await page.goto('https://commercial-qa.invalid/');
  await page.evaluate(()=>{
   const now=Date.now();window.writes=[];window.plan={id:1,name:'Básico',revision:1,max_equipment:5,allowed_modules:['operations','maintenance'],included_modules:['operations']};
   window.snapshot={company:{id:7,legal_name:'Empresa <QA>',commercial_version:0},state:'unconfigured',active:null,last:null,equipment:[],quotes:[],requests:[],periods:[]};
   window.dates={from:new Date(now-3600000).toISOString(),until:new Date(now+30*86400000).toISOString(),valid:new Date(now+86400000).toISOString()};
   window.Auth={request:async(path,options)=>{if(options?.method==='POST'){window.writes.push({path,body:JSON.parse(options.body)});return {id:4};}return path.endsWith('/plans')?[window.plan]:window.snapshot;}};
  });
  await page.addStyleTag({content:fs.readFileSync(require.resolve('../public/commercial.css'),'utf8')});await page.addScriptTag({content:fs.readFileSync(require.resolve('../public/commercial.js'),'utf8')});
  const render=()=>page.evaluate(()=>CommercialUI.company(document.getElementById('host'),{platform:true,companyId:7}));await render();
  assert.match(await page.locator('.commercial-progress').textContent(),/Propuesta pendiente/);assert.equal(await page.locator('.commercial-progress img').count(),0);
  await page.getByRole('button',{name:'Preparar propuesta comercial'}).click();await page.getByRole('button',{name:'Siguiente',exact:true}).click();
  assert.equal(await page.locator('[name=qty_truck]').isVisible(),true);
  await page.locator('[name=qty_truck]').fill('6');await page.locator('[name=price_truck]').fill('10000');
  await page.evaluate(()=>{const f=document.querySelector('[name=period_until]').form;const local=x=>{const d=new Date(x);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};f.elements.period_until.value=local(window.dates.until);f.elements.valid_until.value=local(window.dates.valid);f.elements.reason.value='Condiciones acordadas QA';});
  await page.getByRole('button',{name:'Siguiente',exact:true}).click();assert.match(await page.locator('[data-error]:visible').textContent(),/máximo del plan/);
  await page.locator('[name=qty_truck]').fill('3');await page.getByRole('button',{name:'Siguiente',exact:true}).click();
  assert.match(await page.locator('[data-review]').textContent(),/30.000/);assert.equal(await page.evaluate(()=>window.writes.length),0);
  await page.getByRole('button',{name:'Anterior',exact:true}).click();assert.equal(await page.locator('[name=qty_truck]').inputValue(),'3');await page.getByRole('button',{name:'Siguiente',exact:true}).click();
  await page.getByRole('button',{name:'Calcular y publicar propuesta para aceptación'}).click();await page.waitForFunction(()=>window.writes.length===1);
  const write=await page.evaluate(()=>window.writes[0]);assert.equal(write.path,'/api/platform/commercial/companies/7/quotes');assert.equal(write.body.quantities.truck,3);assert.deepEqual(write.body.modules,['operations']);assert.equal(write.body.kind,'initial');
  await page.evaluate(()=>{const configuration={plan_id:1,plan_name:'Básico',max_equipment:5,quantities:{truck:3,tractor:0,trailer:0,equipment:0},unit_prices:{truck:10000},modules:['operations'],module_prices:{operations:0},period_price_clp:30000};const c={id:8,version:1,configuration,period_from:window.dates.from,period_until:window.dates.until};Object.assign(window.snapshot,{state:'active',active:c,last:c,periods:[c]});window.snapshot.company.commercial_version=1;});
  await render();assert.match(await page.locator('.commercial-progress').textContent(),/Equipos por habilitar/);
  await page.getByRole('button',{name:'Preparar propuesta comercial'}).click();await page.locator('[name=kind]').selectOption('expansion');await page.locator('[name=target_contract_id]').selectOption('8');await page.getByRole('button',{name:'Siguiente',exact:true}).click();
  assert.equal(await page.locator('[name=period_until]').getAttribute('readonly'),'');await page.locator('[name=qty_truck]').fill('4');await page.locator('[name=reason]').fill('Un camión adicional');
  await page.evaluate(()=>{const el=document.querySelector('[name=valid_until]'),d=new Date(window.dates.valid);el.value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);});
  await page.getByRole('button',{name:'Siguiente',exact:true}).click();assert.match(await page.locator('[data-review]').textContent(),/proporcional estimada/);
  await page.getByRole('button',{name:'Calcular y publicar propuesta para aceptación'}).click();await page.waitForFunction(()=>window.writes.length===2);
  const expansion=await page.evaluate(()=>window.writes[1].body);assert.equal(expansion.kind,'expansion');assert.equal(expansion.target_contract_id,8);assert.equal(expansion.quantities.truck,4);assert.equal(expansion.period_until,await page.evaluate(()=>window.dates.until));
 }finally{await browser.close();}
});
