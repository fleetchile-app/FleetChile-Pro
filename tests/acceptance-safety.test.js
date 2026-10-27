'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {configuration}=require('./helpers/native-postgres');
test('aceptación nativa rechaza producción, hosts remotos y ausencia de confirmación',()=>{
 const base={FLEETCHILE_TEST_PG_CREATE:'disposable-local-database',FLEETCHILE_TEST_PG_URL:'postgresql://test:fixture@127.0.0.1:5433/postgres'};
 assert.throws(()=>configuration({}));assert.throws(()=>configuration({...base,FLEETCHILE_TEST_PG_CREATE:''}));assert.throws(()=>configuration({...base,FLEETCHILE_TEST_PG_URL:'postgresql://user:secret@production.example/postgres'}));assert.throws(()=>configuration({...base,FLEETCHILE_TEST_PG_URL:'postgresql://user:secret@localhost/fleetchile'}));assert.throws(()=>configuration({...base,DATABASE_URL:'postgresql://real:secret@127.0.0.1:5433/production'}));assert.match(configuration(base).name,/^fleetchile_accept_[a-f0-9]{24}$/);
 assert.throws(()=>configuration({...base,FLEETCHILE_TEST_PG_URL:base.FLEETCHILE_TEST_PG_URL+'?host=production.example'}));assert.throws(()=>configuration({...base,FLEETCHILE_TEST_PG_URL:base.FLEETCHILE_TEST_PG_URL+'?database=production'}));assert.throws(()=>configuration({...base,DATABASE_URL:'postgresql://real:secret@localhost:5433/production'}));
});
test('comandos de aceptación fallan ante prerrequisitos ausentes en lugar de omitir pruebas',()=>{
 const {prepare}=require('../scripts/run-acceptance');assert.throws(()=>prepare({}));assert.throws(()=>prepare({FLEETCHILE_TEST_PGLITE:'nonexistent-acceptance-runtime'}));assert.throws(()=>prepare({},{native:true}));
});
