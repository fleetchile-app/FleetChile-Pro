'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');

for(const [label,user,search,expected] of [
 ['plataforma',{actor_type:'platform',platform_membership_id:1,permissions:['platform.users.manage']},'','platform'],
 ['empresa',{actor_type:'company',company_id:1,permissions:['economics.read']},'','linked'],
 ['enlace viaje',{actor_type:'platform',platform_membership_id:1,permissions:['platform.users.manage']},'?trip=3&company=80','linked'],
 ['soporte',{actor_type:'platform',role_code:'platform_support',platform_membership_id:1},'','support'],
 ['enlace viaje de soporte',{actor_type:'platform',role_code:'platform_support',platform_membership_id:1},'?trip=3&company=80','linked']
])test('inicio compatible sin ampliar permisos: '+label,async()=>{
 const calls=[],el={classList:{add(){},remove(){}},textContent:''},source=fs.readFileSync(require.resolve('../public/auth'),'utf8').split(/\r?\n/).find(l=>l.startsWith('async function authBoot'));
 const context={Auth:{user,token:'synthetic',async status(){return {};},async me(){},async logout(){throw Error('No debe cerrar sesión');}},document:{body:{dataset:{}},querySelector:()=>el,getElementById:()=>el},authBox:()=>el,renderActiveIdentity:async()=>{},location:{search},URLSearchParams,window:{platformAdministration:async tab=>calls.push(tab==='support'?'support':'platform'),openLinkedTrip:async()=>calls.push('linked')}};
 vm.createContext(context);vm.runInContext(source,context);await context.authBoot();assert.deepEqual(calls,[expected]);
});

test('Chrome: inicio de plataforma conserva su vista aunque el dashboard anterior falle tarde',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});let release;
 const delayed=new Promise(resolve=>{release=resolve;});
 try{
  const page=await browser.newPage(),user={id:85,name:'Plataforma QA',actor_type:'platform',platform_membership_id:1,role_code:'platform_superadmin',permissions:['platform.users.manage','platform.companies.manage','platform.context.switch']};page.setDefaultTimeout(7000);
  await page.addInitScript(()=>localStorage.setItem('fleet_token','synthetic-local-fixture'));
  const index=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*https:[^>]*>/g,'').replace('</body>','<script src="auth.js"></script><script src="executive-kpis.js"></script><script src="app.js"></script><script src="admin.js"></script></body>');
  await page.route('https://qa-boot.invalid/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/api/')){
    if(p==='/api/economics/kpis'){await delayed;return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Permiso requerido: economics.read'})});}
    const summary={companies:{total:0,active:0,inactive:0},users:{total:0,active:0},company_memberships:{active:0},platform_memberships:{active:1,total:1},recent_audit_30d:0};
    const data=p==='/api/auth/me'?{user}:p==='/api/admin/platform-summary'?summary:p==='/api/auth/status'?{setupRequired:false}:p==='/api/public/settings'?{}:[];
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   if(p==='/')return route.fulfill({contentType:'text/html',body:index});
   const file=path.join(__dirname,'../public',path.basename(p));return route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(file)});
  });
  await page.goto('https://qa-boot.invalid/',{waitUntil:'domcontentloaded'});await page.getByText('Empresas activas',{exact:true}).waitFor();release();await page.waitForTimeout(300);
  assert.match(await page.locator('#title').innerText(),/Resumen global/);assert.doesNotMatch(await page.locator('#app').innerText(),/Permiso requerido|No se pudo cargar la sección/);
 }finally{release();await browser.close();}
});

test('Chrome: modal sobre drawer, selector sobre modal y camión seleccionado de flota',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
  await page.route('https://qa.invalid/**',r=>{
   const url=new URL(r.request().url()),p=url.pathname;
   if(p.startsWith('/api/')){
    let body=[];if(p.endsWith('/clients'))body=[{id:3,name:'Cliente QA',rut:'QA'}];else if(p==='/api/loads/resources')body={trucks:[{id:7,patente:'QA-AUD',tipo:'Camión'}]};else if(p==='/api/location-picker/catalog')body={regions:[],communes:[],localities:[]};else if(p==='/api/location-picker/locations')body=[{id:1,name:'Origen QA'},{id:2,name:'Destino QA'}];else if(r.request().method()==='POST')body={id:1};
    return r.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   }
   return r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><nav id="nav"></nav><main><header><h1 id="title"></h1><button id="newBtn">Nuevo</button></header><section id="app"></section></main><span id="health"></span><div id="drawer"><div class="drawer"><button id="dx">Cerrar panel</button><div id="drawerBody">Panel del viaje</div></div></div><div id="modal" class="hidden"><div class="modal"><button id="x">Cerrar formulario</button><h2 id="mt"></h2><form id="form"></form></div></div></body></html>'});
  });
  await page.goto('https://qa.invalid/');
  for(const f of ['styles.css','sidebar.css','location-picker.css'])await page.addStyleTag({path:path.join(__dirname,'../public',f)});
  await page.evaluate(()=>{window.Auth={user:{actor_type:'company',company_id:80},request:async(url,o)=>{const r=await fetch(url,o);return r.json();}};window.setInterval=()=>0;});
  for(const f of ['executive-kpis.js','app.js','location-picker.js'])await page.addScriptTag({path:path.join(__dirname,'../public',f)});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.evaluate(()=>{document.getElementById('drawer').classList.remove('hidden');return openForm('loads');});
   assert.equal(await page.locator('#form input[name=truck]').count(),0);assert.equal(await page.locator('#form select[name=truck]').getAttribute('required'),null);
   await page.locator('#form select[name=truck]').selectOption('QA-AUD');await page.locator('[name=client_id]').selectOption('3');
   for(const n of ['guide','cargo','weight_kg','volume_m3','value_clp'])await page.locator('#form [name='+n+']').fill('1');
   await page.getByRole('button',{name:'Definir origen en mapa',exact:true}).click();await page.getByRole('button',{name:/Origen QA/}).click();
   await page.getByRole('button',{name:'Definir destino en mapa',exact:true}).click();await page.getByRole('button',{name:/Destino QA/}).click();
   assert.equal(await page.locator('#drawer .drawer').isVisible(),true);
   const request=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/api/loads');await page.getByRole('button',{name:'Guardar',exact:true}).click();const sent=(await request).postDataJSON();assert.equal(sent.truck,'QA-AUD');assert.equal(sent.client_id,'3');assert.equal(sent.origin_location_id,'1');assert.equal(sent.destination_location_id,'2');
   await page.locator('#modal').waitFor({state:'hidden'});
  }
 }finally{await browser.close();}
});
