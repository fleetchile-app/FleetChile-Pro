const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');

const migration=fs.readFileSync(path.join(__dirname,'..','migrations','024_platform_ownership.sql'),'utf8');
const auth=fs.readFileSync(path.join(__dirname,'..','auth.js'),'utf8');
const admin=fs.readFileSync(path.join(__dirname,'..','admin-api.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');

test('ownership es independiente de memberships y queda limitado a cuatro slots',()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS platform_owners/);
  assert.match(migration,/slot SMALLINT PRIMARY KEY CHECK \(slot BETWEEN 1 AND 4\)/);
  assert.match(migration,/user_id BIGINT NOT NULL UNIQUE/);
  assert.match(migration,/pg_advisory_xact_lock\(8246\)/);
  assert.match(migration,/NEW\.slot <= 2.*primary/);
  assert.match(migration,/NEW\.slot >= 3.*backup/);
});

test('la identidad moderna expone ownership sin reemplazar actor ni rol',()=>{
  assert.match(auth,/po\.owner_type ownership_role/);
  assert.match(auth,/ownership_role:row\.ownership_role\|\|null/);
  assert.match(auth,/actor_type:effective\.actor_type/);
});

test('gobierno de propietarios exige ownership en backend y audita mutaciones',()=>{
  assert.match(admin,/const ownerOnly=/);
  assert.match(admin,/app\.get\('\/api\/admin\/owners',ownerOnly/);
  assert.match(admin,/app\.post\('\/api\/admin\/owners',ownerOnly/);
  assert.match(admin,/app\.patch\('\/api\/admin\/owners\/:slot',ownerOnly/);
  assert.match(admin,/app\.delete\('\/api\/admin\/owners\/:slot',ownerOnly/);
  assert.ok((admin.match(/entity:'platform_owner'/g)||[]).length>=3);
});

test('la consola reserva la sección de propietarios al actor ownership',()=>{
  assert.match(ui,/window\.adminOwner=u\.ownership_role/);
  assert.match(ui,/\['owners','Propietarios'\]/);
  assert.match(ui,/admin\/owners/);
});
