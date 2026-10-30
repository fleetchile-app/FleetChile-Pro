'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {MIGRATION_FILES}=require('../startup'),{registerPodEvidenceRoutes}=require('../pod-evidence-api');
test('POD PDF: contexto, pertenencia, integridad, historial, auditoría y rollback',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite(),objects=new Map();let reads=0,breakAudit=false;
 const query=async(sql,args=[])=>{if(breakAudit&&sql.startsWith('insert into audit_logs'))throw Error('audit test');const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},pool={query,connect:async()=>({query,release(){}})},one=async(sql,args)=>(await query(sql,args)).rows[0],source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 try{
  await db.exec(source('schema.sql'));await db.exec(source('migrations/002_core_platform.sql'));for(const f of MIGRATION_FILES)await db.exec(source('migrations/'+f));
  const a=await one("insert into companies(legal_name) values('Empresa POD A') returning id"),b=await one("insert into companies(legal_name) values('Empresa POD B') returning id");
  const role=await one("select id from roles where code='company_admin'"),user=await one("insert into users(company_id,role_id,name,email) values($1,$2,'Operador QA','podpdf@example.invalid') returning id",[a.id,role.id]);
  const driver=await one("insert into drivers(company_id,name) values($1,'Conductor actual QA') returning id",[a.id]),truck=await one("insert into trucks(company_id,patente,tipo) values($1,'AA1111','Camión') returning id",[a.id]);
  const trip=await one("insert into trips(company_id,trip_number,origin,destination,driver_id,truck_id) values($1,'V-PDF-QA','Origen','Destino',$2,$3) returning id",[a.id,driver.id,truck.id]);
  const load=await one("insert into trip_loads(trip_id,cargo,weight_kg) values($1,'Madera QA',1000) returning id",[trip.id]);
  const proof=await one("insert into trip_delivery_proofs(trip_id,load_id,status,recipient_name,created_by) values($1,$2,'CLOSED','Receptor QA',$3) returning *",[trip.id,load.id,user.id]);
  const draft=await one("insert into trip_delivery_proofs(trip_id,status) values($1,'DRAFT') returning id",[trip.id]);
  const signature=await require('sharp')({create:{width:120,height:50,channels:4,background:'#ffffff'}}).png().toBuffer(),key='companies/'+a.id+'/private.png';objects.set(key,signature);
  const file=await one("insert into delivery_proof_files(proof_id,type,storage_key,mime_type,size,sha256) values($1,'signature',$2,'image/png',$3,$4) returning id",[proof.id,key,signature.length,crypto.createHash('sha256').update(signature).digest('hex')]);
  const routes=[],app={get:(url,...handlers)=>routes.push({url,handlers})};registerPodEvidenceRoutes(app,pool,{storage:{get:async key=>{reads++;if(!objects.has(key))throw Error('missing private key');return {Body:objects.get(key)};}}});
  const actor={id:user.id,actor_type:'company',scope:'company',membership_id:1,company_id:a.id,role_code:'operations',permissions:['trips.manage']};
  async function run(who=actor,pid=proof.id,tid=trip.id){const req={user:who,params:{id:tid,proofId:pid},query:{company_id:a.id},body:{company_id:a.id},ip:'127.0.0.1'},res={code:200,headers:{},status(n){this.code=n;return this},json(v){this.body=v;return this},set(k,v){this.headers[k]=v;return this},send(v){this.body=v;return this}};const route=routes.find(r=>r.url.endsWith('/:proofId/pdf'));let i=0;const next=()=>route.handlers[i++]?.(req,res,next);await next();return res;}
  await t.test('sin permiso o de otra empresa no consulta storage; tampoco conductor ajeno',async()=>{
   assert.equal((await run({...actor,permissions:[]})).code,403);assert.equal((await run({...actor,company_id:b.id})).code,404);assert.equal((await run({...actor,role_code:'driver',driver_id:999})).code,404);assert.equal(reads,0);
   assert.equal((await run(actor,draft.id)).code,409);assert.equal((await run(actor,999)).code,404);assert.equal(reads,0);
  });
  await t.test('emite PDF privado con logo fallback, datos y rastro auditable, sin claves S3',async()=>{
   const r=await run();assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.headers['Content-Type'],'application/pdf');assert.equal(r.headers['Cache-Control'],'private, no-store');assert.match(r.body.toString('latin1'),/V-PDF-QA|Madera QA/);assert.match(r.body.toString('latin1'),/\/Evidence0/);assert.ok(!r.body.includes(Buffer.from(key)));
   const audit=await one("select * from audit_logs where entity='pod_receipt_pdf' order by id desc limit 1");assert.equal(String(audit.company_id),String(a.id));assert.equal(audit.after_data.sha256,crypto.createHash('sha256').update(r.body).digest('hex'));assert.equal(audit.after_data.document_id,r.headers['X-Document-Id']);assert.deepEqual(audit.after_data.file_ids,[file.id]);
  });
  await t.test('hash o archivo ausente y fallo de auditoría impiden una descarga presentada como válida',async()=>{
   const before=(await one("select count(*)::int n from audit_logs where entity='pod_receipt_pdf'")).n;
   objects.set(key,Buffer.alloc(signature.length));assert.equal((await run()).code,503);objects.delete(key);const missing=await run();assert.equal(missing.code,503);assert.doesNotMatch(JSON.stringify(missing.body),/private.png/);objects.set(key,signature);breakAudit=true;assert.equal((await run()).code,503);breakAudit=false;
   assert.equal((await one("select count(*)::int n from audit_logs where entity='pod_receipt_pdf'")).n,before);
   assert.equal((await one('select status from trip_delivery_proofs where id=$1',[proof.id])).status,'CLOSED');
  });
  await t.test('selecciona el historial anterior a la entrega, no asignaciones ni planes posteriores',async()=>{
   const before=new Date(new Date(proof.delivered_at).getTime()-60000),after=new Date(new Date(proof.delivered_at).getTime()+60000);
   for(const [version,at,name] of [[1,before,'Conductor histórico QA'],[2,after,'Conductor posterior QA']])await query("insert into trip_resource_revisions(company_id,trip_id,version,effective_at,actor_name,reason,snapshot) values($1,$2,$3,$4,'QA','Historial sintético',$5)",[a.id,trip.id,version,at,{driver:{name},truck:{patente:'BB2222'}}]);
   for(const [version,at,meters] of [[1,before,420000],[2,after,999000]])await query("insert into trip_itinerary_revisions(company_id,trip_id,version,resource_version,plan,reason,actor_name,recorded_at) values($1,$2,$3,0,$4,'Historial sintético','QA',$5)",[a.id,trip.id,version,{distance_meters:meters,departure:before,arrival:proof.delivered_at,stops:[]},at]);
   const r=await run();assert.equal(r.code,200,JSON.stringify(r.body));const pdf=r.body.toString('latin1');assert.match(pdf,/Conductor histórico QA/);assert.match(pdf,/420 km/);assert.doesNotMatch(pdf,/Conductor posterior QA|999 km|Conductor actual QA/);
  });
 }finally{await db.close();}
});
