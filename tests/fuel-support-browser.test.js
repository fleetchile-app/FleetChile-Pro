'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('web combustible: pendiente no es cero, registro único, referencia/archivo opcionales y traducciones de costos',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fuel-support.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="app"></main><div id="modal" class="hidden"><div class="modal"><h2 id="mt"></h2><form id="form"></form></div></div><div id="drawerBody"><div id="tripPanelEconomics"></div></div></body></html>'}));
  await page.goto('https://fuel-support.invalid/');for(const f of ['styles.css','fuel-support.css'])await page.addStyleTag({path:path.join(__dirname,'../public',f)});
  await page.evaluate(()=>{
   window.A=document.getElementById('app');window.writes=[];window.rows=[{id:1,truck_id:3,truck_patente:'AA1111',date:'2026-10-30',liters:80,odometer_km:1000,total_clp:null,price_clp:null,valuation_version:0}];window.support=[];
   window.Auth={token:'synthetic',user:{id:1,company_id:10,permissions:['fuel.manage','economics.read','economics.manage']},request:async(url,opt={})=>{
    if(opt.method==='POST'||opt.method==='PATCH'){
     const b=JSON.parse(opt.body);writes.push({url,body:b});if(url==='/api/fleet/fuel'){const row={...b,id:2,truck_patente:'AA1111',total_clp:null,valuation_version:0};rows.push(row);return row;}
     if(url.includes('/valuation')){rows[0].price_clp=b.price_clp;rows[0].total_clp=b.price_clp*80;rows[0].valuation_version++;return rows[0];}
     support.push({id:1,reference:b.reference,notes:b.notes,has_file:Boolean(b.file),created_by:1,created_at:new Date().toISOString()});return {id:1};
    }
    if(url==='/api/trucks')return [{id:3,company_id:10,patente:'AA1111'}];
    if(url.startsWith('/api/fleet/fuel?'))return {records:rows,totals:{total_liters:160,total_cost_clp:null,known_cost_clp:0,pending_valuation_count:2}};
    if(url.startsWith('/api/financial-support/'))return {rows:support,reference:'VALE-123',can_add:true};return [];
   }};
  });
  await page.addScriptTag({path:path.join(__dirname,'../public/fuel-support.js')});await page.evaluate(()=>fuel());assert.match(await page.locator('#app').innerText(),/Pendiente de valoración/);assert.doesNotMatch(await page.locator('#app').innerText(),/Costo total: \$0/);
  await page.getByRole('button',{name:'Registrar abastecimiento',exact:true}).click();await page.locator('#form [name=truck_id]').selectOption('3');await page.locator('[name=liters]').fill('80');await page.locator('[name=odometer_km]').fill('1200');await page.locator('[name=supply_type]').selectOption('internal');await page.locator('[name=payment_method]').selectOption('internal');await page.locator('[name=pending]').check();assert.equal(await page.locator('[name=price_clp]').isDisabled(),true);await page.locator('[name=receipt_reference]').fill('VALE-123');await page.locator('#form').getByRole('button',{name:'Guardar',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});await page.evaluate(()=>openFinancialSupport('fuel',2));await page.getByRole('heading',{name:'Respaldos del registro'}).waitFor();
  const create=await page.evaluate(()=>writes[0]);assert.equal(create.url,'/api/fleet/fuel');assert.equal(create.body.price_clp,null);assert.equal(create.body.valuation_pending,true);assert.equal(create.body.supply_type,'internal');assert.equal(await page.evaluate(()=>writes.filter(w=>w.url==='/api/fleet/fuel').length),1);
  await page.locator('[name=reference]').fill('CONVENIO-123');await page.locator('#form').getByRole('button',{name:'Guardar',exact:true}).click();await page.getByText('Solo referencia, sin archivo',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>writes.at(-1).body.file),null);
  await page.locator('[name=attachment]').setInputFiles({name:'respaldo.png',mimeType:'image/png',buffer:Buffer.from('browser transport fixture')});await page.locator('#form').getByRole('button',{name:'Guardar',exact:true}).click();await page.getByText('Con archivo adjunto',{exact:true}).waitFor();assert.match(await page.evaluate(()=>writes.at(-1).body.file),/^data:image\/png;base64,/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.FLEETCHILE_FUEL_REVIEW_PATH)await page.screenshot({path:process.env.FLEETCHILE_FUEL_REVIEW_PATH,fullPage:true});
  await page.evaluate(()=>document.getElementById('modal').classList.add('hidden'));await page.locator('[data-value-fuel="1"]').click();await page.locator('[name=price_clp]').fill('1100');await page.locator('[name=reason]').fill('Confirmación de convenio');await page.locator('#form').getByRole('button',{name:'Guardar',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>writes.at(-1).body),{price_clp:1100,version:0,reason:'Confirmación de convenio'});
  await page.evaluate(()=>{window.openTrip=async id=>{window.openedFuelTrip=id;};return openFuelForm({id:9,truck_id:3});});
  assert.equal(await page.locator('#form [name=truck_id]').inputValue(),'3');
  assert.equal(await page.locator('[name=pending]').isDisabled(),true);
  await page.locator('[name=liters]').fill('40');await page.locator('[name=odometer_km]').fill('1300');await page.locator('[name=price_clp]').fill('1200');
  await page.locator('#form').getByRole('button',{name:'Guardar',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>writes.at(-1).body.trip_id),9);assert.equal(await page.evaluate(()=>openedFuelTrip),9);
  await page.evaluate(()=>openCompleteFuelCost({id:9,truck_id:3},{id:11,version_id:12,amount_clp:65000,effective_date:'2026-10-30',description:'Carga QA'}));
  assert.match(await page.locator('#form').innerText(),/No se crea otro costo/);
  await page.locator('#form [name=liters]').fill('50');await page.locator('#form [name=odometer_km]').fill('1400');
  await page.locator('#form').getByRole('button',{name:'Guardar',exact:true}).click();await page.locator('#modal').waitFor({state:'hidden'});
  const completion=await page.evaluate(()=>writes.at(-1));assert.equal(completion.url,'/api/fleet/fuel/from-cost/11');assert.equal(completion.body.expected_version_id,12);assert.equal(completion.body.liters,50);assert.equal('amount_clp' in completion.body,false);assert.equal('price_clp' in completion.body,false);
  // Existing economic form keeps wire values but presents Spanish labels and no false document declaration.
  const source=require('node:fs').readFileSync(path.join(__dirname,'../public/operations-ui.js'),'utf8');assert.match(source,/<option value="planned">Presupuestado<\/option>/);assert.match(source,/<option value="observed">Gasto registrado<\/option>/);assert.match(source,/<option value="allocated">Imputado al viaje<\/option>/);assert.doesNotMatch(source,/<option value="documented">Documentado/);assert.match(source,/if\(redirectFuel\(\)\)return/);assert.match(source,/Completar abastecimiento/);assert.match(source,/attachment_count/);
  const begin=source.indexOf('function showDirectCostForm('),end=source.indexOf('\nwindow.tripTab=',begin);
  assert.ok(begin>=0&&end>begin);
  await page.addScriptTag({content:source.slice(begin,end)});
  await page.evaluate(()=>{window.hasPermission=()=>true;window.fuelRouteCalls=[];window.openFuelForm=async trip=>fuelRouteCalls.push(trip.id);showDirectCostForm({id:9,truck_id:3});});
  await page.locator('#economicCostForm [name=category_code]').selectOption('fuel');
  assert.deepEqual(await page.evaluate(()=>fuelRouteCalls),[9]);assert.equal(await page.locator('#economicCostForm').count(),0);
  await page.evaluate(()=>showDirectCostForm({id:9,truck_id:3}));
  await page.locator('#economicCostForm [name=cost_basis]').selectOption('planned');await page.locator('#economicCostForm [name=category_code]').selectOption('fuel');
  assert.equal(await page.locator('#economicCostForm').count(),1);assert.deepEqual(await page.evaluate(()=>fuelRouteCalls),[9]);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
