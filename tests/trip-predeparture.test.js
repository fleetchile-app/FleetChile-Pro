'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertPredeparture}=require('../trip-predeparture'),{resourceFailure}=require('../trip-eligibility');
const args={companyId:10,tripId:7,truckId:3,driverId:4};
const approved=()=>({status:'Aprobado',current_assignment:true,completed_at:'2026-10-29T00:00:00Z',completed_by:8,items:require('../public/checklist-shared').ids.map(id=>({id,result:'ok'}))});
function db({accept=true,check=approved()}={}){const calls=[];return {calls,async query(sql,values){calls.push({sql,values});return {rows:sql.includes('driver_mobile_actions')?(accept?[{id:1}]:[]):check?[check]:[]};}};}
test('sin aceptación de la asignación actual no inicia y explica el bloqueo',async()=>{
 const d=db({accept:false});await assert.rejects(assertPredeparture(d,args),e=>e.status===409&&e.code==='TRIP_ACCEPTANCE_REQUIRED');assert.equal(d.calls.length,1);assert.match(d.calls[0].sql,/t.resource_version=a.resource_version/);assert.deepEqual(d.calls[0].values,[10,7,4]);
});
for(const [label,check] of [['ausente',null],['vacío',{...approved(),items:[]}],['pendiente',{...approved(),status:'Pendiente'}],['rechazado',{...approved(),status:'Rechazado'}],['sin autor',{...approved(),completed_by:null}],['anterior a reemplazo',{...approved(),current_assignment:false}]])test('predespacho rechaza checklist '+label,async()=>{
 await assert.rejects(assertPredeparture(db({check}),args),e=>e.code==='TRIP_CHECKLIST_REQUIRED');
});
test('inspección completa de los recursos actuales permite salida sin alterar datos',async()=>{
 const d=db();await assertPredeparture(d,args);assert.equal(d.calls.length,2);assert.match(d.calls[1].sql,/order by vc.id desc limit 1/);assert.deepEqual(d.calls[1].values,[7,3,4,10]);assert.ok(d.calls.every(c=>c.sql.startsWith('select')));
});
test('errores predespacho se preservan como 409 sin datos privados',()=>{
 const res={status(n){this.code=n;return this;},json(v){this.body=v;return this;}};resourceFailure(res,{code:'TRIP_CHECKLIST_REQUIRED',message:'Completa el checklist'},'Error genérico');assert.equal(res.code,409);assert.equal(res.body.error,'Completa el checklist');
});
