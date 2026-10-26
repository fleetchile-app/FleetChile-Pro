const test=require('node:test');
const assert=require('node:assert/strict');
const {userView,authMiddleware,resolveActorContext,isPlatformOwner}=require('../auth');
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

async function authenticated(raw,header='10',{companyExists=true}={}){
 const calls=[];
 const pool={async query(sql,values=[]){
  calls.push({sql,values});
  if(sql.startsWith('select s.user_id from user_sessions'))return {rows:[{user_id:raw.id}],rowCount:1};
  if(sql.includes('po.owner_type ownership_role')){assert.deepEqual(values,[raw.id]);return {rows:[raw],rowCount:1};}
  if(sql.startsWith('update user_sessions'))return {rows:[],rowCount:0};
  if(sql==='select id from companies where id=$1 and active=true'){assert.deepEqual(values,[10]);return {rows:companyExists?[{id:10}]:[],rowCount:companyExists?1:0};}
  throw Error('Unexpected query '+sql);
 }};
 const req={get:name=>name==='authorization'?'Bearer test-session':name==='x-company-context'?header:''};
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(payload){this.payload=payload;return this;}};
 let next=0;await authMiddleware(pool,req,res,()=>next++);return {req,res,next,calls};
}
test('native platform context is request-scoped without employment enforcement or synthetic company privileges',async()=>{
 const raw={id:1,name:'Plataforma',company_id:null,legacy_permissions:[],memberships:[],
  platform_memberships:[{id:99,active:true,role_code:'platform_superadmin',permissions:['platform.users.manage']}],personnel_state:{...snapshot,person:{id:70},conditions:[{type:'medical_leave'}]}};
 const {req,res,next}=await authenticated(raw);
 assert.equal(res.statusCode,200);assert.equal(next,1);assert.equal(req.user.actor_type,'platform');assert.equal(req.user.scope,'platform');assert.equal(req.user.company_id,null);
 assert.deepEqual(req.user.permissions,['platform.users.manage']);assert.equal(req.user.personnel_state,null);assert.equal(req.personnelAccess,undefined);
 const c=resolveActorContext(req);assert.equal(c.scope,'company');assert.equal(c.company_id,10);assert.equal(c.actor_type,'platform');assert.deepEqual(c.permissions,['platform.users.manage']);
});
test('selected company must exist even for a verified platform owner',async()=>{
 const raw={id:1,company_id:null,memberships:[],legacy_permissions:[],platform_memberships:[{id:99,active:true,role_code:'platform_superadmin',permissions:[]}],ownership_role:'primary',ownership_active:true};
 const {req,res,next}=await authenticated(raw,'10',{companyExists:false});assert.equal(res.statusCode,403);assert.equal(next,0);assert.equal(req.user,undefined);
});
test('ownership metadata cannot turn a blocked company employee into a platform owner',async()=>{
 const blocked={...snapshot,policy:{enforced:true,time_zone:'America/Santiago'},person:{id:70,user_id:7,rut:'12345678-5',birth_date:'1990-01-01'},contracts:[{type:'indefinite',start_date:'2000-01-01'}],conditions:[{type:'medical_leave',start_date:'2000-01-01',end_date:'2099-01-01'}]};
 const raw={id:7,company_id:10,legacy_permissions:[],platform_memberships:[],memberships:[{id:11,company_id:10,active:true,role_code:'company_admin',permissions:['company.people.manage']}],ownership_role:'primary',ownership_active:true,personnel_state:blocked};
 const {req,res,next}=await authenticated(raw,'');assert.equal(res.statusCode,403);assert.equal(next,0);assert.equal(isPlatformOwner(req.user),false);assert.equal(req.user.actor_type,'company');assert.equal(res.payload.code,'PERSONNEL_ACCESS_BLOCKED');assert.equal(JSON.stringify(res.payload).includes('medical'),false);
});
