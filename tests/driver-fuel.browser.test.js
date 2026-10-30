'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Chrome: combustible con foto, borrador cifrado y respuesta perdida sin duplicar',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:90000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
  const user={id:8,company_id:10,driver_id:4,role_code:'driver',name:'Conductor QA'},sent=[],accepted=new Set();let lose=true;
  const trip={id:7,trip_number:'FUEL-SYNTH',status:'En tránsito',origin:'Origen',destination:'Destino',truck_id:3,patente:'QA-001',loads:[]};
  await page.addInitScript(()=>localStorage.setItem('fleet_token','synthetic-test-only'));
  await page.route('https://qa-fuel.invalid/**',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(p.startsWith('/api/')){
    let data={};
    if(p==='/api/auth/status')data={setupRequired:false};else if(p==='/api/auth/me')data={user};
    else if(p==='/api/driver/trips')data=[trip];else if(p==='/api/driver/trips/7')data=trip;
    else if(p.endsWith('/workflow'))data={version:0,resource_version:0,accepted_at:new Date().toISOString(),status:trip.status,loads:[],next_stop:null};
    else if(p.endsWith('/checklist'))data={checklists:[]};else if(p.endsWith('/deliveries'))data={deliveries:[]};
    else if(p.endsWith('/fuel')){const b=req.postDataJSON();sent.push(b);accepted.add(b.client_key);if(lose){lose=false;return route.abort('failed');}data={photo_received:true,fuel_id:1};}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   if(p==='/service-worker.js')return route.fulfill({contentType:'application/javascript',body:''});
   const name=p==='/driver'?'driver.html':path.basename(p),file=path.join(__dirname,'../public',name);
   return route.fulfill({status:fs.existsSync(file)?200:404,contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.existsSync(file)?fs.readFileSync(file):''});
  });
  const open=async()=>{await page.getByRole('button',{name:/FUEL-SYNTH/}).click();await page.getByRole('button',{name:'Registrar combustible',exact:true}).click();await page.locator('.driver-fuel form').waitFor();};
  await page.goto('https://qa-fuel.invalid/driver');await open();
  const form=page.locator('.driver-fuel form');await form.locator('[name=liters]').fill('50');await form.locator('[name=odometer_km]').fill('12345');await form.locator('[name=total_clp]').fill('65000');await form.locator('[name=payment_method]').selectOption('agreement');
  await form.getByRole('button',{name:'Guardar combustible',exact:true}).click();await page.getByText('Fotografía el comprobante antes de guardar, cualquiera sea el medio de pago.',{exact:true}).waitFor();assert.equal(sent.length,0);
  const png=await require('sharp')({create:{width:64,height:64,channels:3,background:'#173b5d'}}).png().toBuffer();
  await form.locator('[data-fuel-photo]').setInputFiles({name:'qa.png',mimeType:'image/png',buffer:png});
  await page.waitForFunction(async()=>Boolean((await DriverMobile.draft('draft-fuel-7'))?.payload?.photo));
  await page.reload();await open();assert.equal(await form.locator('[name=liters]').inputValue(),'50');assert.equal(await form.locator('[data-fuel-preview]').isVisible(),true);
  await form.getByRole('button',{name:'Guardar combustible',exact:true}).click();await page.getByText('Guardado en este teléfono; falta confirmación. Usa Sincronizar pendientes. No vuelvas a registrar el mismo comprobante.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Sincronizar pendientes',exact:true}).click();await page.waitForFunction(async()=>(await DriverVault.create(Auth.user).list()).length===0);
  assert.equal(sent.length,2);assert.equal(accepted.size,1);assert.equal(sent[0].photo,sent[1].photo);assert.equal(sent[0].client_key,sent[1].client_key);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser.close();}
});
