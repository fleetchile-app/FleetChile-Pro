'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {catalog,scrub,csvCell}=require('../portability-catalog'),{MIGRATION_FILES}=require('../startup');
test('exportación filtra credenciales y referencias ajenas; CSV neutraliza fórmulas',()=>{
 const out=scrub({company_id:1,password_hash:'secret',storage_key:'private',nested:{company_id:2,name:'Otra empresa'},rows:[{token:'s',name:'Ana'}]},1);
 assert.equal(out.password_hash,undefined);assert.equal(out.storage_key,undefined);assert.deepEqual(out.nested,{excluded_reference:'foreign_company'});assert.deepEqual(out.rows,[{name:'Ana'}]);
 assert.equal(csvCell('=1+1'),'"\'=1+1"');assert.equal(csvCell('a"b'),'"a""b"');assert.equal(csvCell(-2),'"-2"');assert.equal(csvCell('  =1+1'),'"\'  =1+1"');assert.equal(csvCell('\n=1+1'),'"\'\n=1+1"');
});
test('catálogo de portabilidad se ejecuta en esquema real y no incluye autenticación global',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async()=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite(),source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 try{await db.exec(source('schema.sql'));await db.exec(source('migrations/002_core_platform.sql'));for(const f of MIGRATION_FILES)await db.exec(source('migrations/'+f));
  const entries=await catalog(db);for(const e of entries){try{await db.query(e.sql,[1])}catch(err){throw Error(e.name+': '+err.message)}}
  assert.equal(entries.some(e=>/sessions|platform_memberships|platform_owners/.test(e.name)),false);
 }finally{await db.close()}
});
