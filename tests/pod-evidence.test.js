'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifiedBody,registerPodEvidenceRoutes}=require('../pod-evidence-api');
const bytes=Buffer.from('synthetic image bytes'),file={size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
test('evidencia privada verifica Buffer y stream, tamaño y hash antes de responder',async()=>{
 assert.deepEqual(await verifiedBody({Body:bytes},file),bytes);
 assert.deepEqual(await verifiedBody({Body:(async function*(){yield bytes.subarray(0,4);yield bytes.subarray(4);})()},file),bytes);
 for(const [body,meta] of [[Buffer.alloc(bytes.length),file],[bytes,{...file,size:bytes.length+1}],[bytes,{...file,size:bytes.length-1}],[bytes,{...file,size:6*1024*1024}],[null,file]])await assert.rejects(verifiedBody({Body:body},meta),e=>e.status===503);
});
test('no consulta almacenamiento sin permiso, contexto propio y pertenencia al viaje',async()=>{
 const routes=[],app={get:(url,...handlers)=>routes.push({url,handlers})};let reads=0,queries=[];
 registerPodEvidenceRoutes(app,{query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}},{storage:{get:async()=>{reads++;}}});
 const route=routes.find(r=>r.url.endsWith('/:fileId'));
 async function run(user){const req={user,params:{id:1,proofId:2,fileId:3}},res={code:200,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};let i=0;const next=()=>route.handlers[i++]?.(req,res,next);await next();return res;}
 const user={id:5,actor_type:'company',scope:'company',membership_id:1,company_id:8,role_code:'operations',permissions:['trips.manage']};
 assert.equal((await run({...user,permissions:[]})).code,403);assert.equal(queries.length,0);
 assert.equal((await run({...user,actor_type:'platform',scope:'platform',platform_membership_id:1,company_id:null})).code,403);
 assert.equal((await run(user)).code,404);assert.equal(reads,0);
 queries=[];assert.equal((await run({...user,role_code:'driver',driver_id:7})).code,404);assert.match(queries[0].sql,/driver_id=\$3/);assert.deepEqual(queries[0].args,[1,8,7]);assert.equal(reads,0);
});
