'use strict';
const crypto=require('node:crypto');
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {createStorage,StorageConfigError}=require('./storage');
const {companyDate}=require('./personnel-domain');
const {fail,identifier,reason,validateClient,validateDocument}=require('./client-domain');
const BASE='/api/company/clients';
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const documentColumns='id,kind,current,filename,size,sha256,signer_name,signer_capacity,signed_on::text signed_on,uploaded_by,uploaded_by_name,reason,created_at';
const projection=`c.*,p.name assigned_person_name,coalesce(ps.status,'pending') privacy_status`;
const joins=`left join company_people p on p.id=c.assigned_person_id and p.company_id=c.company_id left join client_privacy_status ps on ps.client_id=c.id and ps.company_id=c.company_id`;
async function client(db,cid,id,{lock=false}={}){
 const row=(await db.query(`select c.* from clients c where c.company_id=$1 and c.id=$2${lock?' for update of c':''}`,[cid,id])).rows[0];
 if(!row)throw fail(404,'Cliente no encontrado en tu empresa');return row;
}
async function transaction(pool,cid,fn){
 const db=await pool.connect();try{await db.query('BEGIN');
  // Serialize client allocation without blocking FK KEY SHARE locks during a
  // concurrent document audit (which locks the client before inserting audit).
  const company=(await db.query('select id from companies where id=$1 and active=true for no key update',[cid])).rows[0];
  if(!company)throw fail(403,'Empresa activa no disponible');
  const result=await fn(db);await db.query('COMMIT');return result;
 }catch(e){try{await db.query('ROLLBACK');}catch{}throw e;}finally{db.release();}
}
async function event(db,req,cid,id,action,before,after,why){
 await db.query(`insert into client_profile_events(company_id,client_id,actor_user_id,actor_name,action,before_data,after_data,reason)
 values($1,$2,$3,$4,$5,$6,$7,$8)`,[cid,id,req.user.id,req.user.name||'',action,before,after,why||null]);
 await writeAudit(db,req,{companyId:cid,action,entity:'client_profile',entityId:id,beforeData:before?{client_id:id}:null,afterData:{client_id:id,action}});
}
async function validateRelations(db,cid,data,current){
 if(data.commune_id){
  const geo=(await db.query(`select c.name commune,r.name region from geo_communes c join geo_provinces p on p.id=c.province_id
   join geo_regions r on r.id=p.region_id where c.id=$1`,[data.commune_id])).rows[0];
  if(!geo)throw fail(400,'Selecciona una comuna del catálogo');Object.assign(data,geo);
 }
 if(data.commune_id===null&&current?.commune_id){data.commune=null;data.region=null;}
 if(data.assigned_person_id&&(!current||!same(current.assigned_person_id,data.assigned_person_id))){
  const person=(await db.query(`select p.id from company_people p left join user_memberships m on m.id=p.membership_id and m.company_id=p.company_id
   left join roles r on r.id=m.role_id where p.company_id=$1 and p.id=$2 and p.driver_id is null and coalesce(r.code,'')<>'driver'
   and (m.id is null or m.active=true) for share of p`,[cid,data.assigned_person_id])).rows[0];
  if(!person)throw fail(400,'Selecciona un trabajador no conductor de tu empresa');
 }
 if(data.normalized_rut){
  const duplicate=(await db.query(`select id from clients where company_id=$1 and ($3::bigint is null or id<>$3)
   and ltrim(upper(regexp_replace(coalesce(rut,''),'[.[:space:]-]','','g')),'0')=replace($2,'-','') limit 1`,[cid,data.normalized_rut,current?.id||null])).rows[0];
  if(duplicate)throw fail(409,'Este RUT ya está registrado como cliente de tu empresa');
 }
 if(Object.hasOwn(data,'street')||Object.hasOwn(data,'street_number'))data.address=[Object.hasOwn(data,'street')?data.street:current?.street,Object.hasOwn(data,'street_number')?data.street_number:current?.street_number].filter(Boolean).join(' ')||null;
}
function safeDocument(row){return Object.fromEntries(Object.entries(row).filter(([k])=>k!=='storage_key'));}
function registerClientRoutes(app,pool,{storageFactory=createStorage}={}){
 const gate=[requirePermission('clients.manage'),(req,res,next)=>{
  const actor=resolveActorContext(req);if(actor?.scope!=='company'||!actor.company_id||!req.user?.id)return res.status(403).json({error:'Selecciona una empresa autorizada para gestionar sus clientes'});
  req.clientCompany=actor.company_id;next();
 }];
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||(e instanceof StorageConfigError?503:e.code==='23505'?409:500)).json({error:e.status?e.message:e instanceof StorageConfigError?'El almacenamiento privado de documentos no está configurado':e.code==='23505'?'El código o RUT del cliente ya existe en esta empresa':'No se pudo completar la operación de clientes'});}};
 const cid=req=>req.clientCompany;
 const id=req=>identifier(req.params.id);
 const storage=()=>storageFactory();
 app.get(BASE+'/options',...gate,wrap(async(req,res)=>{
  const workers=(await pool.query(`select p.id,p.name,p.job_title from company_people p
   left join user_memberships m on m.id=p.membership_id and m.company_id=p.company_id left join roles r on r.id=m.role_id
   where p.company_id=$1 and p.driver_id is null and coalesce(r.code,'')<>'driver' and (m.id is null or m.active=true) order by p.name,p.id`,[cid(req)])).rows;
  const communes=(await pool.query(`select c.id,c.name,p.region_id,r.name region_name from geo_communes c
   join geo_provinces p on p.id=c.province_id join geo_regions r on r.id=p.region_id order by r.name,c.name,c.id`)).rows;
  res.json({workers,communes,document_max_bytes:1048576,consent_is_blocking:false});
 }));
 app.get(BASE,...gate,wrap(async(req,res)=>{
  const q=req.query||{},page=Number(q.page||1),size=Number(q.page_size||25);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<1||size>100||page>1000000)throw fail(400,'Paginación inválida');
  const values=[cid(req)],where=['c.company_id=$1'];
  if(q.q){if(typeof q.q!=='string'||q.q.length>160)throw fail(400,'Búsqueda inválida');values.push('%'+q.q.replace(/[\\%_]/g,'\\$&')+'%');where.push(`(c.name ilike $${values.length} escape '\\' or c.client_code ilike $${values.length} escape '\\' or c.rut ilike $${values.length} escape '\\' or c.email ilike $${values.length} escape '\\')`);}
  for(const [field,allowed] of Object.entries({active:['true','false'],segment:['retail','wholesale'],relationship:['prospect','customer','recurring']}))if(q[field]){if(!allowed.includes(q[field]))throw fail(400,'Filtro no válido');values.push(field==='active'?q[field]==='true':q[field]);where.push(`c.${field}=$${values.length}`);}
  if(q.assigned_person_id){values.push(identifier(q.assigned_person_id));where.push(`c.assigned_person_id=$${values.length}`);}
  if(q.privacy_status){if(!['pending','recorded','revoked'].includes(q.privacy_status))throw fail(400,'Filtro de privacidad inválido');values.push(q.privacy_status);where.push(`coalesce(ps.status,'pending')=$${values.length}`);}
  const sorts={name:'lower(c.name)',code:'lower(c.client_code)',recent:'c.updated_at'},sortKey=q.sort||'name';if(!Object.hasOwn(sorts,sortKey))throw fail(400,'Orden inválido');const sort=sorts[sortKey];
  const direction=q.direction||'asc';if(!['asc','desc'].includes(direction))throw fail(400,'Dirección de orden inválida');
  // A single snapshot provides consistent total + page, including an empty page.
  const result=(await pool.query(`with matching as (select ${projection} from clients c ${joins} where ${where.join(' and ')}),
   paged as (select * from matching c order by ${sort} ${direction},c.id ${direction} limit $${values.length+1} offset $${values.length+2})
   select (select count(*)::int from matching) total,coalesce((select json_agg(paged) from paged),'[]'::json) rows`,[...values,size,(page-1)*size])).rows[0];
  res.json({rows:result?.rows||[],total:result?.total||0,page,page_size:size});
 }));
 app.get(BASE+'/:id',...gate,wrap(async(req,res)=>{
  const row=(await pool.query(`select ${projection} from clients c ${joins} where c.company_id=$1 and c.id=$2`,[cid(req),id(req)])).rows[0];if(!row)throw fail(404,'Cliente no encontrado');
  const documents=(await pool.query(`select ${documentColumns} from client_consent_documents where company_id=$1 and client_id=$2 order by id desc limit 100`,[cid(req),row.id])).rows;
  const events=(await pool.query('select id,actor_user_id,actor_name,action,before_data,after_data,reason,created_at from client_profile_events where company_id=$1 and client_id=$2 order by id desc limit 100',[cid(req),row.id])).rows;
  res.json({client:row,documents,events,consent_is_blocking:false});
 }));
 app.get(BASE+'/:id/services',...gate,wrap(async(req,res)=>{
  const row=await client(pool,cid(req),id(req));const page=Number(req.query?.page||1);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw fail(400,'Página inválida');
  const r=(await pool.query(`with services as (select t.id,t.trip_number,t.status,t.origin,t.destination,t.planned_departure,t.actual_departure,t.actual_arrival
   from trips t where t.company_id=$1 and (t.client_id=$2 or exists(select 1 from trip_loads l where l.trip_id=t.id and l.client_id=$2))),
   paged as(select * from services order by coalesce(actual_arrival,actual_departure,planned_departure) desc nulls last,id desc limit 25 offset $3)
   select (select count(*)::int from services) total,(select max(actual_arrival) from services where status='Completado') last_completed_service,
   coalesce((select json_agg(paged) from paged),'[]'::json) rows`,[cid(req),row.id,(page-1)*25])).rows[0];res.json({...r,page,page_size:25});
 }));
 const create=wrap(async(req,res)=>{
  const data=validateClient(req.body);const row=await transaction(pool,cid(req),async db=>{
   await validateRelations(db,cid(req),data,null);if(!data.client_code)delete data.client_code;
   const keys=Object.keys(data),values=keys.map(k=>data[k]),automatic=!data.client_code;let result;
   // A manually entered code may coincide with the sequence's next value.
   // Retry only that conflict, never hide a duplicate RUT or another SQL error.
   for(let attempt=0;attempt<(automatic?10:1)&&!result;attempt++)result=(await db.query(`insert into clients(company_id,${keys.join(',')}) values($1,${values.map((_,i)=>'$'+(i+2)).join(',')})${automatic?' on conflict (company_id,(lower(client_code))) do nothing':''} returning *`,[cid(req),...values])).rows[0];
   if(!result)throw fail(409,'No se pudo asignar un código automático; indica un código manual único');
   await event(db,req,cid(req),result.id,'create',null,result,'Alta de cliente');return result;
  });res.status(201).json(row);
 });
 app.post(BASE,...gate,create);
 // Old create URL remains compatible, but may not bypass the new validation.
 app.post('/api/clients',...gate,create);
 app.patch(BASE+'/:id',...gate,wrap(async(req,res)=>{
  const why=reason(req.body?.reason),data=validateClient(req.body,{partial:true});
  if(!Object.keys(data).length)throw fail(400,'No hay cambios en la ficha');
  const version=Number(req.body.profile_version);if(!Number.isSafeInteger(version)||version<1)throw fail(400,'Recarga la ficha antes de editar');
  const result=await transaction(pool,cid(req),async db=>{
   const before=await client(db,cid(req),id(req),{lock:true});if(before.profile_version!==version)throw fail(409,'Otra persona modificó esta ficha. Recarga antes de guardar');
   await validateRelations(db,cid(req),data,before);if(data.client_code===null)throw fail(400,'El código de cliente no puede quedar vacío');
   const keys=Object.keys(data),values=keys.map(k=>data[k]);
   const after=(await db.query(`update clients set ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')},updated_at=now(),profile_version=profile_version+1 where company_id=$${values.length+1} and id=$${values.length+2} returning *`,[...values,cid(req),before.id])).rows[0];
   await event(db,req,cid(req),before.id,'update',before,after,why);return after;
  });res.json(result);
 }));
 app.post(BASE+'/:id/documents',...gate,wrap(async(req,res)=>{
  const target=await client(pool,cid(req),id(req));
  const today=(await pool.query("select (now() at time zone time_zone)::date::text today from company_personnel_policies where company_id=$1",[cid(req)])).rows[0]?.today||companyDate();
  const doc=validateDocument(req.body,today);
  if(!Object.hasOwn(req.body,'expected_current_id'))throw fail(400,'Recarga los documentos antes de subir');
  const expected=req.body.expected_current_id===null?null:identifier(req.body.expected_current_id);
  const store=storage(),key=`companies/${identifier(cid(req))}/clients/${identifier(target.id)}/consent/${crypto.randomUUID()}`;
  // Bytes are never stored on Render's ephemeral filesystem or in audit payloads.
  let uploaded=false,db,commitAttempted=false;
  try{
   await store.put({key,body:doc.buffer,mimeType:'application/pdf',size:doc.buffer.length});uploaded=true;
   db=await pool.connect();await db.query('BEGIN');await client(db,cid(req),target.id,{lock:true});
   const previous=(await db.query('select id from client_consent_documents where company_id=$1 and client_id=$2 and kind=$3 and current=true for update',[cid(req),target.id,doc.kind])).rows[0];
   if(previous?!same(previous.id,expected):expected!==null)throw fail(409,'El documento cambió durante la carga. Recarga la ficha');
   await db.query('update client_consent_documents set current=false where company_id=$1 and client_id=$2 and kind=$3 and current=true',[cid(req),target.id,doc.kind]);
   const after=(await db.query(`insert into client_consent_documents(company_id,client_id,kind,storage_key,filename,mime_type,size,sha256,signer_name,signer_capacity,signed_on,uploaded_by,uploaded_by_name,reason)
    values($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,$9,$10,$11,$12,$13) returning ${documentColumns}`,[cid(req),target.id,doc.kind,key,doc.filename,doc.buffer.length,doc.sha256,doc.signer_name,doc.signer_capacity,doc.signed_on,req.user.id,req.user.name||'',doc.reason])).rows[0];
   if(doc.kind==='signed')await db.query(`insert into client_privacy_status(company_id,client_id,status,updated_by,reason) values($1,$2,'recorded',$3,$4)
    on conflict(company_id,client_id) do update set status='recorded',updated_by=excluded.updated_by,updated_at=now(),reason=excluded.reason`,[cid(req),target.id,req.user.id,doc.reason]);
   await event(db,req,cid(req),target.id,'document_'+doc.kind,previous?{document_id:previous.id}:null,safeDocument(after),doc.reason);
   commitAttempted=true;await db.query('COMMIT');res.status(201).json(safeDocument(after));
  }catch(e){if(db)try{await db.query('ROLLBACK');}catch{}
   // After an uncertain COMMIT, retain the object: deleting could destroy a
   // successfully committed legal record. Orphans can be reconciled separately.
   if(uploaded&&!commitAttempted)try{await store.delete(key);}catch{console.error('Client document upload compensation failed');}
   throw e;
  }finally{db?.release();}
 }));
 app.get(BASE+'/:id/documents/:documentId/download',...gate,wrap(async(req,res)=>{
  const doc=(await pool.query('select id,storage_key,size,sha256 from client_consent_documents where company_id=$1 and client_id=$2 and id=$3',[cid(req),id(req),identifier(req.params.documentId)])).rows[0];if(!doc)throw fail(404,'Documento no encontrado');
  const result=await storage().get(doc.storage_key);const body=result.Body;
  const chunks=[],hash=crypto.createHash('sha256');let size=0;
  if(!body||typeof body[Symbol.asyncIterator]!=='function')throw fail(503,'No se pudo leer el respaldo privado');
  for await(const chunk of body){const b=Buffer.from(chunk);size+=b.length;if(size>1048576||size>doc.size)throw fail(503,'Tamaño de respaldo inconsistente');hash.update(b);chunks.push(b);}
  if(size!==doc.size)throw fail(503,'Respaldo incompleto');
  if(hash.digest('hex')!==doc.sha256)throw fail(503,'El respaldo no supera la comprobación de integridad');
  await writeAudit(pool,req,{companyId:cid(req),action:'download',entity:'client_document',entityId:doc.id,afterData:{client_id:id(req)}});
  res.set('Content-Type','application/pdf');res.set('Content-Disposition',`attachment; filename="client-document-${identifier(doc.id)}.pdf"`);
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.send(Buffer.concat(chunks));
 }));
 app.post(BASE+'/:id/privacy/revoke',...gate,wrap(async(req,res)=>{
  const why=reason(req.body?.reason);await transaction(pool,cid(req),async db=>{
   const row=await client(db,cid(req),id(req),{lock:true});
   const before=(await db.query('select status from client_privacy_status where company_id=$1 and client_id=$2',[cid(req),row.id])).rows[0];
   if(before?.status!=='recorded')throw fail(409,'Solo se registra revocación de un respaldo previamente registrado');
   await db.query("update client_privacy_status set status='revoked',updated_by=$1,updated_at=now(),reason=$2 where company_id=$3 and client_id=$4",[req.user.id,why,cid(req),row.id]);
   await event(db,req,cid(req),row.id,'privacy_revoke',before,{status:'revoked'},why);
  });res.json({status:'revoked',consent_is_blocking:false});
 }));
}
module.exports={registerClientRoutes,validateRelations,event};
