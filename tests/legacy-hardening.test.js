const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('6-F adminOnly no concede todos los permisos platform a cualquier actor',()=>{
  const source=fs.readFileSync('admin-api.js','utf8');
  assert.match(source,/actor_type==='platform'/);
  assert.match(source,/platform\.companies\.manage/);
  assert.match(source,/platform\.users\.manage/);
  assert.match(source,/role_code==='admin'.*!.*membership_id/);
});
