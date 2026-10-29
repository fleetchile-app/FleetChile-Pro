'use strict';
const crypto=require('node:crypto');
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {createStorage}=require('./storage');
const BASE='/api/operations/trips/:id/pod';
const fail=(status,message)=>Object.assign(Error(message),{status});
function id(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identificador no válido');return n;}
async function verifiedBody(result,file){
 const body=result?.Body,limit=5*1024*1024,size=Number(file.size);
 if(!Number.isSafeInteger(size)||size<1||size>limit||!body)throw fail(503,'Evidencia privada no disponible');
 const chunks=[],hash=crypto.createHash('sha256');let count=0;
 const iterable=Buffer.isBuffer(body)||body instanceof Uint8Array?[body]:body;
 try{
  for await(const chunk of iterable){const bytes=Buffer.from(chunk);count+=bytes.length;if(count>size||count>limit)throw fail(503,'Tamaño de evidencia inconsistente');chunks.push(bytes);hash.update(bytes);}
 }catch(e){body.destroy?.();throw e;}
 if(count!==size||hash.digest('hex')!==file.sha256)throw fail(503,'La evidencia no supera la verificación de integridad');
 return Buffer.concat(chunks);
}
function registerPodEvidenceRoutes(app,pool,{storage}={}){
 const route=(path,work)=>app.get(path,requirePermission('trips.manage'),async(req,res)=>{
  try{
   const actor=resolveActorContext(req),cid=actor?.scope==='company'?actor.company_id:null;
   if(!cid)throw fail(403,'Selecciona una empresa autorizada');
   const tripId=id(req.params.id);
   const driver=req.user?.role_code==='driver';
   if(driver&&!req.user.driver_id)throw fail(403,'Conductor no asociado');
   if(!(await pool.query('select id from trips where id=$1 and company_id=$2'+(driver?' and driver_id=$3':''),driver?[tripId,cid,req.user.driver_id]:[tripId,cid])).rows[0])throw fail(404,'Viaje no encontrado');
   await work(req,res,cid,tripId);
  }catch(e){res.status(e.status||503).json({error:e.status?e.message:'No se pudo consultar la evidencia privada'});}
 });
 route(BASE,async(req,res,cid,tripId)=>{
  const rows=(await pool.query(`select p.id,p.load_id,p.status,p.recipient_name,p.recipient_rut,p.notes,p.delivered_at,
   l.cargo,coalesce((select json_agg(json_build_object('id',f.id,'type',f.type,'mime_type',f.mime_type,'size',f.size) order by f.id)
   from delivery_proof_files f where f.proof_id=p.id),'[]') files
   from trip_delivery_proofs p left join trip_loads l on l.id=p.load_id and l.trip_id=p.trip_id
   join trips t on t.id=p.trip_id where p.trip_id=$1 and t.company_id=$2 order by p.id desc`,[tripId,cid])).rows;
  res.set('Cache-Control','private, no-store').json({trip_id:tripId,proofs:rows});
 });
 route(BASE+'/:proofId/files/:fileId',async(req,res,cid,tripId)=>{
  const file=(await pool.query(`select f.* from delivery_proof_files f join trip_delivery_proofs p on p.id=f.proof_id
   join trips t on t.id=p.trip_id where f.id=$1 and p.id=$2 and t.id=$3 and t.company_id=$4`,
   [id(req.params.fileId),id(req.params.proofId),tripId,cid])).rows[0];
  if(!file)throw fail(404,'Evidencia no encontrada');
  if(!['image/png','image/jpeg'].includes(file.mime_type))throw fail(409,'Formato de evidencia no permitido');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);timer.unref?.();let bytes;
  try{bytes=await verifiedBody(await (storage||createStorage()).get(file.storage_key,{signal:controller.signal}),file);}
  finally{clearTimeout(timer);}
  await writeAudit(pool,req,{companyId:cid,action:'download',entity:'pod_evidence',entityId:file.id,afterData:{trip_id:tripId,proof_id:file.proof_id,type:file.type}});
  const name=`pod-${tripId}-${id(file.id)}.${file.mime_type==='image/png'?'png':'jpg'}`;
  res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff')
   .set('Content-Type',file.mime_type).set('Content-Length',String(bytes.length))
   .set('Content-Disposition',`attachment; filename="${name}"`).send(bytes);
 });
}
module.exports={registerPodEvidenceRoutes,verifiedBody};
