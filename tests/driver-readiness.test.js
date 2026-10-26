'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertDriverOperationalReady}=require('../driver-readiness');

function dbFor({person=true,registration=true,contract=true,license=true}={}){
 const calls=[];return {calls,async query(sql,params){calls.push({sql,params});
  if(sql.includes('from user_memberships'))return {rows:[{membership_id:4,user_id:8,membership_active:true,account_active:true,role_code:'driver'}]};
  if(sql.includes('from company_people'))return {rows:person?[{id:12,driver_id:3,user_id:8}]:[]};
  if(sql.includes('from drivers'))return {rows:registration?[{id:3,company_id:2,status:'Activo',operational_registered_at:'2026-01-01T00:00:00Z',profile_version:1}]:[]};
  if(sql.includes('from person_contracts'))return {rowCount:contract?1:0,rows:[]};
  if(sql.includes('from person_conditions'))return {rowCount:0,rows:[]};
  if(sql.includes('from person_driver_licenses'))return {rows:license?[{effective_expiry:'2099-12-31'}]:[]};
  return {rows:[]};
 }};
}

test('conductor operacional antiguo no obtiene grandfather bypass sin persona',async()=>{
 const db=dbFor({person:false});await assert.rejects(()=>assertDriverOperationalReady(db,{companyId:2,driverId:3}),error=>{
  assert.equal(error.status,409);assert.equal(error.code,'DRIVER_NOT_OPERATIONAL_READY');assert.deepEqual(error.reasons,['PERSON_MISSING']);return true;
 });
});
test('ready exige cuenta, membresía, persona, contrato y licencia',async()=>{
 const db=dbFor();const result=await assertDriverOperationalReady(db,{companyId:2,driverId:3,lock:true});assert.equal(result.ready,true);assert.equal(result.personId,12);
 const locked=db.calls.filter(x=>/user_memberships|company_people|from drivers/.test(x.sql)).map(x=>x.sql);assert.match(locked[0],/user_memberships/);assert.match(locked[1],/company_people/);assert.match(locked[2],/from drivers/);assert.equal(locked.every(sql=>/for update/.test(sql)),true);
});
test('no altera el contexto del actor y explica bloqueo de licencia',async()=>{
 const db=dbFor({license:false});const context={company_id:2,driver_id:3};await assert.rejects(()=>assertDriverOperationalReady(db,{companyId:2,driverId:3}),error=>{assert.match(error.message,/licencia/i);return true});assert.deepEqual(context,{company_id:2,driver_id:3});
});
test('normaliza fechas PostgreSQL y licencia nula siempre bloquea',()=>{
 const fs=require('node:fs'),source=fs.readFileSync(require('node:path').join(__dirname,'..','driver-readiness.js'),'utf8');
 assert.match(source,/effective_expiry::text/);assert.match(source,/!license\?\.effective_expiry/);assert.match(source,/companyDate\(now,policy\.time_zone\)/);
});

test('licencia vencida se bloquea como fecha SQL, objeto Date, nula o inválida',async()=>{
 for(const expiry of ['2000-01-01',new Date('2000-01-01T00:00:00Z'),null,'invalid']){
  const db=dbFor(),query=db.query.bind(db);db.query=async(sql,args)=>sql.includes('from person_driver_licenses')?{rows:[{effective_expiry:expiry}]}:query(sql,args);
  await assert.rejects(assertDriverOperationalReady(db,{companyId:2,driverId:3,now:new Date('2026-10-22T12:00:00Z')}),error=>error.code==='DRIVER_NOT_OPERATIONAL_READY'&&error.reasons.includes('LICENSE_MISSING_OR_EXPIRED'));
 }
});
