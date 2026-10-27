'use strict';
const crypto=require('node:crypto');
const {requirePermission}=require('./auth');
const E=require('./enterprise-common'),D=require('./import-domain'),S=require('./support-access');
const {companyGate,platformManager}=require('./enterprise-api');
function permission(req,res,kind,next){const spec=typeof kind==='string'&&Object.hasOwn(D.specs,kind)?D.specs[kind]:null;if(!spec)return res.status(400).json({error:'Tipo de importación no válido'});if(S.allows(req,'imports')||platformManager(req))return next();return requirePermission(spec.permission)(req,res,next)}
async function insertRow(db,req,cid,kind,data,batchId){
 let row;
 if(kind==='clients'){
  const fields=Object.keys(data).filter(k=>data[k]!==undefined&&!(k==='client_code'&&!data[k]));
  row=(await db.query(`insert into clients(company_id,${fields.join(',')}) values($1,${fields.map((_,i)=>'$'+(i+2)).join(',')}) returning *`,[cid,...fields.map(k=>data[k])])).rows[0];
  await require('./client-api').event(db,req,cid,row.id,'create',null,row,'Importación '+batchId);
 }else if(kind==='vehicles'){
  row=(await db.query('insert into trucks(company_id,patente,brand,model,tipo,capacidad_t,vin,engine_number,profile_version) values($1,$2,$3,$4,$5,$6,$7,$8,1) returning *',[cid,data.patente,data.brand,data.model,data.tipo,data.capacidad_t??null,data.vin??null,data.engine_number??null])).rows[0];
  for(const [code,label] of [['circulation','Permiso de circulación'],['soap','SOAP'],['inspection','Revisión técnica']])if(data[code+'_expiry'])await db.query("insert into vehicle_documents(truck_id,document_type,road_requirement_code,expires_at,status) values($1,$2,$3,$4,'Vigente')",[row.id,label,code,data[code+'_expiry']]);
  await require('./audit').writeAudit(db,req,{companyId:cid,action:'import',entity:'truck_profile',entityId:row.id,afterData:{...row,batch_id:batchId}});
 }else{
  row=(await db.query('insert into company_people(company_id,name,rut,birth_date,job_title,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$6) returning *',[cid,data.name,data.rut,data.birth_date,data.job_title,req.user.id])).rows[0];
  await require('./personnel-repository').record(db,req,cid,row.id,'person_import',null,row,'Importación '+batchId);
 }
 return row.id;
}
function registerImportRoutes(app,pool){
 const gate=companyGate('imports'),cid=req=>req.enterpriseCompany;
 app.get('/api/company/imports/template',gate,(req,res,next)=>permission(req,res,req.query?.kind,next),E.wrap(async(req,res)=>{
  const kind=req.query.kind;res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition',`attachment; filename="plantilla-${kind}.csv"`).send('\uFEFF'+D.specs[kind].columns.map(k=>D.columnLabels[k]||k).join(';')+'\r\n');
 }));
 app.post('/api/company/imports/preview',gate,(req,res,next)=>permission(req,res,req.body?.kind,next),E.wrap(async(req,res)=>{
  const b=req.body||{};if(Object.keys(b).some(k=>!['kind','csv'].includes(k)))E.fail(400,'Campos no permitidos');
  const rows=D.parseCsv(b.csv,b.kind),batchId=crypto.randomUUID();
  const result=await E.transaction(pool,cid(req),async db=>{
   await db.query('delete from company_import_batches where company_id=$1 and expires_at<now() and committed_at is null',[cid(req)]);
   const preview=await D.validateRows(db,cid(req),b.kind,rows),valid=preview.every(r=>r.valid);
   await db.query('insert into company_import_batches(id,company_id,actor_id,kind,rows,preview,source_hash) values($1,$2,$3,$4,$5,$6,$7)',[batchId,cid(req),req.user.id,b.kind,JSON.stringify(rows),JSON.stringify(preview),crypto.createHash('sha256').update(b.csv).digest('hex')]);
   await E.event(db,req,cid(req),'import_preview',batchId,'Previsualización de importación',null,{kind:b.kind,count:rows.length,valid});
   return {id:batchId,kind:b.kind,rows:preview,can_commit:valid,expires_in_hours:24};
  });res.json(result);
 }));
 app.post('/api/company/imports/:id/commit',gate,E.wrap(async(req,res)=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id||''))E.fail(400,'Lote no válido');
  const why=E.reason(req.body?.reason);if(req.body?.confirmed!==true)E.fail(400,'Confirma expresamente la creación de registros');
  const batch=(await pool.query('select kind from company_import_batches where id=$1 and company_id=$2 and actor_id=$3',[req.params.id,cid(req),req.user.id])).rows[0];if(!batch)E.fail(404,'Lote no encontrado');
  let permitted=false;permission(req,res,batch.kind,()=>{permitted=true});if(!permitted)return;
  const result=await E.transaction(pool,cid(req),async db=>{
   const b=(await db.query('select *,expires_at>now() unexpired from company_import_batches where id=$1 and company_id=$2 and actor_id=$3 for update',[req.params.id,cid(req),req.user.id])).rows[0];
   if(b.committed_at)return {...b.result,replayed:true};if(!b.unexpired)E.fail(409,'La previsualización venció; vuelve a cargar el archivo');
   const preview=await D.validateRows(db,cid(req),b.kind,b.rows);if(!preview.every(r=>r.valid))E.fail(409,'El lote contiene errores o cambió una referencia; genera otra previsualización');
   const ids=[];for(const row of preview)ids.push(await insertRow(db,req,cid(req),b.kind,row.data,b.id));
   const result={id:b.id,kind:b.kind,count:ids.length,record_ids:ids};
   await db.query("update company_import_batches set committed_at=now(),result=$1,rows='[]'::jsonb,preview='[]'::jsonb where id=$2",[result,b.id]);
   await E.event(db,req,cid(req),'import_commit',b.id,why,null,result);return result;
  });res.json(result);
 }));
 app.get('/api/company/imports/history',gate,E.wrap(async(req,res)=>res.json({rows:(await pool.query('select id,kind,source_hash,created_at,expires_at,committed_at,result from company_import_batches where company_id=$1 and actor_id=$2 order by created_at desc limit 50',[cid(req),req.user.id])).rows})));
}
module.exports={registerImportRoutes,insertRow};
