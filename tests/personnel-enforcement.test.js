const test=require('node:test');
const assert=require('node:assert/strict');
const {userView}=require('../auth');
const fs=require('fs');
const path=require('path');

const snapshot={company_id:10,policy:{enforced:false,time_zone:'America/Santiago'},regularization_eligible:true,person:null,
  membership:{active:true,role_code:'company_admin'},account_active:true,contracts:[],conditions:[],licenses:[]};

test('userView conserva snapshot interno sin serializar datos personales',async()=>{
  const raw={id:7,name:'Admin',email:'a@test',company_id:99,role_code:'viewer',role_name:'Viewer',
    legacy_permissions:[],memberships:[{id:10,company_id:10,active:true,role_code:'company_admin',permissions:[]}],
    platform_memberships:[],personnel_state:snapshot,ownership_active:false};
  const user=await userView({query:async()=>({rows:[raw],rowCount:1})},7);
  assert.deepEqual(user.personnel_state,snapshot);
  assert.equal(Object.keys(user).includes('personnel_state'),false);
  assert.equal(JSON.stringify(user).includes('personnel_state'),false);
  assert.equal(Object.getOwnPropertyDescriptor(user,'personnel_state').enumerable,false);
});

test('el snapshot no trata una política ausente como false',()=>{
  const auth=fs.readFileSync(path.join(__dirname,'..','auth.js'),'utf8');
  assert.match(auth,/coalesce\(\(select pp\.enforced[\s\S]*\),true\)/);
});

test('auth y operaciones mantienen el contrato de bloqueo sin exponer razones médicas',()=>{
  const auth=fs.readFileSync(path.join(__dirname,'..','auth.js'),'utf8');
  const operations=fs.readFileSync(path.join(__dirname,'..','operations-api.js'),'utf8');
  assert.match(auth,/PERSONNEL_ACCESS_BLOCKED/);
  assert.match(operations,/PERSONNEL_ACCESS_BLOCKED/);
  assert.doesNotMatch(operations,/PERSONNEL_ACCESS_BLOCKED[^\n]*medical|medical[^\n]*PERSONNEL_ACCESS_BLOCKED/i);
});

test('las operaciones driver conservan sus transiciones y operaciones sensibles',()=>{
  const operations=fs.readFileSync(path.join(__dirname,'..','operations-api.js'),'utf8');
  for(const token of ['driverAllowedStatuses','trip_status_history','trip_delivery_proofs','vehicle_checklists','telemetry'])assert.match(operations,new RegExp(token));
});
