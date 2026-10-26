'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {roadAlert,reconcileVehicleDocumentAlerts,startVehicleDocumentMonitor}=require('../vehicle-document-alerts');
const row={truck_id:7,patente:'BBJJ25',kind:'soap',expires_at:'2027-01-01',status:'Vigente'};
for(const [days,band] of [[31,null],[30,'30'],[16,'30'],[15,'15'],[8,'15'],[7,'7'],[0,'7'],[-1,'expired']])test(`documentación vial: umbral ${days} días`,()=>{
 const result=roadAlert({...row,days_remaining:days});
 if(band===null)assert.equal(result,null);else{assert.equal(result.condition_code,`road_soap_${band}`);assert.equal(result.level,band==='expired'?'critical':'warning');}
});
test('documentación faltante o anulada genera alerta crítica',()=>{
 for(const extra of [{expires_at:null},{status:'Anulado',days_remaining:50}]){
  const result=roadAlert({...row,...extra});assert.equal(result.condition_code,'road_soap_missing');assert.equal(result.level,'critical');
 }
});
test('reconciliación separa empresa, usa fecha local y resuelve solamente alertas viales',async()=>{
 const calls=[];let released=0;
 const query=async(sql,args=[])=>{calls.push({sql,args});if(sql.startsWith('select c.id'))return {rows:[{id:3}]};if(sql.includes('cross join'))return {rows:[{...row,days_remaining:15}]};return {rows:[],rowCount:1};};
 const result=await reconcileVehicleDocumentAlerts({query,connect:async()=>({query,release(){released++;}})},{companyId:3});
 assert.deepEqual(result,{changed:1,resolved:1});assert.equal(released,1);
 assert.deepEqual(calls[0].args,[3]);assert.match(calls.find(x=>x.sql.includes('cross join')).sql,/now\(\) at time zone pp.time_zone/);
 const insert=calls.find(x=>x.sql.startsWith('insert into alerts'));assert.match(insert.sql,/on conflict/);assert.equal(JSON.parse(insert.args[1])[0].condition_code,'road_soap_15');
 const close=calls.find(x=>x.sql.startsWith('update alerts'));assert.match(close.sql,/left\(condition_code,5\)='road_'/);assert.deepEqual(close.args,[3,['7:road_soap_15']]);assert.equal(calls.at(-1).sql,'COMMIT');
});
test('reconciliación revierte fallos y siempre libera conexión',async()=>{
 const calls=[];let released=false;
 const query=async sql=>{calls.push(sql);if(sql.startsWith('select c.id'))return {rows:[{id:3}]};if(sql.includes('cross join'))throw Error('database failure');return {rows:[]};};
 await assert.rejects(reconcileVehicleDocumentAlerts({query,connect:async()=>({query,release(){released=true;}})}),/database failure/);
 assert.equal(calls.at(-1),'ROLLBACK');assert.equal(released,true);
});
test('monitor ejecuta revisión inmediata y su cierre espera el trabajo pendiente',async()=>{
 let finish,started=false;const pending=new Promise(resolve=>{finish=resolve;});
 const stop=startVehicleDocumentMonitor({query:async()=>{started=true;await pending;return {rows:[]};}},{intervalMs:100000});
 assert.equal(started,true);let stopped=false;const closing=stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);finish();await closing;assert.equal(stopped,true);
});
