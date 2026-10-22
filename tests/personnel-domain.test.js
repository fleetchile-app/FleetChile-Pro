'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const domain=require('../personnel-domain');

const validRut='12.345.678-5';
const person={name:'Ana Pérez',rut:validRut,birth_date:'1990-01-02',job_title:'Conductora'};

test('RUT normaliza, formatea y valida dígito verificador',()=>{
  assert.equal(domain.normalizeRut(' 12.345.678-k '),'12345678-K');
  assert.equal(domain.formatRut('12345678-5'),'12.345.678-5');
  assert.equal(domain.validateRut(validRut),true);
  for(const value of ['',null,'12.345.678-6','00000000-0','123456789-5','abc'])assert.equal(domain.validateRut(value),false,String(value));
});

test('validación de persona exige nombre, RUT, fecha no futura y cargo acotado',()=>{
  assert.deepEqual(domain.validatePerson(person,{today:'2026-10-22'}).value,{name:'Ana Pérez',rut:'12345678-5',birth_date:'1990-01-02',job_title:'Conductora'});
  assert.match(domain.validatePerson({...person,rut:'12345678-6'}).error,/RUT/);
  assert.match(domain.validatePerson({...person,birth_date:'2026-10-23'},{today:'2026-10-22'}).error,/nacimiento/);
  assert.match(domain.validatePerson({...person,birth_date:'1990-02-30'}).error,/nacimiento/);
  assert.match(domain.validatePerson({...person,name:' '.repeat(161)}).error,/nombre/);
  assert.match(domain.validatePerson({...person,job_title:'x'.repeat(161)}).error,/Cargo/);
  assert.equal(domain.validatePerson({name:'Borrador',job_title:''},{draft:true}).value.rut,null);
  assert.match(domain.validatePerson({name:'Borrador',job_title:''}).error,/RUT/);
});

test('validación parcial distingue campos ausentes de campos inválidos',()=>{
  assert.deepEqual(domain.validatePerson({job_title:' Nuevo '},{partial:true}),{value:{job_title:'Nuevo'}});
  assert.match(domain.validatePerson({job_title:'x'.repeat(161)},{partial:true}).error,/Cargo/);
  assert.match(domain.validatePerson({rut:'12345678-6'},{partial:true}).error,/RUT/);
  assert.match(domain.validatePerson({birth_date:'2026-02-30'},{partial:true}).error,/nacimiento/);
});

test('contratos cubren indefinido, fijo, día y evento',()=>{
  assert.deepEqual(domain.validateContract({type:'indefinite',start_date:'2026-01-01',event_name:''}).value,{type:'indefinite',start_date:'2026-01-01',end_date:null,event_name:null});
  assert.deepEqual(domain.validateContract({type:'fixed',start_date:'2026-01-01',end_date:'2026-01-31',event_name:''}).value,{type:'fixed',start_date:'2026-01-01',end_date:'2026-01-31',event_name:null});
  assert.deepEqual(domain.validateContract({type:'day',start_date:'2026-01-01',end_date:'2026-01-01',event_name:''}).value,{type:'day',start_date:'2026-01-01',end_date:'2026-01-01',event_name:null});
  assert.deepEqual(domain.validateContract({type:'event',start_date:'2026-01-01',end_date:'2026-01-02',event_name:'  Obra  '}).value,{type:'event',start_date:'2026-01-01',end_date:'2026-01-02',event_name:'Obra'});
  for(const input of [{type:'unknown',start_date:'2026-01-01'},{type:'indefinite',start_date:'2026-01-01',end_date:'2026-01-02'},{type:'fixed',start_date:'2026-01-02',end_date:'2026-01-01'},{type:'day',start_date:'2026-01-01',end_date:'2026-01-02'},{type:'event',start_date:'2026-01-01',end_date:'2026-01-02',event_name:''}])assert.ok(domain.validateContract(input).error);
});

test('condiciones exigen tipo y rango válido',()=>{
  assert.deepEqual(domain.validateCondition({type:'medical_leave',start_date:'2026-01-01',end_date:'2026-01-03'}).value,{type:'medical_leave',start_date:'2026-01-01',end_date:'2026-01-03'});
  for(const input of [{type:'bad',start_date:'2026-01-01',end_date:'2026-01-02'},{type:'vacation',start_date:'2026-01-03',end_date:'2026-01-02'},{type:'vacation',start_date:'2026-02-30',end_date:'2026-03-01'}])assert.match(domain.validateCondition(input).error,/Condición|condición|Selecciona/);
});

