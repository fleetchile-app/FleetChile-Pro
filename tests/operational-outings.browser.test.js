'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('salida y retorno: base explícita, continuidad, GPS simulado y cierre sin duplicar el servicio',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:60000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(10000);await page.route('https://outing-qa.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<main id="admin"></main><main id="driver"></main>'}));await page.goto('https://outing-qa.invalid/');
  await page.evaluate(()=>{
   window.currentTripId=7;window.calls=[];window.trip={id:7,status:'Asignado',truck_id:4,driver_id:1};window.state={outing:null,can_manage:true,locations:[{id:9,name:'Base <QA>'}],candidates:[],services:[],events:[]};window.gpsCleared=0;
   window.Auth={user:{id:1,company_id:2},token:'qa',request:async(path,options={})=>{
    if(options.method==='POST'){
     const body=JSON.parse(options.body);window.calls.push({path,body});
     if(path.endsWith('/action')){if(body.action==='return')window.state.outing.status='returning';if(body.action==='arrive_base'){window.state.outing.status='arrived_base';window.state.outing.closed_at=new Date().toISOString();}window.state.outing.version++;}
     else if(!path.endsWith('/positions'))window.state.outing={id:3,version:1,status:'in_service',base_location_id:body.base_location_id,base_name:'Base <QA>'};
    }return JSON.parse(JSON.stringify(window.state));
   }};
   Object.defineProperty(navigator,'geolocation',{configurable:true,value:{watchPosition(success){window.fakePosition=success;return 1;},clearWatch(){window.gpsCleared++;}}});
  });
  for(const file of ['operational-outings.js','driver-outing.js'])await page.addScriptTag({content:fs.readFileSync(require.resolve('../public/'+file),'utf8')});
  await page.evaluate(()=>OperationalOutingsUI.mount(window.trip,document.getElementById('admin')));
  await page.locator('[name=base_location_id]').selectOption('9');await page.locator('#admin [name=reason]').fill('Salida de prueba');await page.getByRole('button',{name:'Abrir salida con este servicio'}).click();
  await page.locator('[data-action]').waitFor();assert.equal(await page.locator('#admin img').count(),0);
  assert.equal((await page.evaluate(()=>window.calls[0])).body.base_location_id,9);
  await page.evaluate(()=>window.trip.status='Completado');
  await page.locator('[name=action]').selectOption('link');assert.equal(await page.locator('[name=next_trip_id]').isVisible(),true);
  await page.locator('[name=action]').selectOption('return');await page.locator('#admin [name=reason]').fill('Sin carga de regreso');await page.getByRole('button',{name:'Registrar decisión'}).click();
  await page.getByText('#3 · En retorno a base',{exact:true}).waitFor();
  await page.evaluate(()=>DriverOuting.mount(window.trip,document.getElementById('driver')));
  assert.match(await page.locator('#driver').textContent(),/Servicio entregado.*salida del equipo continúa/s);
  await page.getByRole('button',{name:'Activar ubicación durante el retorno'}).click();
  await page.evaluate(()=>window.fakePosition({coords:{latitude:-36.8,longitude:-73.0,accuracy:8},timestamp:Date.now()}));
  await page.waitForFunction(()=>window.calls.some(c=>c.path.endsWith('/positions')));
  const pos=await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/positions')));assert.equal(pos.path,'/api/driver/trips/7/outing/positions');assert.equal(pos.body.accuracy_m,8);
  await page.locator('#driver [name=reason]').fill('Llegada confirmada');await page.getByRole('button',{name:'Confirmar llegada a base'}).click();
  await page.locator('#driver').getByText('Llegada a base confirmada',{exact:true}).waitFor();assert.equal(await page.locator('[data-return-gps]').count(),0);assert.ok(await page.evaluate(()=>window.gpsCleared>0));
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.path.endsWith('/status')||c.path.endsWith('/deliveries'))),false);
  await page.evaluate(()=>DriverOuting.pause());
 }finally{await browser.close();}
});
