const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const auth=fs.readFileSync(path.join(__dirname,'..','auth.js'),'utf8');
const economics=fs.readFileSync(path.join(__dirname,'..','economics-api.js'),'utf8');

test('usuarios usa active real para memberships y no pm.status',()=>{
  assert.match(auth,/platform_memberships pm[\s\S]*?pm\.active=true/);
  assert.match(auth,/user_memberships um[\s\S]*?um\.active=true/);
  assert.doesNotMatch(auth,/pm\.status\s*=/);
  assert.doesNotMatch(auth,/um\.status\s*=/);
});

test('catálogos de roles respetan la separación por código y permissions.scope',()=>{
  assert.match(auth,/where code in \('company_admin','manager','operations','maintenance','driver','viewer'\)/);
  assert.match(auth,/where code='platform_superadmin'/);
  assert.doesNotMatch(auth,/select id,name,scope from roles/);
});

test('KPIs califican status de maintenance y vehicle_checklists',()=>{
  assert.match(economics,/m\.status='Pendiente'/);
  assert.match(economics,/m\.status not in \('Completada','Cancelada'\)/);
  assert.match(economics,/vc\.status='Aprobado'/);
  assert.match(economics,/vc\.status in \('Rechazado','Reprobado'\)/);
});
