'use strict';
const crypto=require('node:crypto'),sharp=require('sharp');
const {requirePermission,resolveActorContext}=require('./auth'),{writeAudit}=require('./audit'),{createStorage}=require('./storage'),{verifiedBody}=require('./pod-evidence-api');
const fail=(status,message)=>Object.assign(Error(message),{status});
const id=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Identificador no válido');return n;};
const text=(v,max)=>{if(v==null)return null;if(typeof v!=='string'||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw fail(400,'Referencia o nota no válida');return v.trim()||null;};
const BASE='/api/financial-support/:kind/:id';
const targets={fuel:'fuel_id',cost:'cost_version_id',source:'source_id'};
async function attachment(data){
 if(data==null)return null;
 if(typeof data!=='string'||data.length>7000000)throw fail(400,'Archivo de máximo 5 MiB');
 const m=/^data:(application\/pdf|image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);if(!m)throw fail(400,'Selecciona PDF, PNG o JPEG');
 const bytes=Buffer.from(m[2],'base64');if(!bytes.length||bytes.length>5242880||bytes.toString('base64')!==m[2])throw fail(400,'Archivo o codificación no válidos');
 if(m[1]==='application/pdf'){
  const s=bytes.toString('latin1');if(!s.startsWith('%PDF-')||!s.slice(-2048).includes('%%EOF')||/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia)\b/i.test(s))throw fail(400,'El PDF debe ser estático y sin acciones ni archivos incrustados');
 }else{
  try{const meta=await sharp(bytes,{limitInputPixels:16000000,failOn:'warning'}).metadata();if((meta.pages||1)!==1||m[1]!=='image/'+(meta.format==='jpeg'?'jpeg':meta.format))throw Error();await sharp(bytes,{limitInputPixels:16000000,failOn:'warning'}).stats();}catch{throw fail(400,'Imagen no válida o demasiado grande');}
 }
 return {bytes,mime:m[1],sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function registerFinancialSupportRoutes(app,pool,{storage}={}){
 function route(method,path,mutate,work){app[method](path,(req,res,next)=>requirePermission(req.params.kind==='fuel'?'fuel.manage':mutate?'economics.manage':'economics.read')(req,res,next),async(req,res)=>{
  try{const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id)throw fail(403,'Selecciona una empresa autorizada');if(!Object.hasOwn(targets,req.params.kind))throw fail(400,'Tipo de respaldo no válido');await work(req,res,a.company_id,id(req.params.id));}
  catch(e){res.status(e.status||503).json({error:e.status?e.message:'No se pudo procesar el respaldo privado'});}
 });}
 async function target(db,kind,entity,cid,write=false){
  let row;
  if(kind==='cost')row=(await db.query(`select v.*,i.current_version_id,f.state finance_state from trip_cost_versions v join trip_cost_items i on i.id=v.trip_cost_item_id and i.company_id=v.company_id join trip_finance_control f on f.trip_id=i.trip_id and f.company_id=i.company_id where v.id=$1 and v.company_id=$2${write?' for update of i,f':''}`,[entity,cid])).rows[0];
  else row=(await db.query(`select * from ${kind==='fuel'?'fuel':'economic_sources'} where id=$1 and company_id=$2${write?' for update':''}`,[entity,cid])).rows[0];
  if(!row)throw fail(404,'Registro no encontrado');
  if(write&&kind==='cost'&&(row.finance_state==='closed'||String(row.current_version_id)!==String(entity)))throw fail(409,'El costo cambió o su control está cerrado. Revisa la versión vigente');
  return row;
 }
 route('get',BASE,false,async(req,res,cid,entity)=>{
  const row=await target(pool,req.params.kind,entity,cid);
  const inherited=req.params.kind==='source'?row.fuel_id:null;
  const rows=(await pool.query(`select id,reference,notes,mime_type,size,created_at,created_by,fuel_id,cost_version_id,source_id,storage_key is not null has_file from financial_support_entries where company_id=$1 and id in (select entry_id from financial_support_links where company_id=$1 and kind=$3 and target_id=$2) order by id desc limit 100`,[cid,entity,req.params.kind])).rows;
  let reference=req.params.kind==='fuel'?row.receipt_reference:req.params.kind==='source'&&row.kind==='toll'?row.reference:null;
  if(inherited)reference=(await pool.query('select receipt_reference from fuel where id=$1 and company_id=$2',[inherited,cid])).rows[0]?.receipt_reference||null;
  res.set('Cache-Control','private, no-store').json({rows,reference,can_add:req.params.kind!=='cost'||row.finance_state!=='closed'&&String(row.current_version_id)===String(entity),legacy_declaration:req.params.kind==='cost'?row.support_status:null});
 });
 route('post',BASE,true,async(req,res,cid,entity)=>{
  const b=req.body||{},reference=text(b.reference,160),notes=text(b.notes,2000),file=await attachment(b.file);
  if(!reference&&!file)throw fail(400,'Indica una referencia o adjunta un archivo');
  const db=await pool.connect();let uploaded=false,store=null,key=null;
  try{
   await db.query('BEGIN');await target(db,req.params.kind,entity,cid,true);
   if(file){store=storage||createStorage();key=`companies/${cid}/financial-support/${crypto.randomUUID()}`;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);timer.unref?.();uploaded=true;try{await store.put({key,body:file.bytes,mimeType:file.mime,size:file.bytes.length,signal:controller.signal});}finally{clearTimeout(timer);}}
   const row=(await db.query(`insert into financial_support_entries(company_id,${targets[req.params.kind]},reference,notes,storage_key,mime_type,size,sha256,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,reference,notes,mime_type,size,created_at`,[cid,entity,reference,notes,key,file?.mime||null,file?.bytes.length||null,file?.sha256||null,req.user.id])).rows[0];
   await writeAudit(db,req,{companyId:cid,action:'create',entity:'financial_support',entityId:row.id,afterData:{kind:req.params.kind,target_id:entity,...row}});await db.query('COMMIT');res.status(201).json(row);
  }catch(e){try{await db.query('ROLLBACK')}catch{}if(uploaded)try{await store.delete(key)}catch{console.error('FINANCIAL_SUPPORT_COMPENSATION_FAILED')}throw e;}finally{db.release();}
 });
 route('get',BASE+'/:fileId',false,async(req,res,cid,entity)=>{
  await target(pool,req.params.kind,entity,cid);
  const file=(await pool.query(`select * from financial_support_entries where id=$1 and company_id=$2 and id in (select entry_id from financial_support_links where company_id=$2 and kind=$4 and target_id=$3)`,[id(req.params.fileId),cid,entity,req.params.kind])).rows[0];
  if(!file?.storage_key)throw fail(404,'Adjunto no encontrado');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);timer.unref?.();let bytes;try{bytes=await verifiedBody(await (storage||createStorage()).get(file.storage_key,{signal:controller.signal}),file);}finally{clearTimeout(timer);}
  await writeAudit(pool,req,{companyId:cid,action:'download',entity:'financial_support',entityId:file.id,afterData:{kind:req.params.kind,target_id:entity}});
  res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff').set('Content-Type',file.mime_type).set('Content-Disposition',`attachment; filename="respaldo-${file.id}.${file.mime_type==='application/pdf'?'pdf':file.mime_type==='image/png'?'png':'jpg'}"`).send(bytes);
 });
 app.patch('/api/fleet/fuel/:id/valuation',requirePermission('fuel.manage'),async(req,res)=>{
  let db;try{
   const a=resolveActorContext(req),cid=a?.scope==='company'?a.company_id:null;if(!cid)throw fail(403,'Selecciona una empresa');
   const price=req.body?.price_clp,version=req.body?.version,reason=text(req.body?.reason,1000);
   if(!['number','string'].includes(typeof price)||!Number.isFinite(Number(price))||Number(price)<=0||!Number.isSafeInteger(version)||version<0||!reason)throw fail(400,'Indica precio positivo, versión y motivo');
   db=await pool.connect();await db.query('BEGIN');const old=await target(db,'fuel',id(req.params.id),cid,true);
   if(Number(old.valuation_version)!==version)throw fail(409,'La valoración cambió. Recarga antes de guardar');
   if((await db.query('select id from economic_sources where fuel_id=$1',[old.id])).rows.length)throw fail(409,'El combustible ya tiene origen económico; no se modifica su importe');
   const row=(await db.query('update fuel set price_clp=$1,total_clp=round(liters*$1::numeric),valuation_version=valuation_version+1 where id=$2 and company_id=$3 returning *',[Number(price),old.id,cid])).rows[0];
   await writeAudit(db,req,{companyId:cid,action:'value',entity:'fuel',entityId:old.id,beforeData:old,afterData:{...row,reason}});await db.query('COMMIT');res.json(row);
  }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}res.status(e.status||503).json({error:e.status?e.message:'No se pudo valorar el combustible'});}finally{db?.release();}
 });
}
module.exports={registerFinancialSupportRoutes,attachment};
