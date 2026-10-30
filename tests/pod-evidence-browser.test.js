'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('Chrome: POD administrativo descarga por sesión, escapa texto y no mezcla respuestas de empresas',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:390,height:844}}),calls=[];let release;
  const delayed=new Promise(resolve=>{release=resolve;});
  await page.route('https://qa-pod.invalid/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname.includes('/files/')){calls.push(request.headers());return route.fulfill({contentType:'image/png',body:Buffer.from('verified server image fixture')});}
   if(url.pathname.endsWith('/pdf')){calls.push(request.headers());return route.fulfill({contentType:'application/pdf',body:Buffer.from('%PDF-1.4 synthetic private receipt')});}
   if(url.pathname.endsWith('/pod')){
    if(url.pathname.includes('/trips/2/'))await delayed;
    return route.fulfill({contentType:'application/json',body:JSON.stringify({proofs:[{id:3,cargo:'<img src=x onerror=alert(1)>',recipient_name:'Receptor sintético',status:'CLOSED',files:[{id:4,type:'signature'},{id:5,type:'photo'}]}]})});
   }
   return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="drawerBody"><div id="tripPanelDelivery"><div class="toolbar"><h3>POD</h3></div></div></div></body></html>'});
  });
  await page.goto('https://qa-pod.invalid/');
  await page.evaluate(()=>{localStorage.setItem('fleet_token','synthetic-local-session');localStorage.setItem('fleet_company_context','80');window.openTrip=async id=>{window.currentTripId=id;document.getElementById('tripPanelDelivery').innerHTML='<div class="toolbar"><h3>POD</h3></div>';};});
  await page.addScriptTag({path:path.join(__dirname,'../public/auth.js')});await page.evaluate(()=>{Auth.user={id:7,company_id:80};});
  await page.addScriptTag({path:path.join(__dirname,'../public/pod-evidence.js')});await page.evaluate(()=>openTrip(1));
  assert.equal(await page.locator('#tripPanelDelivery img').count(),0);assert.match(await page.locator('#tripPanelDelivery').innerText(),/<img src=x/);
  const receipt=page.waitForEvent('download');await page.getByRole('button',{name:'Generar comprobante PDF',exact:true}).click();assert.equal((await receipt).suggestedFilename(),'entrega-viaje-1-pod-3.pdf');
  for(const label of ['Descargar firma','Descargar fotografía']){
   const done=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const download=await done;assert.equal(download.suggestedFilename(),label==='Descargar firma'?'pod-1-4.png':'pod-1-5.png');
  }
  assert.equal(calls.length,3);assert.ok(calls.every(h=>h.authorization==='Bearer synthetic-local-session'&&h['x-company-context']==='80'));
  const work=page.evaluate(()=>openTrip(2));await page.waitForRequest(r=>new URL(r.url()).pathname==='/api/operations/trips/2/pod');
  await page.evaluate(()=>{localStorage.setItem('fleet_company_context','81');document.getElementById('tripPanelDelivery').textContent='Empresa B';});release();await work;
  assert.equal(await page.locator('#tripPanelDelivery').innerText(),'Empresa B');
 }finally{await browser.close();}
});
