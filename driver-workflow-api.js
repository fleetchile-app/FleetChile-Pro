'use strict';
const {createHash}=require('node:crypto');
const {writeAudit}=require('./audit');
const D=require('./itinerary-domain');
const {terminal}=require('./trip-resources');
const {currentPlan,loadState,recordItineraryEvent}=require('./itinerary-api');
const Checklist=require('./public/checklist-shared');
const CHECKS=Checklist.ids;
function versions(trip,b){
 if(!Number.isInteger(b.resource_version)||b.resource_version!==trip.resource_version||!Number.isInteger(b.version)||b.version!==trip.itinerary_version)throw D.fail('Cambió la asignación o el itinerario. Revisa el pendiente con operaciones.',409,'MOBILE_STALE');
}
async function validateDeliveryContext(db,trip,b,loadId){
 if(b.resource_version!==undefined||b.version!==undefined)versions(trip,b);
 if(terminal(trip.status))throw D.fail('El viaje está cerrado',409);
 if(!trip.itinerary_version){if(trip.origin_location_id||trip.destination_location_id)throw D.fail('Confirma el itinerario del viaje antes de registrar entregas.',409,'ITINERARY_LOCATION_CONFLICT');return;}
 const revision=await currentPlan(db,trip),state=await loadState(db,trip);
 if(!revision)throw D.fail('No se encontró el itinerario',409);
 await require('./itinerary-coherence').verify(db,trip,revision.plan,state.loads,state.events);
 if(JSON.stringify(D.signature(state.loads))!==JSON.stringify(revision.plan.load_signature))throw D.fail('Las cargas cambiaron: operaciones debe revisar el itinerario',409,'ITINERARY_STALE');
 const next=D.progress(revision.plan,state.events).find(s=>!s.actual_departure),mapping=revision.plan.loads.find(m=>String(m.load_id)===String(loadId));
 if(!mapping||mapping.delivery!==next?.key||!next.actual_arrival)throw D.fail('Registra la llegada a la parada de esta entrega antes de confirmarla',409,'DELIVERY_STOP_PENDING');
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function registerDriverWorkflow(app,pool,{driverAccess,enforceDriverPersonnel}){
 const BASE='/api/driver/trips/:id/workflow';
 const tripQuery='select * from trips where id=$1 and company_id=$2 and driver_id=$3';
 const values=req=>[req.params.id,req.user.company_id,req.user.driver_id];
 const error=(res,e)=>res.status(e.status||500).json({error:e.status?e.message:'No se pudo registrar la acción móvil',code:e.code||'MOBILE_ERROR'});
 app.get(BASE,async(req,res)=>{
  if(!driverAccess(req,res))return;
  try{
   const trip=(await pool.query(tripQuery,values(req))).rows[0];if(!trip)return res.sendStatus(404);
   const revision=await currentPlan(pool,trip),state=await loadState(pool,trip),plan=revision?.plan;
   const progress=plan?D.progress(plan,state.events):[];
   const loads=(await pool.query('select l.id,l.cargo,l.weight_kg,l.status,l.delivered_at,c.name client_name from trip_loads l join clients c on c.id=l.client_id and c.company_id=$2 where l.trip_id=$1 order by l.id',[trip.id,trip.company_id])).rows;
   const accepted=(await pool.query("select confirmed_at from driver_mobile_actions where company_id=$1 and trip_id=$2 and resource_version=$3 and driver_id=$4 and kind='accept' order by id desc limit 1",[trip.company_id,trip.id,trip.resource_version,trip.driver_id])).rows[0];
   res.json({trip_id:trip.id,status:trip.status,resource_version:trip.resource_version,version:trip.itinerary_version,accepted_at:accepted?.confirmed_at||null,stops:progress,next_stop:progress.find(s=>!s.actual_departure)||null,loads:D.outcomes(loads,state.events).map(l=>({...l,...(plan?.loads.find(m=>String(m.load_id)===String(l.id))||{}),picked_up:state.events.some(e=>e.kind==='pickup'&&String(e.load_id)===String(l.id))}))});
  }catch(e){error(res,e);}
 });
 for(const action of ['events','accept','checklist'])app.post(BASE+'/'+action,async(req,res)=>{
  if(!driverAccess(req,res))return;
  let db;try{
   const b=req.body||{};db=await pool.connect();await db.query('BEGIN');
   if(!await enforceDriverPersonnel(db,req,res))return;
   const trip=(await db.query(tripQuery+' for update',values(req))).rows[0];if(!trip)throw D.fail('Viaje no disponible para este conductor',404);
   // Validate live assignment even on retries; receipts never authorize a former driver.
   if(action==='events'){
    versions(trip,b);
    const result=await recordItineraryEvent(db,req,trip,b,{pickups:true});
    if(result.created&&b.kind==='depart')await require('./trip-eligibility').assertTripResourcesReady(db,{companyId:trip.company_id,truckId:trip.truck_id,trailerId:trip.trailer_id,driverId:trip.driver_id,tripId:trip.id,status:'En tránsito',predeparture:true,plannedDeparture:trip.planned_departure,plannedArrival:trip.planned_arrival,compositionSnapshot:trip.composition_snapshot,itineraryVersion:trip.itinerary_version});
    await db.query('COMMIT');return res.status(result.created?201:200).json(result.row);
   }
   const key=D.key(b.client_key),hash=digest(b);
   const previous=(await db.query('select * from driver_mobile_actions where company_id=$1 and trip_id=$2 and actor_user_id=$3 and client_key=$4',[trip.company_id,trip.id,req.user.id,key])).rows[0];
   if(previous){if(previous.kind!==action||previous.payload_hash!==hash)throw D.fail('El identificador corresponde a otros datos',409);await db.query('COMMIT');return res.json(previous.result);}
   versions(trip,b);if(terminal(trip.status))throw D.fail('El viaje está cerrado',409);
   const reported=b.reported_at?new Date(b.reported_at):null;
   if(reported&&(!Number.isFinite(reported.getTime())||reported.getTime()>Date.now()+300000))throw D.fail('Fecha informada no válida');
   let result={accepted:true,resource_version:trip.resource_version};
   if(action==='checklist'){
    if(!trip.truck_id)throw D.fail('El viaje no tiene camión asignado',409);
    const canonical=Checklist.normalized(b.items),status=canonical.some(i=>i.result==='fail')?'Rechazado':'Aprobado';
    const checked=Checklist.validate({items:canonical,status,observations:b.observations});
    const existing=(await db.query('select * from vehicle_checklists where trip_id=$1 and truck_id=$2 and driver_id=$3 order by id desc limit 1 for update',[trip.id,trip.truck_id,trip.driver_id])).rows[0];
    const replacement=existing&&Checklist.canRegularize(existing);
    if(existing&&existing.status!=='Pendiente'&&!replacement)throw D.fail('El checklist ya está cerrado. Revisa su resultado con operaciones.',409);
    if(replacement&&(String(b.supersedes_id)!==String(existing.id)||typeof b.reason!=='string'||b.reason.trim().length<5||b.reason.length>1000))throw D.fail('Confirma el registro histórico y el motivo de la nueva inspección',409,'CHECKLIST_REGULARIZATION_REQUIRED');
    if(!replacement&&b.supersedes_id!=null)throw D.fail('El registro anterior cambió. Recarga el checklist.',409);
    const items=JSON.stringify(checked.items),notes=checked.observations;
    result=existing&&!replacement?(await db.query('update vehicle_checklists set status=$1,items=$2,observations=$3,completed_at=now(),completed_by=$5,completed_by_name=$6 where id=$4 returning *',[status,items,notes,existing.id,req.user.id,req.user.name||null])).rows[0]:(await db.query("insert into vehicle_checklists(truck_id,driver_id,trip_id,checklist_type,status,items,observations,completed_at,created_by,created_by_name,completed_by,completed_by_name,supersedes_id) values($1,$2,$3,'Preoperacional',$4,$5,$6,now(),$7,$8,$7,$8,$9) returning *",[trip.truck_id,trip.driver_id,trip.id,status,items,notes,req.user.id,req.user.name||null,replacement?existing.id:null])).rows[0];
    if(status==='Rechazado')await db.query("insert into alerts(company_id,level,title,text,resolved,created_at,source_type,source_id,condition_code) values($1,'critical','Checklist rechazado',$2,false,now(),'checklist',$3,'checklist_rejected') on conflict (company_id,source_type,source_id,condition_code) where resolved=false and source_type is not null and source_id is not null and condition_code is not null do nothing",[trip.company_id,'Checklist rechazado para el viaje '+trip.id,result.id]);
    await writeAudit(db,req,{companyId:trip.company_id,action:existing&&!replacement?'update':'create',entity:'vehicle_checklist',entityId:result.id,beforeData:existing,afterData:{...result,...(replacement?{regularization_reason:b.reason.trim()}:{} )}});
   }
   const receipt=(await db.query('insert into driver_mobile_actions(company_id,trip_id,actor_user_id,driver_id,resource_version,client_key,kind,payload_hash,result,reported_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id,confirmed_at',[trip.company_id,trip.id,req.user.id,trip.driver_id,trip.resource_version,key,action,hash,result,reported])).rows[0];
   await db.query('insert into trip_events(trip_id,event_type,notes,created_by,details) values($1,$2,$3,$4,$5)',[trip.id,action==='accept'?'Aceptación del conductor':'Checklist',action==='accept'?'Viaje aceptado por el conductor':'Checklist '+result.status,req.user.id,{mobile_action_id:receipt.id,reported_at:reported}]);
   await writeAudit(db,req,{companyId:trip.company_id,action:'create',entity:'driver_mobile_action',entityId:receipt.id,afterData:{kind:action,trip_id:trip.id,resource_version:trip.resource_version,reported_at:reported}});
   await db.query('COMMIT');res.status(201).json(result);
  }catch(e){if(db)await db.query('ROLLBACK');error(res,e);}finally{db?.release();}
 });
}
module.exports={registerDriverWorkflow,validateDeliveryContext,versions,CHECKS};
