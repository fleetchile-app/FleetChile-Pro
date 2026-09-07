const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const sql=fs.readFileSync('migrations/026_global_geography_catalog.sql','utf8');

test('catálogo geográfico global declara las cuatro tablas sin company_id',()=>{
  for(const table of ['geo_regions','geo_provinces','geo_communes','geo_localities'])assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.doesNotMatch(sql,/company_id/);
});

test('catálogo geográfico conserva la jerarquía mediante foreign keys',()=>{
  assert.match(sql,/region_id BIGINT NOT NULL REFERENCES geo_regions\(id\)/);
  assert.match(sql,/province_id BIGINT NOT NULL REFERENCES geo_provinces\(id\)/);
  assert.match(sql,/commune_id BIGINT NOT NULL REFERENCES geo_communes\(id\)/);
});

test('catálogo geográfico aplica unicidad e índices de carga futura sin datos inventados',()=>{
  assert.match(sql,/official_code TEXT NOT NULL UNIQUE/);
  assert.match(sql,/official_code TEXT UNIQUE/);
  assert.match(sql,/idx_geo_provinces_region/);
  assert.match(sql,/idx_geo_communes_province/);
  assert.match(sql,/idx_geo_localities_commune/);
  assert.doesNotMatch(sql,/INSERT\s+INTO/i);
});
