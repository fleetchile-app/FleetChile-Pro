const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const migration=fs.readFileSync(path.join(__dirname,'..','migrations','027_seed_chile_dpa_2023.sql'),'utf8');
const catalog=fs.readFileSync(path.join(__dirname,'..','migrations','026_global_geography_catalog.sql'),'utf8');

test('DPA 2023 seed is official, idempotent and limited to global region/province/commune catalog',()=>{
  assert.match(migration,/SUBDERE \/ IDE SUBDERE/);
  assert.match(migration,/Limites_Comunales\.shp\.kmz/);
  assert.match(migration,/ON CONFLICT \(official_code\) DO UPDATE/g);
  assert.equal((migration.match(/ON CONFLICT \(official_code\) DO UPDATE/g)||[]).length,3);
  assert.doesNotMatch(migration,/geo_localities|company_id|DELETE\s+FROM/i);
  assert.match(migration,/INSERT INTO geo_regions/);
  assert.match(migration,/INSERT INTO geo_provinces/);
  assert.match(migration,/INSERT INTO geo_communes/);
});

test('DPA 2023 seed contains the inspected official hierarchy without duplicate codes',()=>{
  const regionBlock=migration.match(/INSERT INTO geo_regions[\s\S]*?ON CONFLICT/)[0];
  const provinceBlock=migration.match(/INSERT INTO geo_provinces[\s\S]*?ON CONFLICT/)[0];
  const communeBlock=migration.match(/INSERT INTO geo_communes[\s\S]*?ON CONFLICT/)[0];
  const count=(text)=> (text.match(/^\s*\('(?:[^']|'')*',/gm)||[]).length;
  assert.equal(count(regionBlock),16);
  assert.equal(count(provinceBlock),56);
  assert.equal(count(communeBlock),345);
  assert.equal(new Set([...regionBlock.matchAll(/\('([^']+)',/g)].map(m=>m[1])).size,16);
  assert.equal(new Set([...provinceBlock.matchAll(/\('([^']+)',/g)].map(m=>m[1])).size,56);
  assert.equal(new Set([...communeBlock.matchAll(/\('([^']+)',/g)].map(m=>m[1])).size,345);
});

test('DPA catalog schema is global and enforces hierarchy with unique official codes',()=>{
  assert.doesNotMatch(catalog,/company_id/i);
  assert.match(catalog,/official_code TEXT NOT NULL UNIQUE/);
  assert.match(catalog,/region_id BIGINT NOT NULL REFERENCES geo_regions\(id\)/);
  assert.match(catalog,/province_id BIGINT NOT NULL REFERENCES geo_provinces\(id\)/);
  assert.match(catalog,/CREATE INDEX IF NOT EXISTS idx_geo_provinces_region/);
  assert.match(catalog,/CREATE INDEX IF NOT EXISTS idx_geo_communes_province/);
});
