'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{types}=require('pg'),{catalog}=require('../company-purge-engine');
test('node-postgres entrega name[] como texto, pero decodifica text[]',()=>{
 assert.equal(typeof types.getTypeParser(1003)('{id,company_id}'),'string');
 assert.deepEqual(types.getTypeParser(1009)('{id,company_id}'),['id','company_id']);
});
test('catálogo mal interpretado se rechaza sin iniciar escrituras ni vaciar datos',async()=>{
 const calls=[],db={query:async sql=>{calls.push(sql);return {rows:calls.length===1?[{oid:1,name:'companies',cols:'{id}',pk:'{id}'}]:[]};}};
 await assert.rejects(catalog(db),e=>e.status===409&&/interpretar el catálogo/.test(e.message));
 assert.equal(calls.length,2);assert.ok(calls.every(q=>q.startsWith('select ')));
});
