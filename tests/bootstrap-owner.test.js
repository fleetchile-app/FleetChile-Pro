const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const migration=fs.readFileSync(path.join(__dirname,'..','migrations','025_bootstrap_platform_owner.sql'),'utf8');
const auth=fs.readFileSync(path.join(__dirname,'..','auth.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'..','public','auth.js'),'utf8');

test('bootstrap crea una identidad técnica con hash scrypt, membership y ownership',()=>{
  assert.match(migration,/root@fleetchile\.local/);
  assert.match(migration,/scrypt\$[a-f0-9]+\$[a-f0-9]+/);
  assert.doesNotMatch(migration,/password_hash[^\n]*FleetRoot-2026/);
  assert.match(migration,/platform_memberships\(user_id,role_id,active\)/);
  assert.match(migration,/platform_owners\(slot,user_id,owner_type,active\)/);
  assert.match(migration,/ON CONFLICT \(email\) DO NOTHING/);
  assert.match(migration,/must_change_password\)\n  VALUES[\s\S]*true\)/);
});

test('login expone cambio obligatorio y solo el endpoint autenticado cambia la contraseña',()=>{
  assert.match(auth,/u\.must_change_password/);
  assert.match(auth,/app\.post\('\/api\/auth\/change-password'/);
  assert.match(auth,/reauthenticateUser\(pool,user\.id,current\)/);
  assert.match(auth,/must_change_password=false/);
  assert.match(ui,/Auth\.user\.must_change_password/);
  assert.match(ui,/showChangePassword/);
});
