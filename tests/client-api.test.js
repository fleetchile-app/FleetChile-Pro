const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const crypto=require('node:crypto');
const {registerClientRoutes}=require('../client-api');
const BASE='/api/company/clients';
const actor={id:'1',name:'Actor servidor',actor_type:'company',scope:'company',company_id:'10',membership_id:'1',permissions:['clients.manage']};
const pdf=Buffer.from('%PDF-1.4\n%%EOF');
const body={kind:'signed',filename:'respaldo.pdf',content:pdf.toString('base64'),reason:'Recepción',signer_name:'Firmante',signed_on:'2020-01-01',expected_current_id:null};
function harness(resolver=()=>({rows:[]}),{user=actor,storageFailure=false}={}){
 const routes=[],calls=[],stored=[],removed=[];let releases=0;
 const db={async query(sql,values=[]){calls.push({sql,values});const r=await resolver(sql,values);return {rowCount:r.rows?.length||0,...r};},release(){releases++;}};
 const pool={query:db.query,connect:async()=>db},app={};for(const method of ['get','post','patch'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
 registerClientRoutes(app,pool,{storageFactory:()=>({async put(object){if(storageFailure)throw Error('secret AWS endpoint');stored.push(object);},async delete(key){removed.push(key);},async get(){return {Body:Readable.from([pdf])};}})});
 return {calls,stored,removed,get releases(){return releases;},async run(method,path,{params={},body={},query={},actor:userOverride=user}={}){
  const route=routes.find(r=>r.method===method&&r.path===path);assert.ok(route,path);const req={user:userOverride,body,params:{id:'7',documentId:'8',...params},query,ip:'127.0.0.1'};
  const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},set(k,v){this.headers[k]=v;},send(v){this.payload=v;}};
  const next=async index=>{let pending;await route.handlers[index](req,res,()=>{pending=next(index+1);return pending;});if(pending)await pending;};await next(0);return res;
 }};
}
function documentResolver({failAt,previous=null}={}){return async(sql)=>{
 if(sql.startsWith('select c.*'))return {rows:[{id:'7',company_id:'10',profile_version:1}]};
 if(sql.includes('today from'))return {rows:[{today:'2026-10-22'}]};
 if(sql.startsWith('select id from client_consent_documents'))return {rows:previous?[{id:previous}]:[]};
 if(sql.startsWith('insert into client_consent_documents'))return {rows:[{id:'8',kind:'signed',filename:'respaldo.pdf',current:true}]};
 if(failAt&&sql.includes(failAt))throw Error('secret injected failure');return {rows:[]};
};}
test('rutas niegan permiso/contexto antes de consultar datos',async()=>{
 const h=harness(()=>{throw Error('No SQL');});
 for(const user of [{...actor,permissions:[]},{...actor,actor_type:'platform',scope:'platform',company_id:null,membership_id:null,platform_membership_id:1}])assert.equal((await h.run('get',BASE,{actor:user})).statusCode,403);
 assert.equal(h.calls.length,0);
});
test('lista usa SQL paginado/filtrado por sesión, no por query.company_id',async()=>{
 const h=harness(()=>({rows:[{rows:[],total:100}]}));const r=await h.run('get',BASE,{query:{q:"%_O'Neil",company_id:999,page:'2',page_size:'25',sort:'recent',direction:'desc'}});
 assert.equal(r.statusCode,200);assert.equal(r.payload.total,100);assert.equal(h.calls[0].values[0],'10');assert.deepEqual(h.calls[0].values.slice(-2),[25,25]);assert.match(h.calls[0].sql,/where c.company_id=\$1/);assert.doesNotMatch(h.calls[0].sql,/O'Neil|999/);
 for(const query of [{sort:'name;drop'},{sort:'__proto__'},{sort:'constructor'},{direction:'evil'},{page_size:101},{active:'yes'},{privacy_status:'allow'}])assert.equal((await h.run('get',BASE,{query})).statusCode,400);
});
test('edición rechaza ficha ajena y versión desactualizada sin mutar',async()=>{
 for(const row of [null,{id:'7',profile_version:2}]){
  const h=harness(sql=>({rows:sql.startsWith('select id from companies')?[{id:'10'}]:sql.startsWith('select c.*')&&row?[row]:[]}));
  const r=await h.run('patch',BASE+'/:id',{body:{name:'Nuevo',profile_version:1,reason:'Cambio'}});assert.equal(r.statusCode,row?409:404);assert.ok(h.calls.some(c=>c.sql==='ROLLBACK'));assert.equal(h.calls.some(c=>c.sql.startsWith('update clients')),false);
 }
});
test('documento firmado es privado, registra actor y no actualiza clientes ni viajes',async()=>{
 const h=harness(documentResolver());const r=await h.run('post',BASE+'/:id/documents',{body});assert.equal(r.statusCode,201);
 assert.match(h.stored[0].key,/^companies\/10\/clients\/7\/consent\/[0-9a-f-]+$/);assert.deepEqual(h.stored[0].body,pdf);
 const event=h.calls.find(c=>c.sql.startsWith('insert into client_profile_events'));assert.equal(event.values[2],'1');assert.equal(event.values[3],'Actor servidor');assert.equal(JSON.stringify(event.values).includes(pdf.toString('base64')),false);
 assert.equal(h.calls.some(c=>/update clients|update trips|update loads/.test(c.sql)),false);assert.equal(h.calls.at(-1).sql,'COMMIT');assert.equal(h.releases,1);assert.equal(h.removed.length,0);
});
test('fallo de auditoría compensa objeto; COMMIT incierto no destruye el respaldo',async()=>{
 for(const failAt of ['insert into client_profile_events','COMMIT']){
  const h=harness(documentResolver({failAt}));const r=await h.run('post',BASE+'/:id/documents',{body});assert.equal(r.statusCode,500);assert.equal(h.removed.length,failAt==='COMMIT'?0:1);assert.equal(h.releases,1);assert.doesNotMatch(r.payload.error,/secret/);
 }
});
test('reemplazo concurrente no sobrescribe otro documento y compensa su carga',async()=>{
 const h=harness(documentResolver({previous:'99'}));const r=await h.run('post',BASE+'/:id/documents',{body});assert.equal(r.statusCode,409);assert.equal(h.removed.length,1);assert.equal(h.calls.some(c=>c.sql.startsWith('update client_consent_documents')),false);
});
test('subida valida target y metadatos antes de tocar storage; fallo de storage no toca documentos',async()=>{
 const outside=harness(()=>({rows:[]}));assert.equal((await outside.run('post',BASE+'/:id/documents',{body})).statusCode,404);assert.equal(outside.stored.length,0);
 const bad=harness(documentResolver());assert.equal((await bad.run('post',BASE+'/:id/documents',{body:{...body,content:'notpdf'}})).statusCode,400);assert.equal(bad.stored.length,0);
 const h=harness(documentResolver(),{storageFailure:true});const r=await h.run('post',BASE+'/:id/documents',{body});assert.equal(r.statusCode,500);assert.equal(h.calls.some(c=>c.sql==='BEGIN'),false);assert.doesNotMatch(r.payload.error,/AWS|secret/);
});
test('descarga exige scope, evita claves públicas y sirve attachment sin cache',async()=>{
 const h=harness(sql=>({rows:sql.startsWith('select id,storage_key')?[{id:'8',storage_key:'private/key',size:pdf.length,sha256:crypto.createHash('sha256').update(pdf).digest('hex')}]:[]}));
 const r=await h.run('get',BASE+'/:id/documents/:documentId/download');assert.equal(r.statusCode,200);assert.deepEqual(r.payload,pdf);assert.match(r.headers['Content-Disposition'],/^attachment;/);assert.equal(r.headers['Cache-Control'],'no-store');assert.deepEqual(h.calls[0].values,['10','7','8']);
 const outside=harness(()=>({rows:[]}));assert.equal((await outside.run('get',BASE+'/:id/documents/:documentId/download')).statusCode,404);
});
test('descarga rechaza un objeto modificado incluso si conserva el tamaño',async()=>{
 const h=harness(()=>({rows:[{id:'8',storage_key:'private/key',size:pdf.length,sha256:'0'.repeat(64)}]}));
 const r=await h.run('get',BASE+'/:id/documents/:documentId/download');assert.equal(r.statusCode,503);assert.match(r.payload.error,/integridad/);assert.equal(r.headers['Content-Disposition'],undefined);
});
