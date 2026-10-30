'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('ejecutivo presenta completados, delta conciliado, conductores y motivos sin perder filtros ni desbordar móvil',{skip:!process.env.FLEETCHILE_TEST_PLAYWRIGHT},async()=>{
 const {chromium}=require(process.env.FLEETCHILE_TEST_PLAYWRIGHT),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="app"></main></body></html>');
  await page.addStyleTag({path:path.join(__dirname,'../public/styles.css')});await page.addStyleTag({path:path.join(__dirname,'../public/executive-kpis.css')});await page.addScriptTag({path:path.join(__dirname,'../public/executive-kpis.js')});
  await page.evaluate(()=>{
   window.A=document.getElementById('app');window.Auth={user:{company_id:38}};window.calls=[];
   window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.money=v=>'$'+Number(v).toLocaleString('es-CL');window.k=(l,v,f)=>`<div class="card"><div class="label">${l}</div><div class="value">${v}</div><div>${f}</div></div>`;
   window.get=async url=>{calls.push(url);return url.startsWith('economics/kpis')?{company_id:38,operations:{completed:2,compliance:{completed:2,denominator:2,percentage:100},loads:{registered:2,delivered:2},trips_by_status:{Completado:2}},economics:{recognized_revenue:{amount:450000,trips:1},recognized_costs:{amount:89600,trips:1},delta:{provisional:0,reconciled:360400,missing_data_trips:1},delta_per_km:{provisional:null,reconciled:720.8,coverage:{provisional:{eligible_trips:0,with_distance:0},reconciled:{eligible_trips:1,with_distance:1}}},missing_trips:[{trip_id:2,trip_number:'V-QA-2',status:'Completado',reasons:['revenue_unconfirmed','costs_unrecognized']}]},fleet:{active:2,maintenance:0,drivers_active:1},checklist:{approved:2,pending:0,rejected:0},documents:{expired:0},maintenance:{overdue:0},alerts:{open:0}}:[];};
  });
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').split(/\r?\n/).find(l=>l.startsWith('async function renderKpiDashboard('));assert.ok(source);await page.addScriptTag({content:source});
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>renderKpiDashboard({from:'2026-10-01'}));
   const card=label=>page.locator('.card').filter({has:page.locator('.label',{hasText:label})});
   assert.match(await card('Cumplimiento').innerText(),/100%/);assert.match(await card('Conductores activos').innerText(),/1/);assert.doesNotMatch(await card('Delta/km conciliado').innerText(),/N\/D/);assert.match(await card('Delta/km provisional').innerText(),/Sin viajes provisionales/);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  const link=page.getByRole('link',{name:'V-QA-2'});assert.equal(await link.getAttribute('href'),'/?trip=2&company=38');assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noopener/);
  assert.match(await page.locator('#kpiMissingTrips').innerText(),/Sin costos reconocidos/);assert.ok((await page.evaluate(()=>calls)).some(u=>u.includes('from=2026-10-01')));assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
