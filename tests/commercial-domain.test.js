'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('../commercial-domain');
const now=new Date('2026-10-16T00:00:00Z');
const plan={id:1,...D.plan({code:'fixture',name:'Plan fixture',max_equipment:5,allowed_modules:D.MODULES,included_modules:['operations']})};
const body=()=>({kind:'initial',quantities:{truck:3},unit_prices:{truck:1000},modules:['maintenance'],module_prices:{maintenance:100},period_from:'2026-10-01T00:00:00Z',period_until:'2026-11-01T00:00:00Z',valid_until:'2026-10-20T00:00:00Z',reason:'Acuerdo fixture'});
test('máximo de plan no equivale a cupos ni cobra por categoría de plan',()=>{const q=D.quote(body(),plan,null,now);assert.equal(q.configuration.max_equipment,5);assert.equal(q.configuration.quantities.truck,3);assert.equal(q.configuration.unit_prices.trailer,null);assert.equal(q.amount_clp,3100);assert.deepEqual(q.configuration.modules,['maintenance','operations']);});
test('cantidades, precios y módulos inválidos no se convierten en valores inventados',()=>{
 for(const changes of [{quantities:{truck:6}},{quantities:{truck:-1}},{quantities:{truck:'3'}},{unit_prices:{}},{unit_prices:{truck:NaN}},{unit_prices:{truck:1.5}},{modules:['unknown']},{modules:['gps','gps']},{module_prices:{}}])assert.throws(()=>D.quote({...body(),...changes},plan,null,now));
 assert.equal(D.quote({...body(),unit_prices:{truck:0}},plan,null,now).amount_clp,100);
});
test('módulos incluidos se conservan y el plan limita los adicionales',()=>{assert.throws(()=>D.plan({code:'x',name:'x',max_equipment:5,allowed_modules:['operations'],included_modules:['gps']}));assert.throws(()=>D.quote(body(),{...plan,allowed_modules:['operations']},null,now),/no permite/);});
test('ampliación prorratea solo la diferencia y conserva precios anteriores',()=>{
 const initial=D.quote(body(),plan,null,now),current={...initial};const b={...body(),kind:'expansion',quantities:{truck:4}};
 const q=D.quote(b,plan,current,now);assert.equal(q.amount_clp,Math.round(1000*16/31));assert.equal(q.configuration.period_price_clp,4100);assert.equal(q.period_until,initial.period_until);
 for(const patch of [{quantities:{truck:2}},{unit_prices:{truck:2000}},{modules:[]},{period_until:'2026-12-01T00:00:00Z'}])assert.throws(()=>D.quote({...b,...patch},plan,current,now));
});
test('ampliación admite categoría nueva con precio explícito y módulo nuevo contratado',()=>{
 const current=D.quote(body(),plan,null,now),b={...body(),kind:'expansion',quantities:{truck:3,trailer:1},unit_prices:{truck:1000,trailer:500},modules:['maintenance','gps'],module_prices:{maintenance:100,gps:200}};
 const q=D.quote(b,plan,current,now);assert.equal(q.amount_clp,Math.round(700*16/31));assert.equal(q.configuration.quantities.trailer,1);
});
test('renovación mantiene fecha común; ampliación de período futuro cobra diferencia completa',()=>{
 const current=D.quote(body(),plan,null,now);assert.throws(()=>D.quote({...body(),kind:'renewal'},plan,current,now),/comenzar/);
 const future={...current,period_from:'2026-11-01T00:00:00.000Z',period_until:'2026-12-01T00:00:00.000Z'};
 const q=D.quote({...body(),kind:'expansion',quantities:{truck:4},period_from:future.period_from,period_until:future.period_until},plan,future,now);assert.equal(q.amount_clp,1000);
});
test('propuesta vencida, período inválido y activación inicial repetida se rechazan',()=>{
 assert.throws(()=>D.quote({...body(),valid_until:'2026-10-15T00:00:00Z'},plan,null,now));assert.throws(()=>D.quote({...body(),period_until:body().period_from},plan,null,now));assert.throws(()=>D.quote(body(),plan,D.quote(body(),plan,null,now),now));
});
test('clasifica APIs modernas y heredadas sin confundir GPS con operaciones',()=>{
 for(const path of ['/api/driver/trips/1/positions','/api/fleet/trucks/2/position','/api/trucks/2/location'])assert.equal(D.moduleFor(path),'gps');
 assert.equal(D.moduleFor('/api/fleet/work-orders/1/receive'),'maintenance');assert.equal(D.moduleFor('/api/maintenance'),'maintenance');assert.equal(D.moduleFor('/api/driver/trips/1/deliveries'),'pod');assert.equal(D.moduleFor('/api/economics/reports'),'reports');assert.equal(D.moduleFor('/api/platform/commercial/plans'),null);
 assert.equal(D.moduleFor('/API/ECONOMICS/trips/1/costs/'),'economics');assert.equal(D.moduleFor('/API/FLEET/TRUCKS/2/POSITION/'),'gps');
 assert.equal(D.moduleFor('/api/financial-support/cost/1'),'economics');assert.equal(D.moduleFor('/api/financial-support/source/1'),'economics');assert.equal(D.moduleFor('/api/financial-support/fuel/1'),'fuel');
});
