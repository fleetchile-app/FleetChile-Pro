'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadEligibility,enforcePersonnelAccess,evaluateSnapshot}=require('../personnel-access');

const baseSnapshot={policy:{enforced:true,time_zone:'America/Santiago'},person:{id:10,user_id:9,rut:'12345678-5',birth_date:'1990-01-01',driver_id:null,contract_exempt:false},membership:{active:true,role_code:'operations'},account_active:true,contracts:[{start_date:'2026-01-01',end_date:null}],conditions:[],licenses:[]};
function dbFor(snapshot,{fail=false}={}){const calls=[];return {calls,async query(sql,values){calls.push({sql,values});if(fail)throw new Error('database failure');return {rows:[{personnel_state:snapshot}]}}};}

test('evaluateSnapshot deriva fecha por zona y conserva resultado fail-closed',()=>{
  const result=evaluateSnapshot(baseSnapshot,new Date('2026-10-23T02:00:00.000Z'));
  assert.equal(result.today,'2026-10-22');
  assert.equal(result.allowed,true);assert.equal(result.enforced,true);assert.equal(result.person_id,10);assert.equal(result.regularization_required,false);
  const blocked=evaluateSnapshot({...baseSnapshot,account_active:false},new Date('2026-10-22T12:00:00Z'));
  assert.equal(blocked.allowed,false);assert.equal(blocked.code,'PERSONNEL_ACCESS_BLOCKED');assert.ok(blocked.reasons.includes('ACCOUNT_DISABLED'));
});

test('evaluateSnapshot permite regularización solo sin persona, policy no enforced y cuenta/membership activas',()=>{
  const snapshot={...baseSnapshot,policy:{enforced:false,time_zone:'America/Santiago'},person:null,regularization_eligible:true};
  const allowed=evaluateSnapshot(snapshot,new Date('2026-10-22T12:00:00Z'));
  assert.deepEqual({allowed:allowed.allowed,enforced:allowed.enforced,regularization_required:allowed.regularization_required,reasons:allowed.reasons},{allowed:true,enforced:false,regularization_required:true,reasons:[]});
  assert.equal(evaluateSnapshot({...snapshot,account_active:false}).allowed,false);
  assert.equal(evaluateSnapshot({...snapshot,membership:{active:false,role_code:'operations'}}).allowed,false);
  assert.equal(evaluateSnapshot({...snapshot,regularization_eligible:false}).allowed,false);
  assert.equal(evaluateSnapshot({...snapshot,regularization_eligible:undefined}).allowed,false);
});

test('loadEligibility exige contexto y consulta snapshot por empresa/usuario',async()=>{
  await assert.rejects(loadEligibility(dbFor(baseSnapshot),{}),/Contexto de persona obligatorio/);
  const db=dbFor(baseSnapshot);const result=await loadEligibility(db,{companyId:10,userId:9,now:new Date('2026-10-22T12:00:00Z')});
  assert.equal(result.allowed,true);assert.equal(db.calls.length,1);assert.equal(db.calls[0].values[0],10);assert.equal(db.calls[0].values[1],9);assert.match(db.calls[0].sql,/company_personnel_policies/);assert.match(db.calls[0].sql,/company_people/);
});

test('loadEligibility con personId conserva aislamiento y no admite solo identificadores vacíos',async()=>{
  const db=dbFor(baseSnapshot);await loadEligibility(db,{companyId:10,personId:10});assert.deepEqual(db.calls[0].values,[10,null,10]);
  await assert.rejects(loadEligibility(dbFor(baseSnapshot),{companyId:10,userId:0,personId:0}),/Contexto de persona obligatorio/);
  assert.equal((await loadEligibility(dbFor(baseSnapshot),{companyId:10,userId:9})).allowed,true);
});

test('lock toma membership y persona en orden estable, luego recarga snapshot',async()=>{
  const db=dbFor(baseSnapshot);const result=await loadEligibility(db,{companyId:10,userId:9,personId:10,lock:true});
  assert.equal(result.allowed,true);assert.equal(db.calls.length,3);
  assert.ok(db.calls[0].sql.includes('user_memberships')&&db.calls[0].sql.includes('for update'));assert.ok(db.calls[1].sql.includes('company_people')&&db.calls[1].sql.includes('for update'));assert.match(db.calls[2].sql,/personnel_state/);
  assert.equal(db.calls.some(call=>/from companies.*for update/i.test(call.sql)),false);
  assert.deepEqual(db.calls[0].values,[10,9,10]);assert.deepEqual(db.calls[1].values,[10,9,10]);
});

test('snapshot provisto evita consultar y no permite saltarse evaluación',async()=>{
  const db=dbFor({...baseSnapshot,account_active:false});const result=await loadEligibility(db,{companyId:10,userId:9,snapshot:{...baseSnapshot,account_active:false}});
  assert.equal(db.calls.length,0);assert.equal(result.allowed,false);assert.ok(result.reasons.includes('ACCOUNT_DISABLED'));
});

test('errores de base de datos no se convierten en acceso permitido',async()=>{
  await assert.rejects(loadEligibility(dbFor(baseSnapshot,{fail:true}),{companyId:10,userId:9}),/database failure/);
  await assert.rejects(enforcePersonnelAccess(dbFor(baseSnapshot,{fail:true}),{user:{id:9,company_id:10,membership_id:99,actor_type:'user',scope:'company'}}),/database failure/);
});

test('enforcePersonnelAccess permite gobierno de plataforma pero nunca presume acceso legacy',async()=>{
  const db={async query(){throw new Error('no debe consultar')}};
  assert.deepEqual(await enforcePersonnelAccess(db,{user:{actor_type:'platform',scope:'platform',company_id:null}}),{allowed:true,enforced:false,reasons:[]});
  await assert.rejects(enforcePersonnelAccess(db,{user:{actor_type:'legacy',scope:'company',company_id:10,id:9,membership_id:null}}),/no debe consultar/);
});

test('enforcePersonnelAccess usa snapshot server-side y lock cuando es solicitado',async()=>{
  const db=dbFor(baseSnapshot);const result=await enforcePersonnelAccess(db,{user:{id:9,company_id:10,membership_id:99,actor_type:'user',scope:'company',personnel_state:baseSnapshot}},{lock:true});
  assert.equal(result.allowed,true);assert.equal(db.calls.length,3);assert.match(db.calls[0].sql,/user_memberships/);assert.match(db.calls[1].sql,/company_people/);assert.match(db.calls[2].sql,/personnel_state/);
});

test('snapshot sin política falla cerrado y no inventa acceso',()=>{
  assert.throws(()=>evaluateSnapshot({person:null,membership:{active:true},account_active:true}),/Política de personas no disponible/);
});