test('licencia valida clases, emisión, deduplica y aplica prórroga efectiva',()=>{
  const result=domain.validateLicense({classes:['B','B','A2'],issued_date:'2025-01-01',printed_expiry:'2025-06-30'});
  assert.deepEqual(result.value.classes,['B','A2']);
  assert.equal(result.value.effective_expiry,'2026-12-31');
  assert.equal(domain.licenseEffectiveExpiry('2026-08-31'),'2027-02-28');
  assert.equal(domain.licenseEffectiveExpiry('2024-08-31'),'2024-08-31');
  for(const input of [{classes:[],printed_expiry:'2026-01-01'},{classes:['Z'],printed_expiry:'2026-01-01'},{classes:['B'],printed_expiry:'2026-02-30'},{classes:['B'],issued_date:'2026-02-02',printed_expiry:'2026-02-01'}])assert.ok(domain.validateLicense(input).error);
});

function eligibility(overrides={}){return domain.evaluateEligibility({person:{id:1,user_id:9,driver_id:null,contract_exempt:false,...person},contracts:[{start_date:'2026-01-01',end_date:null}],conditions:[],licenses:[],role_code:'operations',today:'2026-10-22',...overrides});}

test('eligibilidad bloquea cuenta, membership, persona, contrato y condición activa',()=>{
  assert.equal(eligibility().allowed,true);
  assert.ok(eligibility({account_active:false}).reasons.includes('ACCOUNT_DISABLED'));
  assert.ok(eligibility({membership_active:false}).reasons.includes('MEMBERSHIP_DISABLED'));
  assert.ok(eligibility({person:null}).reasons.includes('PERSON_NOT_REGULARIZED'));
  assert.ok(eligibility({contracts:[]}).reasons.includes('CONTRACT_MISSING'));
  assert.ok(eligibility({contracts:[{start_date:'2026-12-01',end_date:null}]}).reasons.includes('CONTRACT_NOT_STARTED'));
  assert.ok(eligibility({contracts:[{start_date:'2025-01-01',end_date:'2026-01-01'}]}).reasons.includes('CONTRACT_EXPIRED'));
  assert.ok(eligibility({conditions:[{start_date:'2026-10-01',end_date:'2026-10-31'}]}).reasons.includes('CONDITION_ACTIVE'));
  assert.equal(eligibility({contracts:[{start_date:'2026-01-01',end_date:'2026-10-22'}]}).allowed,true);
});

test('retorno condicionado y licencia de conductor son fail-closed',()=>{
  const driver={driver_id:7};
  assert.ok(eligibility({person: {...person,id:1,user_id:9,...driver},role_code:'driver'}).reasons.includes('DRIVER_LICENSE_MISSING'));
  assert.ok(domain.validateLicense({classes:['A5'],issued_date:'2098-01-01',printed_expiry:'2099-01-01'},{today:'2026-10-22'}).error);
  assert.ok(eligibility({person:{...person,id:1,user_id:9,...driver},role_code:'driver',licenses:[{current:true,classes:['A5'],issued_date:'2098-01-01',effective_expiry:'2099-01-01'}]}).reasons.includes('DRIVER_LICENSE_MISSING'));
  assert.ok(eligibility({person: {...person,id:1,user_id:9,...driver},role_code:'driver',licenses:[{current:true,classes:['B'],effective_expiry:'2026-10-21'}]}).reasons.includes('DRIVER_LICENSE_EXPIRED'));
  assert.equal(eligibility({person: {...person,id:1,user_id:9,...driver},role_code:'driver',licenses:[{current:true,classes:['B'],effective_expiry:'2026-10-22'}]}).allowed,true);
  assert.ok(eligibility({person: {...person,id:1,user_id:9,driver_id:null},role_code:'driver',licenses:[{current:true,classes:['B'],effective_expiry:'2026-12-31'}]}).reasons.includes('DRIVER_NOT_ASSOCIATED'));
});

test('exención solo para company_admin exige registro completo y omite regularización',()=>{
  const exempt={...person,id:1,user_id:9,contract_exempt:true,exemption_by:2,exemption_at:'2026-10-01'};
  assert.equal(eligibility({person:exempt,role_code:'company_admin',contracts:[]}).allowed,true);
  const incomplete=eligibility({person:{...exempt,exemption_by:null},role_code:'company_admin',contracts:[]});
  assert.equal(incomplete.allowed,false);assert.ok(incomplete.reasons.includes('CONTRACT_MISSING'));
  assert.ok(eligibility({person:{...exempt},role_code:'manager',contracts:[]}).reasons.includes('CONTRACT_MISSING'));
});
