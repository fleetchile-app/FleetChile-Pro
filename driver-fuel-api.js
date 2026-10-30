'use strict';
const crypto=require('node:crypto'),Entry=require('./fuel-entry'),{writeAudit}=require('./audit');
const {attachment}=require('./financial-support-api'),{createStorage}=require('./storage');
const {versions}=require('./driver-workflow-api'),{linkFuel}=require('./fuel-cost-policy');
const fail=(status,message)=>Object.assign(Error(message),{status});
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
function registerDriverFuel(app,pool,{driverAccess,enforceDriverPersonnel,storage}){
 const base='/api/driver/trips/:id/fuel',params=req=>[req.params.id,req.user.company_id,req.user.driver_id];
 app.get(base,async(req,res)=>{
  if(!driverAccess(req,res))return;
  try{
   const trip=(await pool.query('select id from trips where id=$1 and company_id=$2 and driver_id=$3',params(req))).rows[0];if(!trip)return res.sendStatus(404);
   const rows=(await pool.query(`select client_key,result,confirmed_at from driver_mobile_actions where trip_id=$1 and company_id=$2 and driver_id=$3 and actor_user_id=$4 and kind='fuel' order by id desc limit 100`,[...params(req),req.user.id])).rows;
   res.json({rows});
  }catch{res.status(503).json({error:'No se pudo consultar la recepción de combustible'});}
 });
 app.post(base,async(req,res)=>{
  if(!driverAccess(req,res))return;
  let db,store,key,uploaded=false;
  try{
   const b=req.body||{},keyId=b.client_key;
   if(typeof keyId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(keyId))throw fail(400,'Identificador de envío no válido');
   const input=Entry.parse(b),hash=crypto.createHash('sha256').update(JSON.stringify(canonical(b))).digest('hex');
   const photo=await attachment(b.photo);if(!photo||!photo.mime.startsWith('image/'))throw fail(400,'La fotografía del comprobante es obligatoria para cualquier medio de pago');
   db=await pool.connect();await db.query('BEGIN');if(!await enforceDriverPersonnel(db,req,res))return;
   const trip=(await db.query('select * from trips where id=$1 and company_id=$2 and driver_id=$3 for update',params(req))).rows[0];if(!trip)throw fail(404,'Viaje no disponible para este conductor');
   const prior=(await db.query('select * from driver_mobile_actions where trip_id=$1 and actor_user_id=$2 and client_key=$3',[trip.id,req.user.id,keyId])).rows[0];
   if(prior){if(prior.kind!=='fuel'||prior.payload_hash!==hash)throw fail(409,'La clave de envío corresponde a otros datos');await db.query('COMMIT');return res.json(prior.result);}
   versions(trip,b);if(['Completado','Cancelado','Planificado'].includes(trip.status))throw fail(409,'No se admite un nuevo abastecimiento en este estado. Conserva el pendiente para revisión con operaciones');
   if(!trip.truck_id)throw fail(409,'El viaje no tiene camión');
   await db.query("select commercial_require($1,'fuel',$2),commercial_require($1,'economics')",[trip.company_id,trip.truck_id]);
   const truck=(await db.query('select id,patente from trucks where id=$1 and company_id=$2 for share',[trip.truck_id,trip.company_id])).rows[0];if(!truck)throw fail(409,'Camión no disponible');
   const fuel=await Entry.insert(db,trip.company_id,truck,input),link=await linkFuel(db,req,fuel,Number(trip.id));
   store=storage||createStorage();key=`companies/${trip.company_id}/financial-support/${crypto.randomUUID()}`;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);timer.unref?.();uploaded=true;
   try{await store.put({key,body:photo.bytes,mimeType:photo.mime,size:photo.bytes.length,signal:controller.signal});}finally{clearTimeout(timer);}
   const file=(await db.query('insert into financial_support_entries(company_id,fuel_id,reference,storage_key,mime_type,size,sha256,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',[trip.company_id,fuel.id,input.reference,key,photo.mime,photo.bytes.length,photo.sha256,req.user.id])).rows[0];
   const result={fuel_id:fuel.id,trip_id:trip.id,total_clp:input.total,liters:input.liters,date:input.date,photo_received:true,attachment_id:file.id,...link};
   await db.query("insert into driver_mobile_actions(company_id,trip_id,actor_user_id,driver_id,resource_version,client_key,kind,payload_hash,result,reported_at) values($1,$2,$3,$4,$5,$6,'fuel',$7,$8,now())",[trip.company_id,trip.id,req.user.id,trip.driver_id,trip.resource_version,keyId,hash,result]);
   await writeAudit(db,req,{companyId:trip.company_id,action:'driver_fuel',entity:'fuel',entityId:fuel.id,afterData:{...result,driver_id:trip.driver_id,client_key:keyId}});
   await db.query('COMMIT');uploaded=false;res.status(201).json(result);
  }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}if(uploaded)try{await store.delete(key)}catch{console.error('DRIVER_FUEL_COMPENSATION_FAILED');}res.status(e.status||(/^P75/.test(e.code||'')?403:e.code==='55000'?409:503)).json({error:e.status?e.message:'No se confirmó el abastecimiento. Conserva el pendiente y reintenta con la misma clave.'});}finally{db?.release();}
 });
}
module.exports={registerDriverFuel};
