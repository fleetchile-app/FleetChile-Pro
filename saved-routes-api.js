'use strict';
const {writeAudit}=require('./audit');
const BASE='/api/operations/trips/:id/itinerary/saved-routes';
const fail=(status,message)=>Object.assign(Error(message),{status,code:'SAVED_ROUTE_INVALID'});
function id(value){if(!['string','number'].includes(typeof value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw fail(400,'Ubicación no válida');return Number(value);}
// Reuses the itinerary's existing permission/company/trip guard. No service is activated.
function registerSavedRoutes(pool,route){
 route('get',BASE,'trips.manage',async(req,res,trip)=>{
  const page=Number(req.query?.page||1),q=String(req.query?.q||'').trim();
  if(!Number.isSafeInteger(page)||page<1||page>100000||q.length>120)throw fail(400,'Filtro de recorridos no válido');
  const where="r.company_id=$1 and ($2='' or strpos(lower(coalesce(r.origin,'')||' '||coalesce(r.destination,'')),lower($2))>0)";
  const rows=(await pool.query(`select r.id,r.origin,r.destination,r.origin_location_id,r.destination_location_id,
   (a.id is not null and b.id is not null and a.lat is not null and a.lng is not null and b.lat is not null and b.lng is not null) can_use
   from routes r left join operational_locations a on a.id=r.origin_location_id and a.company_id=r.company_id
   left join operational_locations b on b.id=r.destination_location_id and b.company_id=r.company_id
   where ${where} order by r.id desc limit 25 offset $3`,[trip.company_id,q,(page-1)*25])).rows;
  const total=(await pool.query(`select count(*)::int n from routes r where ${where}`,[trip.company_id,q])).rows[0].n;
  res.set('Cache-Control','private, no-store').json({rows,total,page,page_size:25});
 });
 route('post',BASE,'trips.manage',async(req,res,trip)=>{
  const body=req.body||{};
  if(Object.keys(body).some(k=>!['origin_location_id','destination_location_id'].includes(k)))throw fail(400,'Guarda sólo los puntos del recorrido, no recursos ni datos de ejecución');
  const origin=id(body.origin_location_id),destination=id(body.destination_location_id);
  if(origin===destination)throw fail(400,'Selecciona dos ubicaciones diferentes');
  const db=await pool.connect();try{
   await db.query('BEGIN');
   await db.query('select id from companies where id=$1 for update',[trip.company_id]);
   const points=(await db.query('select id,name,lat,lng from operational_locations where company_id=$1 and id=any($2::bigint[]) for share',[trip.company_id,[origin,destination]])).rows;
   if(points.length!==2||points.some(p=>p.lat==null||p.lng==null))throw fail(400,'Confirma ambos accesos en ubicaciones de tu empresa');
   const existing=(await db.query('select id,origin,destination,origin_location_id,destination_location_id from routes where company_id=$1 and origin_location_id=$2 and destination_location_id=$3 order by id limit 1',[trip.company_id,origin,destination])).rows[0];
   if(existing){await db.query('COMMIT');return res.json({...existing,reused:true});}
   const a=points.find(p=>Number(p.id)===origin),b=points.find(p=>Number(p.id)===destination);
   const saved=(await db.query("insert into routes(company_id,origin,destination,origin_location_id,destination_location_id,distance_km,progress,status) values($1,$2,$3,$4,$5,null,0,'Planificada') returning id,origin,destination,origin_location_id,destination_location_id",[trip.company_id,a.name,b.name,origin,destination])).rows[0];
   await writeAudit(db,req,{companyId:trip.company_id,action:'create',entity:'route',entityId:saved.id,afterData:{...saved,source_trip_id:trip.id,purpose:'saved_endpoints'}});
   await db.query('COMMIT');res.status(201).json(saved);
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
}
module.exports={registerSavedRoutes};
