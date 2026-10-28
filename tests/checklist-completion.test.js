'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../public/checklist-shared');
const answers=()=>C.ids.map(id=>({id,result:'ok'}));
test('checklist no cierra vacío, parcial, duplicado, desconocido o con resultado contradictorio',()=>{
 for(const items of [undefined,[],answers().slice(1),[...answers().slice(1),answers()[1]],[...answers().slice(1),{id:'unknown',result:'ok'}],answers().map(i=>({...i,result:'yes'}))])assert.throws(()=>C.validate({status:'Aprobado',items}),e=>e.status===400);
 const failed=answers();failed[0].result='fail';assert.throws(()=>C.validate({status:'Aprobado',items:failed}));assert.throws(()=>C.validate({status:'Rechazado',items:failed}));assert.equal(C.validate({status:'Rechazado',items:failed,observations:'Freno con falla'}).status,'Rechazado');assert.equal(C.validate({status:'Aprobado',items:answers()}).status,'Aprobado');
});
test('pendiente no es aprobación; histórico incompleto no inventa autor/respuestas y escapa texto',()=>{
 assert.equal(C.quality({status:'Pendiente',items:[]}).code,'pending');const old={id:1,status:'Aprobado',items:[],observations:'<img onerror=alert(1)>'};assert.equal(C.canRegularize(old),true);assert.equal(C.canRegularize({...old,status:'Rechazado'}),false);assert.equal(C.canRegularize({...old,items:answers()}),false);const html=C.summary(old);assert.match(html,/histórico incompleto/i);assert.match(html,/No registrado en el histórico/);assert.doesNotMatch(html,/<img/);assert.equal((html.match(/Sin respuesta válida/g)||[]).length,6);
});
test('cierre completo muestra respuestas, autor, fecha y vínculo al histórico',()=>{
 const html=C.summary({status:'Aprobado',items:answers(),created_by_name:'Operador',completed_by_name:'Conductor',completed_at:'2026-10-27T12:00:00Z',supersedes_id:1});assert.match(html,/Conductor/);assert.match(html,/Operador/);assert.equal((html.match(/Conforme/g)||[]).length,6);assert.match(html,/registro anterior #1/);
});
test('diagnóstico del viaje es de solo lectura, parametrizado y no inventa autor histórico',async()=>{
 const {inspect}=require('../scripts/inspect-trip-checklists'),queries=[];const db={async query(sql,args){queries.push({sql,args});if(sql.includes('from trips where'))return {rows:[{id:1,company_id:2,trip_number:'V-2026-4B4724'}]};if(sql.includes('select vc.*'))return {rows:[{id:1,status:'Aprobado',items:[]}]};return {rows:[]};},release(){}};
 const result=await inspect({connect:async()=>db},'V-2026-4B4724');assert.equal(queries[0].sql,'BEGIN READ ONLY');assert.equal(queries.at(-1).sql,'COMMIT');assert.ok(queries.some(q=>q.args?.[0]==='V-2026-4B4724'));assert.equal(queries.some(q=>/^(insert|update|delete|alter|create|drop)\b/i.test(q.sql)),false);assert.equal(result.checklists[0].completed_by_name,null);assert.equal(result.checklists[0].quality.complete,false);await assert.rejects(()=>inspect({connect(){throw Error('No debe conectar')}},'bad;delete'));
});
