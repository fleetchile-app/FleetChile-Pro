const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('UX de contexto distingue GLOBAL y bloquea módulos company-scoped sin empresa',()=>{
  const auth=fs.readFileSync('public/auth.js','utf8');
  const app=fs.readFileSync('public/app.js','utf8');
  assert.match(auth,/PLATAFORMA GLOBAL/);
  assert.match(auth,/Contexto empresarial activo/);
  assert.match(app,/companyScopedMenus/);
  assert.match(app,/Selecciona una empresa para continuar/);
});

test('Administración expone identidad moderna y nombre accesible',()=>{
  const auth=fs.readFileSync('auth.js','utf8');
  const admin=fs.readFileSync('public/admin.js','utf8');
  assert.match(auth,/modern_role_code/);
  assert.match(auth,/platform_role_code/);
  assert.match(admin,/aria-label','Administración'/);
});
