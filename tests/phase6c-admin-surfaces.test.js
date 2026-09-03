const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const auth=fs.readFileSync(require.resolve('../auth'),'utf8');
const admin=fs.readFileSync(require.resolve('../public/admin.js'),'utf8');

test('6-C define superficies platform y company sin cambiar identidad',()=>{
  assert.match(admin,/adminSurface=u\.actor_type==='platform'\?'platform':'company'/);
  assert.match(admin,/ADMINISTRACIÓN DE PLATAFORMA/);
  assert.match(admin,/ADMINISTRACIÓN DE EMPRESA/);
});
test('6-C evita llamadas platform-only desde company admin',()=>{
  assert.match(admin,/window\.adminSurface==='company'&&u==='companies'/);
  assert.match(admin,/window\.adminSurface==='company'&&u==='roles'/);
  assert.match(admin,/company_admin','manager','operations','maintenance','driver','viewer/);
});
test('6-C ofrece catálogos de roles separados por scope en backend',()=>{
  assert.match(auth,/\/api\/company-roles/);
  assert.match(auth,/\/api\/platform-roles/);
  assert.match(auth,/code='platform_superadmin'/);
});
