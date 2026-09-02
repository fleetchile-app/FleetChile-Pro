const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {resolveActorContext}=require('../auth');

test('platform sin contexto conserva scope platform y no empresa implícita',()=>{
  const context=resolveActorContext({user:{id:1,actor_type:'platform',scope:'platform',company_id:null,platform_membership_id:7,permissions:['platform.users.manage']}});
  assert.equal(context.scope,'platform');
  assert.equal(context.company_id,null);
});

test('platform con contexto validado opera bajo la empresa seleccionada',()=>{
  const context=resolveActorContext({user:{id:1,actor_type:'platform',scope:'platform',company_id:null,platform_membership_id:7,permissions:['company.users.manage'],active_company_context:1}});
  assert.equal(context.actor_type,'platform');
  assert.equal(context.scope,'company');
  assert.equal(context.company_id,1);
  assert.equal(context.context_company_id,1);
});

test('el contexto platform habilita los handlers empresariales sin cambiar la identidad',()=>{
  const server=fs.readFileSync('server.js','utf8');
  const fleet=fs.readFileSync('fleet-api.js','utf8');
  const economics=fs.readFileSync('economics-api.js','utf8');
  assert.match(server,/actor\?\.scope!==['"]company['"]/);
  assert.match(fleet,/actor\.scope==='company'/);
  assert.match(economics,/actor\.scope!==['"]company['"]/);
});

test('platform puede cambiar de empresa sin alterar su identidad base',()=>{
  const first=resolveActorContext({user:{id:1,actor_type:'platform',scope:'platform',platform_membership_id:7,active_company_context:1}});
  const second=resolveActorContext({user:{id:1,actor_type:'platform',scope:'platform',platform_membership_id:7,active_company_context:2}});
  assert.equal(first.actor_type,'platform');assert.equal(first.company_id,1);
  assert.equal(second.actor_type,'platform');assert.equal(second.company_id,2);
  assert.equal(first.platform_membership_id,second.platform_membership_id);
});

test('company admin permanece en su membership aunque intente enviar otro contexto',()=>{
  const context=resolveActorContext({user:{id:2,actor_type:'company',scope:'company',company_id:1,membership_id:8,platform_membership_id:null,permissions:['company.users.manage'],active_company_context:2}});
  assert.equal(context.scope,'company');
  assert.equal(context.company_id,1);
});

test('el contexto requiere validacion backend y el frontend solo lo transporta',()=>{
  const auth=fs.readFileSync('auth.js','utf8');
  const frontend=fs.readFileSync('public/auth.js','utf8');
  assert.match(auth,/x-company-context/);
  assert.match(auth,/companies where id=\$1 and active=true/);
  assert.match(auth,/user\.actor_type==='platform'/);
  assert.match(frontend,/fleet_company_context/);
  assert.match(frontend,/X-Company-Context/);
});

test('todas las requests API del mismo origen reciben el contexto seleccionado',()=>{
  const frontend=fs.readFileSync('public/auth.js','utf8');
  assert.match(frontend,/new URL\(url,window\.location\.href\)/);
  assert.match(frontend,/parsed\.origin===window\.location\.origin/);
  assert.match(frontend,/parsed\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(frontend,/if\(isApi&&context\)headers\.set\('X-Company-Context',context\)/);
});

test('administracion reconoce permisos modernos y no solo admin legacy',()=>{
  const admin=fs.readFileSync('public/admin.js','utf8');
  assert.match(admin,/actor_type==='platform'/);
  assert.match(admin,/platform\.users\.manage/);
  assert.match(admin,/actor_type==='company'/);
  assert.match(admin,/company\.users\.manage/);
  assert.match(admin,/actor_type==='legacy'&&u\.role_code==='admin'/);
  assert.doesNotMatch(admin,/if\(me\.user\.role_code!==['"]admin/);
});
