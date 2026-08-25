const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('migración 019 asocia drivers con integridad de empresa y sin backfill',()=>{
  const sql=read('migrations/019_driver_user_assignment.sql');
  assert.match(sql,/ADD COLUMN IF NOT EXISTS driver_id INTEGER/);
  assert.match(sql,/REFERENCES drivers\(id\)[\s\S]*ON DELETE SET NULL/);
  assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS uq_users_driver_id/);
  assert.match(sql,/CREATE TRIGGER trg_validate_user_driver_company/);
  assert.match(sql,/driver_company<>NEW\.company_id/);
  assert.doesNotMatch(sql,/UPDATE users SET driver_id/);
});

test('userView obtiene driver_id desde la sesión confiable',()=>{
  assert.match(read('auth.js'),/u\.company_id,u\.driver_id,u\.role_id/);
});

test('superficie driver exige rol y asociación, sin identidad enviada por cliente',()=>{
  const js=read('public/driver.js');
  assert.match(js,/role_code!=='driver'/);
  assert.match(js,/!Auth\.user\.driver_id/);
  assert.match(js,/Auth\.login\(data\.email,data\.password\)/);
  assert.doesNotMatch(js,/driver_id\s*:/);
});

test('shell PWA y ruta driver están disponibles sin cachear APIs',()=>{
  const html=read('public/driver.html');
  const manifest=JSON.parse(read('public/manifest.webmanifest'));
  const sw=read('public/service-worker.js');
  assert.match(html,/data-surface="driver"/);
  assert.equal(manifest.start_url,'/driver');
  assert.equal(manifest.icons.length,2);
  assert.match(sw,/request\.url\.includes\('\/api\/'\)\)return/);
  assert.doesNotMatch(sw.split('self.addEventListener')[0],/\/api\//);
  assert.match(read('server.js'),/app\.get\("\/driver"/);
});
