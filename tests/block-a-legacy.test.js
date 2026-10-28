'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {registerOperationsRoutes}=require('../operations-api');
const {requirePermission}=require('../auth');
const source=fs.readFileSync(require.resolve('../server'),'utf8');
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},sendStatus(n){this.statusCode=n;return this;}});

for(const [path,permission] of [['fuel','fuel.manage'],['maintenance','maintenance.manage']])test(`legacy ${path} no permite eludir validación ni auditoría`,async()=>{
 const line=source.split(/\r?\n/).find(l=>l.startsWith(`app.post("/api/${path}",`));let handlers;
 Function('app','requirePermission','requireCreationCompany',line)({post(p,...h){handlers=h;}},requirePermission,(req,res,next)=>next());
 for(const allowed of [false,true]){
  const req={body:{truck:'Libre',liters:-1,status:'En proceso'},user:{id:3,role_code:'operations',company_id:10,permissions:allowed?[permission]:[]}},res=response();
  const next=async i=>{let pending;await handlers[i](req,res,()=>{pending=next(i+1);return pending;});if(pending)await pending;};await next(0);
  assert.equal(res.statusCode,allowed?410:403);
  if(allowed){assert.equal(res.payload.code,'LEGACY_ENDPOINT_RETIRED');assert.match(res.payload.error,new RegExp('/api/fleet/'+path));}
 }
});

for(const failure of [null,'insert into alerts','insert into audit_logs'])test(`checklist rechazado administrativo genera el mismo bloqueo y rollback: ${failure}`,async()=>{
 const calls=[],db={async query(sql,v){calls.push(sql);if(failure&&sql.startsWith(failure))throw Error('Forced');
  if(sql.includes('from trips t'))return {rows:[{id:7,company_id:10}],rowCount:1};
  if(sql.startsWith('select id from trucks'))return {rows:[{id:3}],rowCount:1};
  if(sql.startsWith('insert into vehicle_checklists'))return {rows:[{id:22,truck_id:3,trip_id:7}],rowCount:1};
  if(sql.startsWith('insert into alerts')){assert.deepEqual(v,[10,'Checklist rechazado para el viaje 7',22]);assert.match(sql,/checklist_rejected/);return {rows:[]};}
  return {rows:[],rowCount:0};
 },release(){}};
 const routes=[],app={};for(const m of ['get','post','patch'])app[m]=(p,...h)=>routes.push({m,p,h});
 registerOperationsRoutes(app,{connect:async()=>db});
 const req={user:{id:1,role_code:'operations',company_id:10,permissions:['trips.manage']},params:{id:'7'},body:{truck_id:3,status:'Rechazado',items:require('../public/checklist-shared').ids.map((id,i)=>({id,result:i?'ok':'fail'})),observations:'Freno con falla'}},res=response();
 await routes.find(r=>r.p==='/api/operations/trips/:id/checklist'&&r.m==='post').h.at(-1)(req,res);
 assert.equal(res.statusCode,failure?400:201);assert.equal(calls.at(-1),failure?'ROLLBACK':'COMMIT');
 if(failure)assert.equal(calls.includes('COMMIT'),false);
});
