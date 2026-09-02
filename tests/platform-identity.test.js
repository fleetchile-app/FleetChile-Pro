const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {resolveActorContext,resolveEffectiveMembership,userView,requireScopedPermission,requirePermission}=require('../auth');

const effective=(overrides={})=>resolveEffectiveMembership({company_id:10,role_code:'operations',permissions:['trips.manage'],...overrides});

test('resolveEffectiveMembership usa membership aunque users.company_id difiera o sea null',()=>{
  assert.equal(effective({company_id:10,memberships:[{id:1,company_id:10,role_code:'company_admin',permissions:['company.users.manage']}]}).company_id,10);
  const different=effective({company_id:20,memberships:[{id:1,company_id:10,role_code:'company_admin',permissions:['company.users.manage']}]});
  assert.equal(different.actor_type,'company');assert.equal(different.company_id,10);assert.equal(different.role,'company_admin');
  const noLegacy=effective({company_id:null,memberships:[{id:1,company_id:10,role_code:'operations',permissions:['trips.manage']}]});
  assert.equal(noLegacy.company_id,10);assert.equal(noLegacy.actor_type,'company');
});

test('resolver distingue legacy, contexto múltiple y plataforma',()=>{
  assert.equal(effective({company_id:10}).actor_type,'legacy');
  assert.equal(effective({memberships:[{id:1,company_id:10},{id:2,company_id:20}]}).reason,'company_context_required');
  const platform=effective({company_id:10,memberships:[{id:1,company_id:10}],platform_memberships:[{id:7,role_code:'platform_superadmin',permissions:['platform.companies.manage']}]});
  assert.equal(platform.actor_type,'platform');assert.equal(platform.company_id,null);assert.equal(platform.role,'platform_superadmin');
});

test('rol y permisos efectivos provienen de membership moderna',()=>{
  const result=effective({company_id:20,role_code:'admin',permissions:['platform.companies.manage'],memberships:[{id:3,company_id:10,role_code:'company_admin',permissions:['company.users.manage']}]});
  assert.equal(result.role,'company_admin');assert.deepEqual(result.permissions,['company.users.manage']);
});

test('userView proyecta company_id moderno desde membership y conserva legacy separado',async()=>{
  const pool={query:async()=>({rows:[{id:4,company_id:20,role_code:'admin',role_name:'Administrador',permissions:['platform.companies.manage'],memberships:[{id:8,company_id:10,role_code:'operations',permissions:['trips.manage'],active:true}],platform_memberships:[],legacy_permissions:['platform.companies.manage']}]})};
  const user=await userView(pool,4);
  assert.equal(user.company_id,10);assert.equal(user.legacy_company_id,20);assert.equal(user.role_code,'operations');assert.deepEqual(user.permissions,['trips.manage']);
});

test('el resolver distingue contexto de plataforma y empresa',()=>{
  const platform=resolveActorContext({user:{id:1,scope:'platform',company_id:null,platform_membership_id:4,permissions:['platform.companies.manage'],role_code:'platform_superadmin'}});
  assert.equal(platform.actor_type,'platform');assert.equal(platform.scope,'platform');assert.equal(platform.company_id,null);assert.equal(platform.platform_membership_id,4);assert.equal(platform.role,'platform_superadmin');
  const company=resolveActorContext({user:{id:2,scope:'company',company_id:8,membership_id:5,permissions:['company.users.manage'],role_code:'company_admin'}});
  assert.equal(company.scope,'company');
  assert.equal(company.company_id,8);
});

test('los permisos scoped no cruzan plataforma y empresa',()=>{
  const middleware=requireScopedPermission('platform.companies.manage','platform');
  let next=false;const res={status(){return this},json(){return this}};
  middleware({user:{id:2,scope:'company',company_id:8,permissions:['platform.companies.manage']}},res,()=>{next=true});
  assert.equal(next,false);
});

test('un admin legacy no conserva el bypass cuando ya tiene membership scoped',()=>{
  const middleware=requirePermission('platform.companies.manage');let next=false;
  const res={status(){return this},json(){return this}};
  middleware({user:{role_code:'admin',scope:'company',membership_id:9,platform_membership_id:null,permissions:[]}},res,()=>{next=true});
  assert.equal(next,false);
});

test('platform_superadmin conserva permisos heredados al proyectar su identidad platform',()=>{
  const platform=resolveEffectiveMembership({legacy_permissions:['clients.manage'],platform_memberships:[{id:7,role_code:'platform_superadmin',permissions:[]}],company_id:99});
  assert.equal(platform.actor_type,'platform');assert.equal(platform.company_id,null);assert.deepEqual(platform.permissions,['clients.manage']);
});

test('la migración declara memberships y scopes formales sin backfill de plataforma',()=>{
  const sql=fs.readFileSync('migrations/022_platform_company_identity.sql','utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS user_memberships/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS platform_memberships/);
  assert.match(sql,/scope IN \('platform','company'\)/);
  assert.match(sql,/ON CONFLICT \(user_id,company_id\) DO NOTHING/);
  assert.doesNotMatch(sql,/INSERT INTO platform_memberships/);
});
