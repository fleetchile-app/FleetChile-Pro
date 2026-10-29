'use strict';
// Browser recovery uses the real SPA, IndexedDB and WebCrypto, but synthetic API responses.
// It is not Android hardware or a production storage acceptance test.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Chrome PWA: firma/foto, borrador cifrado tras recarga y respuesta POD perdida sin duplicar',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT,timeout:60000},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
  const user={id:8,company_id:10,driver_id:4,role_code:'driver',name:'Conductor sintético'},payloads=[],accepted=new Set();let loseResponse=true;
  const trip={id:7,trip_number:'POD-SYNTH',status:'Llegó a destino',origin:'Origen sintético',destination:'Destino sintético',truck_id:3,loads:[{id:9,cargo:'Madera sintética',status:'Planificada',weight_kg:100}]};
  await page.addInitScript(()=>localStorage.setItem('fleet_token','synthetic-local-only'));
  await page.route('https://qa-driver.invalid/**',async route=>{
   const request=route.request(),url=new URL(request.url()),p=url.pathname;
   if(p.startsWith('/api/')){
    let data={};
    if(p==='/api/auth/status')data={setupRequired:false};else if(p==='/api/auth/me')data={user};
    else if(p==='/api/driver/trips')data=[trip];else if(p==='/api/driver/trips/7')data=trip;
    else if(p.endsWith('/allowed-statuses'))data={allowed_statuses:[]};
    else if(p.endsWith('/workflow'))data={version:0,resource_version:0,accepted_at:new Date().toISOString(),status:trip.status,loads:[],next_stop:null};
    else if(p.endsWith('/checklist'))data={checklists:[]};
    else if(p.endsWith('/deliveries')){
     if(request.method()==='POST'){
      const body=request.postDataJSON();payloads.push(body);accepted.add(body.client_submission_id);
      if(loseResponse){loseResponse=false;return route.abort('failed');}data={status:'CLOSED'};
     }else data={deliveries:trip.loads.map(l=>({...l,deliveries:[]}))};
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   if(p==='/service-worker.js')return route.fulfill({contentType:'application/javascript',body:''});
   const filename=p==='/driver'?'driver.html':path.basename(p),file=path.join(__dirname,'../public',filename);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)});
  });
  async function openForm(){await page.getByRole('button',{name:/POD-SYNTH/}).click();await page.getByRole('button',{name:'Entregar',exact:true}).click();await page.locator('.delivery-recipient').waitFor();await page.waitForFunction(()=>document.querySelector('.driver-delivery-form [role=status]')!==null);}
  await page.goto('https://qa-driver.invalid/driver');await openForm();
  await page.locator('.delivery-recipient').fill('Receptor privado QA');
  const canvas=page.locator('.signature-host canvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+130,box.y+55,{steps:10});await page.mouse.up();
  const photo=await require('sharp')({create:{width:64,height:64,channels:3,background:'#173b5d'}}).png().toBuffer();
  await page.locator('.delivery-photo').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:photo});
  await page.waitForFunction(async()=>{const draft=await DriverMobile.draft('draft-delivery-7-9');return Boolean(draft?.payload?.signature&&draft.payload.photo);});
  const raw=await page.evaluate(async()=>new Promise((resolve,reject)=>{const r=indexedDB.open('fleetchile-driver-private-v1',1);r.onerror=()=>reject(Error('IndexedDB'));r.onsuccess=()=>{const tx=r.result.transaction('records'),q=tx.objectStore('records').getAll();q.onsuccess=()=>{const rows=q.result;resolve(rows.map(x=>({id:x.id,bytes:x.bytes,data:x.data instanceof ArrayBuffer,readable:JSON.stringify(x).includes('Receptor privado QA')})));r.result.close();};};}));
  assert.ok(raw.some(r=>r.data));assert.ok(raw.every(r=>!r.readable));
  await page.reload();await openForm();await page.getByText('Borrador recuperado del teléfono. Revisa los datos antes de enviarlo.').waitFor();
  assert.equal(await page.locator('.delivery-recipient').inputValue(),'Receptor privado QA');assert.equal(await page.locator('.delivery-preview').isVisible(),true);
  assert.equal(await page.evaluate(()=>Boolean(document.querySelector('.signature-host canvas').value())),true,'La firma recuperada debe habilitar el envío, no sólo dibujarse');
  await page.getByRole('button',{name:'Confirmar entrega',exact:true}).click();await page.getByText('Sin confirmación del servidor. Conservamos el envío para reintentar con la misma identificación.',{exact:true}).waitFor().catch(async e=>{assert.fail(await page.locator('body').innerText());});
  assert.equal(payloads.length,1);assert.equal(accepted.size,1);
  await page.getByRole('button',{name:'Sincronizar pendientes',exact:true}).click();await page.waitForFunction(async()=>{const vault=DriverVault.create(Auth.user);return (await vault.list()).length===0;});
  assert.equal(payloads.length,2);assert.equal(accepted.size,1);assert.equal(payloads[0].client_submission_id,payloads[1].client_submission_id);assert.equal(payloads[0].signature,payloads[1].signature);assert.equal(payloads[0].photo,payloads[1].photo);
 }finally{await browser.close();}
});
