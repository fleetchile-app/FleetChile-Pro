const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');

test('server resuelve company scope moderno desde resolveActorContext',()=>{
  assert.match(source,/const companyId=req=>\{const actor=resolveActorContext\(req\);if\(actor\?\.scope==='company'\)return actor\.company_id\|\|null;/);
  assert.match(source,/actor\?\.actor_type==='unresolved'\|\|actor\?\.scope!==['"]company['"]\|\|!actor\.company_id/);
});

test('dashboard rechaza platform y unresolved sin contexto empresarial',()=>{
  assert.match(source,/app\.get\("\/api\/dashboard"[\s\S]*?actor\?\.actor_type==='unresolved'\|\|actor\?\.scope!==['"]company['"]\|\|!actor\.company_id[\s\S]*?403/);
  assert.match(source,/where company_id=\$1/);
});

test('CRUD genérico no permite platform sin contexto y mantiene filtro company',()=>{
  assert.match(source,/const requireTablePermission=permissions=>[\s\S]*?resolveActorContext\(req\)[\s\S]*?actor\?\.actor_type==='unresolved'\|\|actor\?\.scope!==['"]company['"]\|\|!actor\.company_id/);
  assert.match(source,/select \* from \$\{req\.params\.table\} where company_id=\$1/);
  assert.match(source,/delete from \$\{req\.params\.table\} \$\{filter\}/);
});

test('historial GPS aplica ownership del truck y rechaza contexto ausente',()=>{
  assert.match(source,/app\.get\("\/api\/trucks\/:id\/history"[\s\S]*?t\.company_id=\$2/);
  assert.match(source,/telemetry\.truck_id=\$1/);
});

test('compatibilidad legacy queda aislada del camino moderno',()=>{
  assert.match(source,/const isLegacyAdmin=req=>req\.user\?\.role_code==='admin'&&!req\.user\?\.membership_id&&!req\.user\?\.platform_membership_id/);
  assert.match(source,/actor\?\.actor_type==='legacy'\)return isAdmin\(req\)\?/);
  assert.doesNotMatch(source,/const companyId=req=>isAdmin\(req\)\?\(req\.body\?\.company_id\|\|null\):\(req\.user\?\.company_id\|\|null\)/);
});

test('GET CRUD genérico filtra por company_id efectivo',()=>{
  assert.match(source,/app\.get\("\/api\/:table"[\s\S]*?where company_id=\$1 order by id desc/);
  assert.match(source,/companyId\(req\)/);
});

test('DELETE CRUD genérico incluye ownership empresarial',()=>{
  assert.match(source,/app\.delete\("\/api\/:table\/:id"[\s\S]*?where id=\$1 and company_id=\$2/);
});

test('creaciones directas usan resourceCompanyId y no body.company_id',()=>{
  for(const route of ['/api/trucks','/api/routes','/api/loads','/api/fuel','/api/maintenance']){
    const start=source.indexOf(`app.post("${route}"`);
    assert.ok(start>=0,`Ruta no encontrada: ${route}`);
    const end=source.indexOf('\napp.',start+1);
    const fragment=source.slice(start,end<0?source.length:end);
    if(route==='/api/loads')assert.match(fragment,/requireCreationCompany/);else assert.match(fragment,/req\.resourceCompanyId/);
    assert.doesNotMatch(fragment,/body\.company_id/);
  }
});

test('truck history protege el acceso A→A y A→B mediante la relación truck→company',()=>{
  const start=source.indexOf('app.get("/api/trucks/:id/history"');
  const fragment=source.slice(start,source.indexOf('\n\n//',start)<0?source.length:source.indexOf('\n\n//',start));
  assert.match(fragment,/where telemetry\.truck_id=\$1/);
  assert.match(fragment,/and t\.company_id=\$2/);
  assert.match(fragment,/actor\?\.actor_type==='unresolved'\|\|actor\?\.scope!==['"]company['"]\|\|!actor\.company_id/);
});

test('dashboard moderno utiliza company scope y no permite plataforma sin contexto',()=>{
  const start=source.indexOf('app.get("/api/dashboard"');
  const fragment=source.slice(start,source.indexOf('\n\n//',start)<0?source.length:source.indexOf('\n\n//',start));
  assert.match(fragment,/where company_id=\$1/);
  assert.match(fragment,/companyId\(req\)/);
  assert.match(fragment,/res\.status\(403\)/);
});

test('server no usa query.company_id como autoridad',()=>{
  assert.doesNotMatch(source,/req\.query\.company_id/);
  assert.match(source,/const companyId=req=>\{const actor=resolveActorContext\(req\)/);
});
