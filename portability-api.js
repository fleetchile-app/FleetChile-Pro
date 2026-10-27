'use strict';
const crypto=require('node:crypto'),{Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
const {resolveActorContext,reauthenticateUser}=require('./auth'),{platformManager}=require('./enterprise-api'),E=require('./enterprise-common');
const {createStorage,storageConfig}=require('./storage'),{exportKey}=require('./portability-worker'),{stream,limits}=require('./portability-package');
const {retention}=require('./service-operations');
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v||'');
function exportGate(req,res,next){const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id)return res.status(403).json({error:'Selecciona una empresa autorizada'});const companyAdmin=a.actor_type==='company'&&a.role==='company_admin'&&['company.users.manage','company.people.read','economics.export'].every(p=>a.permissions.includes(p));const legacy=a.actor_type==='legacy'&&a.role==='admin';if(!companyAdmin&&!legacy&&!platformManager(req))return res.status(403).json({error:'La exportación integral requiere administración empresarial completa'});req.exportCompany=a.company_id;next();}
function registerPortabilityRoutes(app,pool,{storageFactory=createStorage,env=process.env,operations,reauthenticate=reauthenticateUser}={}){
 const summary=`id,status,requested_by,reason,created_at,started_at,finished_at,expires_at,snapshot_at,error_code,size,sha256,
  coalesce(jsonb_array_length(manifest->'datasets'),0) dataset_count,coalesce(jsonb_array_length(manifest->'attachments'),0) attachment_count`;
 app.get('/api/company/exports',exportGate,E.wrap(async(req,res)=>{let configured=true;try{storageConfig(env)}catch{configured=false;}res.json({jobs:(await pool.query('select '+summary+' from company_export_jobs where company_id=$1 order by created_at desc limit 50',[req.exportCompany])).rows,storage_configured:configured,limits:limits(env),retention,notice:'Exportación de datos y adjuntos propios; no es un respaldo restaurable.'})}));
 app.post('/api/company/exports',exportGate,E.wrap(async(req,res)=>{
  const b=req.body||{},why=E.reason(b.reason);if(Object.keys(b).some(k=>!['request_key','reason','password','confirmed'].includes(k))||!uuid(b.request_key)||b.confirmed!==true)E.fail(400,'Confirma la exportación con un identificador de solicitud válido');
  if(!await reauthenticate(pool,req.user.id,b.password))E.fail(403,'Contraseña actual incorrecta');try{storageConfig(env)}catch{E.fail(409,'Configura el almacenamiento privado antes de solicitar una exportación')}
  const result=await E.transaction(pool,req.exportCompany,async db=>{
   const previous=(await db.query('select id,status,reason from company_export_jobs where company_id=$1 and requested_by=$2 and request_key=$3',[req.exportCompany,req.user.id,b.request_key])).rows[0];if(previous){if(previous.reason!==why)E.fail(409,'La solicitud ya existe con otro motivo');return previous;}
   if((await db.query("select id from company_export_jobs where company_id=$1 and status in ('queued','running')",[req.exportCompany])).rows.length)E.fail(409,'La empresa ya tiene una exportación pendiente');
   const job=(await db.query('insert into company_export_jobs(id,company_id,requested_by,reason,request_key) values($1,$2,$3,$4,$5) returning id,status,created_at',[crypto.randomUUID(),req.exportCompany,req.user.id,why,b.request_key])).rows[0];
   await require('./audit').writeAudit(db,req,{companyId:req.exportCompany,action:'export_request',entity:'company_export',entityId:job.id,afterData:{reason:why}});return job;
  });res.status(202).json(result);
 }));
 app.post('/api/company/exports/:id/download',exportGate,E.wrap(async(req,res)=>{
  if(!uuid(req.params.id))E.fail(400,'Exportación no válida');if(!await reauthenticate(pool,req.user.id,req.body?.password))E.fail(403,'Contraseña actual incorrecta');
  const job=(await pool.query('select *,expires_at>now() unexpired from company_export_jobs where id=$1 and company_id=$2',[req.params.id,req.exportCompany])).rows[0];
  if(!job)E.fail(404,'Exportación no encontrada');if(job.status!=='ready'||!job.unexpired)E.fail(409,'El paquete no está disponible o ya venció');if(job.storage_key!==exportKey(job))E.fail(409,'La copia privada no tiene un ámbito válido');
  let object;try{object=await storageFactory().get(job.storage_key)}catch{await operations?.record('exports','EXPORT_DOWNLOAD_UNAVAILABLE');E.fail(503,'No se pudo obtener la copia privada')}
  try{await require('./audit').writeAudit(pool,req,{companyId:req.exportCompany,action:'export_download',entity:'company_export',entityId:job.id,afterData:{sha256:job.sha256,size:job.size}})}catch(e){object.Body?.destroy?.();throw e;}
  res.set('Cache-Control','private, no-store').set('Content-Type','application/gzip').set('Content-Disposition',`attachment; filename="fleetchile-company-${req.exportCompany}-${job.id}.tar.gz"`).set('Content-Length',String(job.size));
  // Withhold the final chunk so a corrupt object cannot complete Content-Length.
  let size=0,last=null;const hash=crypto.createHash('sha256'),check=new Transform({transform(chunk,encoding,cb){size+=chunk.length;if(size>Number(job.size))return cb(Error('EXPORT_DOWNLOAD_INTEGRITY'));hash.update(chunk);if(last)this.push(last);last=chunk;cb()},flush(cb){if(size!==Number(job.size)||hash.digest('hex')!==job.sha256)return cb(Error('EXPORT_DOWNLOAD_INTEGRITY'));if(last)this.push(last);cb()}});
  try{await pipeline(stream(object.Body),check,res)}catch{await operations?.record('exports','EXPORT_DOWNLOAD_FAILED');res.destroy();}
 }));
}
module.exports={registerPortabilityRoutes,exportGate};
