'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('../maintenance-domain');
test('costos desconocidos no equivalen a cero; repuestos cancelados no suman',()=>{
 assert.equal(D.costs([]).actual,null);
 assert.equal(D.costs([{quantity:2,actual_unit_cost_clp:null,status:'done'}]).actual,null);
 assert.equal(D.costs([{quantity:2,actual_unit_cost_clp:0,status:'done'}]).actual,0);
 assert.equal(D.costs([{quantity:2,actual_unit_cost_clp:5000,status:'done'},{quantity:20,actual_unit_cost_clp:999,status:'cancelled'}]).actual,10000);
 assert.equal(D.costs([{quantity:1,actual_unit_cost_clp:5000,status:'done'},{quantity:1,actual_unit_cost_clp:null,status:'pending'}]).unknown_actual,1);
});
for(const input of [-1,true,{},[],NaN,Infinity,'abc'])test(`números de mantención rechazan ${JSON.stringify(input)}`,()=>assert.throws(()=>D.number(input,'Valor'),/no válido/));
test('fechas imposibles, futuras y sin zona no ingresan al historial',()=>{
 const now=new Date('2026-10-26T12:00:00Z');
 for(const value of ['2026-02-30T10:00:00Z','2027-01-01T10:00:00Z','2026-10-26T10:00','not-date'])assert.throws(()=>D.instant(value,'Ingreso',now));
 assert.equal(D.instant('2026-10-26T08:00:00-03:00','Ingreso',now),'2026-10-26T11:00:00.000Z');
});
test('rutinas requieren criterio positivo y precios CLP enteros; se preservan blancos como desconocidos',()=>{
 assert.throws(()=>D.routine({name:'Servicio'}),/intervalo/);assert.throws(()=>D.routine({name:'Servicio',km:-1}));
 assert.deepEqual(D.routine({name:'Servicio',days:30,km:1000,hours:100}),{name:'Servicio',days:30,km:1000,hours:100});
 const base={kind:'part',description:'Filtro',quantity:2};assert.equal(D.item({...base,actual_unit_cost_clp:''}).actual_unit_cost_clp,null);
 assert.throws(()=>D.item({...base,actual_unit_cost_clp:1.5}));assert.throws(()=>D.item({...base,quantity:0}));
});
test('versionado exige versión real y no permite identificadores ambiguos',()=>{
 D.version({work_order_version:2},'2');assert.throws(()=>D.version({work_order_version:2},1),e=>e.code==='MAINTENANCE_CONFLICT');
 for(const value of [null,0,{},true,'incorrecto'])assert.throws(()=>D.id(value));
});
