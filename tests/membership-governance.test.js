const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {resolveEffectiveMembership}=require('../auth');

const source=fs.readFileSync(require.resolve('../auth'),'utf8');

test('6-A registra APIs separadas para memberships de empresa y plataforma',()=>{
  assert.match(source,/\/api\/users\/:id\/memberships/);
  assert.match(source,/\/api\/companies\/:id\/memberships/);
  assert.match(source,/\/api\/user-memberships\/:id/);
  assert.match(source,/\/api\/users\/:id\/platform-membership/);
  assert.match(source,/\/api\/platform-memberships\/:id/);
});

test('6-A rechaza roles de plataforma en memberships de empresa y roles de empresa en plataforma',()=>{
  assert.match(source,/roleForScope\(client,req\.body\?\.role_id,'company'\)/);
  assert.match(source,/roleForScope\(client,req\.body\?\.role_id,'platform'\)/);
  assert.match(source,/No puedes asignar un rol de plataforma/);
  assert.match(source,/Rol de plataforma no válido/);
});

test('6-A mantiene la resolución moderna separada del legacy e ignora memberships inactivas',()=>{
  const company=resolveEffectiveMembership({company_id:99,role_code:'admin',legacy_permissions:['admin.legacy'],memberships:[{id:4,company_id:10,role_code:'company_admin',active:true},{id:5,company_id:20,role_code:'company_admin',active:false}]});
  assert.equal(company.actor_type,'company');
  assert.equal(company.company_id,10);
  assert.equal(company.role,'company_admin');
  const platform=resolveEffectiveMembership({company_id:99,memberships:[{id:4,company_id:10,active:true}],platform_memberships:[{id:8,role_code:'platform_superadmin',active:true,permissions:['platform.users.manage']}]});
  assert.equal(platform.actor_type,'platform');
  assert.equal(platform.company_id,null);
  assert.equal(platform.platform_membership_id,8);
});

test('6-A la creación moderna enlaza usuario con la membership correspondiente',()=>{
  assert.match(source,/insert into platform_memberships\(user_id,role_id,active\)/);
  assert.match(source,/insert into user_memberships\(user_id,company_id,role_id,active\)/);
});

test('6-B bloquea la modificación de la propia membership antes de mutar',()=>{
  assert.match(source,/preventSelfMembershipMutation/);
  assert.match(source,/No puedes modificar tu propia membership/);
  assert.match(source,/preventSelfMembershipMutation\('user_memberships'\)/);
  assert.match(source,/preventSelfMembershipMutation\('platform_memberships'\)/);
});
