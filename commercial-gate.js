'use strict';
const {resolveActorContext}=require('./auth');
const {moduleFor}=require('./commercial-domain');
const {current}=require('./commercial-api');
function commercialGate(pool){return async(req,res,next)=>{
 const path=(req.originalUrl||req.path||'').split('?')[0].toLowerCase().replace(/\/+$/,''),feature=moduleFor(path);
 if(!feature)return next();
 const actor=resolveActorContext(req);if(actor?.scope!=='company'||!actor.company_id)return next();
 const cid=actor.company_id;
 try{
  const c=(await pool.query('select commercial_enforced from companies where id=$1',[cid])).rows[0];if(!c?.commercial_enforced)return next();
  const contract=await current(pool,cid),enabled=contract?.configuration.modules.includes(feature),read=['GET','HEAD'].includes(req.method);
  // Records remain consultable. Reports and live GPS are contracted functions;
  // historic GPS with an explicit date range remains available for consultation.
  if(read&&(feature!=='reports'&&feature!=='gps'||feature==='gps'&&(/\/history$/.test(path)||req.query?.from)))return next();
  if(enabled){
   if(!read&&['operations','maintenance','fuel','gps'].includes(feature))for(const value of [req.body?.truck_id,req.body?.trailer_id]){
    const id=Number(value);if(Number.isSafeInteger(id)&&id>0)await pool.query('select commercial_require($1,$2,$3)',[cid,feature,id]);
   }
   return next();
  }
  if(feature==='gps'){
   const trackingTrip=path.match(/\/driver\/trips\/(\d+)\/tracking(?:\/(?:context|positions|stop))?$/)?.[1];
   if(trackingTrip){
    // The tracking handler revalidates the driver, session, resource version and snapshot.
    if(path.endsWith('/stop'))return next();
    const row=(await pool.query(`select t.status,t.commercial_modules,exists(
     select 1 from operational_outing_services s join operational_outings o on o.id=s.outing_id and o.company_id=s.company_id
      where s.company_id=t.company_id and s.trip_id=t.id and o.closed_at is null
       and (o.commercial_modules is null or o.commercial_modules ? 'gps')) outing_gps
     from trips t where t.company_id=$1 and t.id=$2`,[cid,trackingTrip])).rows[0];
    if(row&&(row.outing_gps||['En carga','En tránsito','Detenido','Llegó a destino','Descargando'].includes(row.status)&&(row.commercial_modules==null||row.commercial_modules.includes('gps'))))return next();
    return res.status(403).json({code:'MODULE_NOT_CONTRACTED',error:'Esta operación no conserva una habilitación GPS vigente.'});
   }
   const returnTrip=path.match(/\/driver\/trips\/(\d+)\/outing\/positions$/)?.[1];
   if(returnTrip){
    const row=(await pool.query(`select o.commercial_modules from operational_outings o join operational_outing_services s on s.outing_id=o.id and s.company_id=o.company_id
     where o.company_id=$1 and s.trip_id=$2 and o.status='returning' and o.closed_at is null`,[cid,returnTrip])).rows[0];
    if(row&&(row.commercial_modules==null||row.commercial_modules.includes('gps')))return next();
    return res.status(403).json({code:'MODULE_NOT_CONTRACTED',error:'El seguimiento GPS no estaba contratado para esta salida de retorno.'});
   }
   const truck=path.match(/\/trucks\/(\d+)\//)?.[1]||req.body?.truck_id||req.query?.truck_id;
   const unit=Number.isSafeInteger(Number(truck))&&Number(truck)>0?Number(truck):null;
   if(unit){
    const returning=(await pool.query(`select id from operational_outings where company_id=$1 and truck_id=$2
     and status='returning' and closed_at is null and (commercial_modules is null or commercial_modules ? 'gps')`,[cid,unit])).rows[0];
    if(returning)return next();
   }
   const ongoing=(await pool.query('select commercial_running_gps($1,$2) allowed',[cid,unit])).rows[0]?.allowed;
   if(ongoing)return next();
  }
  const match=path.match(/\/(?:driver\/trips|operations\/trips|trips)\/(\d+)(?:\/|$)/);
  if(!read&&match){
   if(/\/outing\/action$/.test(path)&&['wait','return','arrive_base','release'].includes(req.body?.action)){
    const row=(await pool.query(`select o.id from operational_outings o join operational_outing_services s on s.outing_id=o.id and s.company_id=o.company_id
     where o.company_id=$1 and s.trip_id=$2 and o.closed_at is null`,[cid,match[1]])).rows[0];
    if(row)return next();
   }
   const trip=(await pool.query('select status,actual_departure,commercial_modules from trips where id=$1 and company_id=$2',[match[1],cid])).rows[0];
   const ongoing=trip&&!['Completado','Cancelado','Planificado','Asignado'].includes(trip.status);
   const prior=trip?.commercial_modules==null||trip.commercial_modules.includes(feature);
   const completion=/\/status$/.test(path)&&['Detenido','En tránsito','Llegó a destino','Descargando','Completado','Cancelado'].includes(req.body?.status);
   const facts=/\/(deliveries|checklist|workflow\/events)(?:\/|$)/.test(path);
   if(ongoing&&prior&&(completion||facts))return next();
   if(/\/status$/.test(path)&&req.body?.status==='Cancelado'&&trip)return next();
  }
  const work=path.match(/\/fleet\/(?:work-orders|maintenance)\/(\d+)(?:\/|$)/);
  if(!read&&work){const row=(await pool.query('select status from maintenance where id=$1 and company_id=$2',[work[1],cid])).rows[0];if(row&&['En proceso','Completada'].includes(row.status))return next();}
  return res.status(403).json({code:contract?'MODULE_NOT_CONTRACTED':'PREPAID_PERIOD_REQUIRED',error:contract?'Esta función no está contratada. Solicita su habilitación en Capacidad y servicios.':'No existe un período pagado vigente. Se conserva la consulta y el cierre controlado de servicios en ejecución.'});
 }catch(e){if(e.code?.startsWith('P75'))return res.status(409).json({code:'COMMERCIAL_BLOCKED',error:e.message+'. Revisa Capacidad y servicios con administración.'});return res.status(503).json({code:'COMMERCIAL_UNAVAILABLE',error:'No se pudo verificar el contrato. Reintenta; no se habilitó capacidad por defecto.'});}
};}
module.exports={commercialGate};
