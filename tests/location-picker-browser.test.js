'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('selector navegador: mapa real, puntos, guardado, invalidación y cambio de empresa',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT||!process.env.FLEETCHILE_TEST_LEAFLET},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://locations.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="modal"><h2>Nueva ruta planificada</h2><form id="form"><div class="formgrid"><label>Origen<input name="origin" required></label><label>Destino<input name="destination" required></label><label>Distancia<input name="distance_km"></label><button>Guardar</button></div></form></div></body></html>'}));
  await page.route('https://*.tile.openstreetmap.org/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e9eff2"/><path d="M0 128H256M128 0V256" stroke="#c8d5df"/></svg>'}));
  await page.goto('https://locations.invalid/');await page.addScriptTag({path:process.env.FLEETCHILE_TEST_LEAFLET});await page.addStyleTag({path:process.env.FLEETCHILE_TEST_LEAFLET.replace(/\.js$/,'.css')});
  for(const f of ['styles.css','location-picker.css'])await page.addStyleTag({path:path.join(__dirname,'../public',f)});
  await page.evaluate(()=>{
   window.sent=[];window.submissions=[];window.saved=[{id:1,name:'Planta sintética',address:'Acceso de prueba',lat:-36,lng:-73},{id:2,name:'Bodega sintética',address:'Entrega de prueba',lat:-33,lng:-70}];
   window.Auth={token:'test-token',user:{id:1,company_id:10},request:async(url,opts={})=>{
    const u=new URL(url,location.origin),b=opts.body?JSON.parse(opts.body):null;if(b)sent.push({url,body:b});
    if(u.pathname.endsWith('/catalog'))return {regions:[{id:1,name:'Región de prueba'}],communes:u.searchParams.get('region_id')?[{id:2,name:'Comuna de prueba'}]:[],localities:u.searchParams.get('commune_id')?[{id:3,name:'Localidad sintética',latitude:-36,longitude:-73}]:[],locality_notice:'Datos sintéticos de prueba'};
    if(u.pathname.endsWith('/clients'))return [{id:5,name:'Cliente sintético'}];
    if(u.pathname.endsWith('/locations')){if(b){const row={id:3,...b};saved.push(row);return row;}return saved;}
    if(u.pathname.endsWith('/route'))return {id:7,distance_meters:123400,duration_seconds:7200,provider:'synthetic-test-only',geometry:{type:'LineString',coordinates:[[-73,-36],[-70,-33]]},snapped_points:[{lat:-36,lng:-73,distance:150},{lat:-33,lng:-70,distance:0}]};
    throw Error('Unexpected request '+url);
   }};
   document.querySelector('form').onsubmit=e=>{e.preventDefault();submissions.push(Object.fromEntries(new FormData(e.target)));};
  });
  await page.addScriptTag({path:path.join(__dirname,'../public/location-picker.js')});
  await page.getByRole('button',{name:'Definir origen en mapa'}).click();await page.locator('[data-region] option[value="1"]').waitFor({state:'attached'});await page.locator('[data-region]').selectOption('1');await page.locator('[data-commune] option[value="2"]').waitFor({state:'attached'});await page.locator('[data-commune]').selectOption('2');await page.locator('[data-locality] option[value="3"]').waitFor({state:'attached'});await page.locator('[data-locality]').selectOption('3');
  // Selecting a locality only moves the map; no entrance coordinate is assumed.
  await page.locator('[data-name]').fill('Aserradero sintético · portón norte');await page.getByRole('button',{name:'Guardar ubicación y seleccionar'}).click();assert.match(await page.locator('.location-error').innerText(),/Marca el acceso/);assert.equal(await page.evaluate(()=>sent.filter(x=>x.url.endsWith('/locations')).length),0);
  await page.locator('[data-map]').click({position:{x:160,y:120}});assert.notEqual(await page.locator('[data-lat]').inputValue(),'');await page.locator('[data-notes]').fill('Ingreso por portón de prueba');await page.locator('[data-client]').selectOption('5');
  if(process.env.FLEETCHILE_LOCATION_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_LOCATION_REVIEW_DIR,'location-map-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Guardar ubicación y seleccionar'}).click();await page.locator('.location-dialog').waitFor({state:'detached'});assert.equal(await page.locator('[name=origin_location_id]').inputValue(),'3');
  await page.getByRole('button',{name:'Definir destino en mapa'}).click();await page.getByRole('button',{name:/Bodega sintética/}).click();await page.locator('.location-dialog').waitFor({state:'detached'});await page.getByRole('button',{name:'Calcular recorrido vial'}).click();await page.locator('[data-access-review]').waitFor({timeout:3000}).catch(async()=>{throw Error((await page.locator('[data-info]').innerText())+' / '+JSON.stringify(errors));});assert.equal(await page.locator('[name=distance_km]').inputValue(),'123.4');assert.equal(await page.locator('.location-route-map .leaflet-overlay-pane path').count(),3);
  await page.getByRole('button',{name:'Guardar',exact:true}).click();assert.equal(await page.evaluate(()=>submissions.length),0);await page.locator('[data-access-review]').check();await page.getByRole('button',{name:'Guardar',exact:true}).click();assert.equal(await page.evaluate(()=>submissions.length),1);const submitted=await page.evaluate(()=>submissions[0]);assert.equal(submitted.road_route_id,'7');assert.equal(submitted.route_access_ack,'true');
  await page.getByRole('button',{name:'Definir destino en mapa'}).click();await page.getByRole('button',{name:/Planta sintética/}).click();assert.equal(await page.locator('[name=road_route_id]').inputValue(),'');assert.equal(await page.locator('[name=distance_km]').inputValue(),'');
  // Same form element is reused by the SPA, so controls must be attached anew.
  await page.evaluate(()=>{document.querySelector('form').innerHTML='<div class="formgrid"><input name="origin"><input name="destination"><button>Guardar carga</button></div>';});await page.getByRole('button',{name:'Definir origen en mapa'}).waitFor();assert.equal(await page.getByRole('button',{name:'Definir origen en mapa'}).count(),1);
  await page.setViewportSize({width:390,height:850});await page.getByRole('button',{name:'Definir origen en mapa'}).click();await page.locator('[data-region] option[value="1"]').waitFor({state:'attached'});assert.ok(await page.evaluate(()=>document.querySelector('.location-panel').scrollWidth<=document.querySelector('.location-panel').clientWidth));
  if(process.env.FLEETCHILE_LOCATION_REVIEW_DIR)await page.screenshot({path:path.join(process.env.FLEETCHILE_LOCATION_REVIEW_DIR,'location-map-mobile.png'),fullPage:true});
  await page.evaluate(()=>{localStorage.setItem('fleet_company_context','20');document.body.appendChild(document.createElement('div'));});await page.locator('.location-dialog').waitFor({state:'detached'});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
