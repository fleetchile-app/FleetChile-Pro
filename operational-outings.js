'use strict';
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {assertTripAvailability}=require('./trip-availability');
const {assertTripResourcesReady:defaultReadiness}=require('./trip-eligibility');
const {equipmentSnapshot}=require('./equipment-api');
const {syncResourceAlert}=require('./trip-resources');
const fail=(message,status=409,code='OUTING_CONFLICT')=>Object.assign(new Error(message),{status,code});
const terminal=status=>['Completado','Cancelado'].includes(status);
const positive=value=>typeof value!=='boolean'&&value!==null&&value!==''&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const same=(a,b)=>String(a??'')===String(b??'');
const reasonOf=b=>typeof b.reason==='string'?b.reason.trim().slice(0,2000):null;

async function findOuting(db,companyId,tripId,lock=false){
 return (await db.query(`select o.* from operational_outings o join operational_outing_services s
  on s.outing_id=o.id and s.company_id=o.company_id where s.company_id=$1 and s.trip_id=$2${lock?' for update of o nowait':''}`,[companyId,tripId])).rows[0]||null;
}
// Match existing assignment order: trip, membership, person, driver, sorted vehicles.
// No competing trips are locked; link uses NOWAIT on its second trip to avoid a cycle.
async function lockResources(db,trip){
 await db.query(`select um.id from user_memberships um join users u on u.id=um.user_id
  where um.company_id=$1 and u.company_id=$1 and u.driver_id=$2 for update of um nowait`,[trip.company_id,trip.driver_id]);
 await db.query('select id from company_people where company_id=$1 and driver_id=$2 for update nowait',[trip.company_id,trip.driver_id]);
 if(!(await db.query('select id from drivers where company_id=$1 and id=$2 for update nowait',[trip.company_id,trip.driver_id])).rows.length)throw fail('Conductor ajeno a la empresa',403);
 const ids=[...new Set([trip.truck_id,trip.trailer_id].filter(Boolean).map(Number))].sort((a,b)=>a-b);
 const rows=(await db.query('select id from trucks where company_id=$1 and id=any($2::integer[]) order by id for no key update nowait',[trip.company_id,ids])).rows;
 if(rows.length!==ids.length)throw fail('Vehículo ajeno a la empresa',403);
}
async function snapshot(db,trip,driver=false){
 let outing=await findOuting(db,trip.company_id,trip.id);
 if(driver&&outing&&!same(outing.driver_id,trip.driver_id))throw fail('Salida no encontrada',404);
 let services=[],events=[],last_position=null;
 if(outing){
  services=(await db.query(`select s.trip_id,s.sequence,t.trip_number,t.status,t.origin,t.destination,t.origin_location_id,t.destination_location_id
   from operational_outing_services s join trips t on t.id=s.trip_id and t.company_id=s.company_id
   where s.company_id=$1 and s.outing_id=$2${driver?' and t.driver_id=$3':''} order by s.sequence`,[trip.company_id,outing.id,...(driver?[trip.driver_id]:[])])).rows;
  events=(await db.query('select id,kind,reason,trip_id,created_at from operational_outing_events where company_id=$1 and outing_id=$2 order by id',[trip.company_id,outing.id])).rows;
  last_position=(await db.query('select lat,lng,accuracy_m,recorded_at from operational_outing_positions where company_id=$1 and outing_id=$2 order by recorded_at desc,id desc limit 1',[trip.company_id,outing.id])).rows[0]||null;
  const base=(await db.query('select name from operational_locations where company_id=$1 and id=$2',[trip.company_id,outing.base_location_id])).rows[0];
  const last=services.at(-1);
  outing={...outing,base_name:base?.name||null,suggested_origin_location_id:last?.status==='Completado'?last.destination_location_id||null:null};
 }
 const result={outing,services,events,last_position,can_manage:!driver};
 if(!driver){
  result.locations=(await db.query('select id,name from operational_locations where company_id=$1 order by name,id',[trip.company_id])).rows;
  result.candidates=outing&&!outing.closed_at?(await db.query(`select t.id,t.trip_number,t.origin,t.destination,t.origin_location_id,t.status from trips t
   where t.company_id=$1 and (t.truck_id is null or t.truck_id=$2) and (t.driver_id is null or t.driver_id=$3)
    and (t.trailer_id is null or t.trailer_id=$4::integer)
    and t.status in ('Planificado','Asignado') and not exists(select 1 from operational_outing_services s where s.company_id=t.company_id and s.trip_id=t.id)
   order by t.planned_departure nulls last,t.id limit 100`,[trip.company_id,outing.truck_id,outing.driver_id,outing.trailer_id])).rows:[];
 }
 return result;
}
async function event(db,req,outing,kind,reason,tripId){
 await db.query('insert into operational_outing_events(company_id,outing_id,kind,reason,trip_id,created_by) values($1,$2,$3,$4,$5,$6)',[outing.company_id,outing.id,kind,reason,tripId,req.user.id]);
}
async function linkedResources(db,req,next,outing,reason,readiness,review){
 const assigned={...next,truck_id:outing.truck_id,driver_id:outing.driver_id,trailer_id:outing.trailer_id};
 await readiness(db,{companyId:next.company_id,truckId:assigned.truck_id,driverId:assigned.driver_id,trailerId:assigned.trailer_id,
  tripId:next.id,status:next.status,plannedDeparture:next.planned_departure,plannedArrival:next.planned_arrival});
 if(['truck_id','driver_id','trailer_id'].every(k=>same(next[k],assigned[k])))return next;
 const rows=(await db.query('select id,company_id,patente,tipo,capacidad_t from trucks where company_id=$1 and id=any($2::integer[]) order by id',[next.company_id,[outing.truck_id,outing.trailer_id].filter(Boolean)])).rows;
 const equipment=equipmentSnapshot({truck_id:outing.truck_id,trailer_id:outing.trailer_id},rows);
 const driver=(await db.query('select id,name from drivers where company_id=$1 and id=$2',[next.company_id,outing.driver_id])).rows[0];
 const record=async(version,snapshot,baseline=false)=>db.query(`insert into trip_resource_revisions(company_id,trip_id,version,effective_at,baseline_observation,actor_user_id,actor_name,reason,snapshot)
  values($1,$2,$3,case when $4::boolean then null else clock_timestamp() end,$4,$5,$6,$7,$8)`,[next.company_id,next.id,version,baseline,req.user.id,req.user.name||'Usuario autenticado',baseline?'Estado observado antes del encadenamiento; fecha inicial desconocida':reason,snapshot]);
 const before={truck_id:next.truck_id||null,driver_id:next.driver_id||null,trailer_id:next.trailer_id||null,composition:next.composition_snapshot||null,client_id:next.client_id,route_id:next.route_id};
 if(next.resource_version===0)await record(0,before,true);
 const updated=(await db.query(`update trips set truck_id=$1,driver_id=$2,trailer_id=$3,composition_id=null,composition_snapshot=$4,
  resource_version=resource_version+1,status=case when status='Planificado' then 'Asignado' else status end,updated_at=now()
  where id=$5 and company_id=$6 returning *`,[outing.truck_id,outing.driver_id,outing.trailer_id,equipment,next.id,next.company_id])).rows[0];
 updated.itinerary_version=await require('./itinerary-api').reviewEquipmentChange(db,req,updated,review,reason);
 const after={truck_id:updated.truck_id,driver_id:updated.driver_id,trailer_id:updated.trailer_id,truck:equipment.truck,trailer:equipment.trailer,driver,composition:equipment,client_id:updated.client_id,route_id:updated.route_id};
 await record(updated.resource_version,after);
 if(updated.status!==next.status)await db.query('insert into trip_status_history(trip_id,from_status,to_status,notes,created_by) values($1,$2,$3,$4,$5)',[next.id,next.status,updated.status,reason,req.user.id]);
 await db.query('insert into trip_events(trip_id,event_type,notes,created_by,details) values($1,$2,$3,$4,$5)',[next.id,'Asignación para salida operacional',reason,req.user.id,{before,after,resource_version:updated.resource_version}]);
 await writeAudit(db,req,{companyId:next.company_id,action:'assign_resources',entity:'trip',entityId:next.id,beforeData:before,afterData:{...after,resource_version:updated.resource_version,reason}});
 await syncResourceAlert(db,updated);
 return updated;
}
function registerOperationalOutings(app,pool,{driverAccess,enforceDriverPersonnel,assertTripResourcesReady=defaultReadiness}={}){
 if(typeof driverAccess!=='function'||typeof enforceDriverPersonnel!=='function')throw new TypeError('Driver guards obligatorios');
 const handler=(mode,driver=false)=>async(req,res)=>{
  if(driver&&!driverAccess(req,res))return;
  const context=resolveActorContext(req),cid=context?.company_id;
  if(context?.scope!=='company'||!positive(cid))return res.status(403).json({error:'Contexto de empresa requerido'});
  if(!positive(req.params.id))return res.status(400).json({error:'Viaje no válido'});
  let db;
  try{
   db=await pool.connect();await db.query(mode==='get'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
   if(driver&&mode!=='get'&&!await enforceDriverPersonnel(db,req,res))return;
   if(mode!=='get'&&!(await db.query('select pg_try_advisory_xact_lock(738038,$1::integer) locked',[cid])).rows[0]?.locked)throw fail('La empresa está procesando otra operación; actualiza y reintenta');
   const trip=(await db.query(`select * from trips where id=$1 and company_id=$2${driver?' and driver_id=$3':''}${mode==='get'?'':' for update nowait'}`,[req.params.id,cid,...(driver?[req.user.driver_id]:[])])).rows[0];
   if(!trip)throw fail('Viaje no encontrado',404);
   if(mode==='get'){const result=await snapshot(db,trip,driver);await db.query('COMMIT');return res.json(result);}
   const b=req.body||{};
   if(mode!=='position'&&!reasonOf(b))throw fail('Registra un motivo para esta operación',400);
   if(!trip.truck_id||!trip.driver_id)throw fail('El viaje requiere camión y conductor');
   let modules=null;
   if(mode==='create'){
    // Serialize against seat/contract changes before taking personnel/vehicle locks.
    await db.query("select commercial_require($1,'operations',$2)",[cid,trip.truck_id]);
    if(trip.trailer_id)await db.query("select commercial_require($1,'operations',$2)",[cid,trip.trailer_id]);
    const company=(await db.query('select commercial_enforced from companies where id=$1',[cid])).rows[0];
    if(company?.commercial_enforced){
     modules=(await db.query("select configuration->'modules' modules from commercial_current($1)",[cid])).rows[0]?.modules;
     if(!Array.isArray(modules)||!modules.includes('operations'))throw fail('Contrato operacional vigente requerido',403,'MODULE_NOT_CONTRACTED');
    }
   }
   const observed=await findOuting(db,cid,trip.id);
   if(driver&&observed&&!same(observed.driver_id,req.user.driver_id))throw fail('Salida no encontrada',404);
   await lockResources(db,observed||trip);
   let outing=await findOuting(db,cid,trip.id,true);
   if(outing&&(!observed||outing.version!==observed.version))throw fail('La salida cambió durante la operación; actualiza y reintenta');
   if(mode==='create'){
    if(outing)throw fail('El servicio ya pertenece a una salida');
    if(terminal(trip.status))throw fail('No se crean salidas para servicios cerrados');
    if((await db.query("select id from maintenance where company_id=$1 and truck_id=any($2::integer[]) and status='En proceso' limit 1",[cid,[trip.truck_id,trip.trailer_id].filter(Boolean)])).rows.length)throw fail('Un equipo está ingresado a taller');
    if(!positive(b.base_location_id))throw fail('Selecciona una base explícita',400);
    if(!(await db.query('select id from operational_locations where company_id=$1 and id=$2 for share',[cid,b.base_location_id])).rows.length)throw fail('Base no encontrada',404);
    await assertTripAvailability(db,{companyId:cid,truckId:trip.truck_id,driverId:trip.driver_id,trailerId:trip.trailer_id,tripId:trip.id,status:trip.status,plannedDeparture:trip.planned_departure,plannedArrival:trip.planned_arrival});
    outing=(await db.query(`insert into operational_outings(company_id,truck_id,driver_id,trailer_id,base_location_id,commercial_modules,created_by)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,[cid,trip.truck_id,trip.driver_id,trip.trailer_id,b.base_location_id,modules==null?null:JSON.stringify(modules),req.user.id])).rows[0];
    await db.query('insert into operational_outing_services(company_id,outing_id,trip_id,sequence) values($1,$2,$3,1)',[cid,outing.id,trip.id]);
    await event(db,req,outing,'create',reasonOf(b),trip.id);
    await writeAudit(db,req,{companyId:cid,action:'create',entity:'operational_outing',entityId:outing.id,afterData:outing});
   }else{
    if(!outing)throw fail('No hay salida para este servicio',404);
    if(outing.closed_at)throw fail('La salida ya está cerrada');
    if(!Number.isInteger(b.version)||b.version!==outing.version)throw fail('La salida cambió; actualiza antes de continuar',409,'OUTING_STALE');
    if(mode==='position'){
     if(outing.status!=='returning')throw fail('El GPS de retorno requiere una salida en retorno');
     if(outing.commercial_modules!==null&&!outing.commercial_modules.includes('gps'))throw fail('El GPS no estaba contratado al iniciar la salida',403,'MODULE_NOT_CONTRACTED');
     const lat=b.lat,lng=b.lng,accuracy=b.accuracy_m??null,date=typeof b.recorded_at==='string'?new Date(b.recorded_at):null;
     if(typeof lat!=='number'||!Number.isFinite(lat)||lat< -90||lat>90||typeof lng!=='number'||!Number.isFinite(lng)||lng< -180||lng>180||accuracy!==null&&(typeof accuracy!=='number'||!Number.isFinite(accuracy)||accuracy<0)||!date||!Number.isFinite(date.getTime())||date.getTime()>Date.now()+60000||date.getTime()<Date.now()-86400000)throw fail('Posición o fecha no válida',400);
     await db.query('insert into operational_outing_positions(company_id,outing_id,lat,lng,accuracy_m,recorded_at,created_by) values($1,$2,$3,$4,$5,$6,$7)',[cid,outing.id,lat,lng,accuracy,date.toISOString(),req.user.id]);
     await db.query('insert into telemetry(truck_id,trip_id,outing_id,lat,lng,speed_kmh,km,recorded_at) values($1,null,$2,$3,$4,null,null,$5)',[outing.truck_id,outing.id,lat,lng,date.toISOString()]);
    }else{
     const action=b.action;
     if(!['wait','return','arrive_base','release','link'].includes(action))throw fail('Acción no válida',400);
     if(driver&&['release','link'].includes(action))throw fail('Acción exclusiva de operaciones',403);
     const last=(await db.query(`select t.* from operational_outing_services s join trips t on t.id=s.trip_id and t.company_id=s.company_id
      where s.company_id=$1 and s.outing_id=$2 order by s.sequence desc limit 1 for update of t nowait`,[cid,outing.id])).rows[0];
     if(!last||!terminal(last.status))throw fail('Finaliza o cancela el último servicio antes de continuar');
     let state={wait:'waiting',return:'returning',arrive_base:'arrived_base',release:'released',link:'in_service'}[action];
     if(action==='arrive_base'&&outing.status!=='returning')throw fail('Primero registra el retorno a base');
     if(action==='release'&&!reasonOf(b))throw fail('La liberación fuera de base requiere un motivo',400);
     if(action==='link'){
      if(last.status!=='Completado')throw fail('Un servicio cancelado no confirma la ubicación final; no se puede encadenar sin un traslado explícito');
      if(!positive(b.next_trip_id)||same(b.next_trip_id,trip.id))throw fail('Selecciona otro servicio existente',400);
      const next=(await db.query('select * from trips where id=$1 and company_id=$2 for update nowait',[b.next_trip_id,cid])).rows[0];
      if(!next)throw fail('Servicio no encontrado',404);
      if(!['Planificado','Asignado'].includes(next.status)||['truck_id','driver_id','trailer_id'].some(k=>next[k]!=null&&!same(next[k],outing[k])))throw fail('El siguiente servicio debe estar pendiente y tener recursos vacíos o compatibles');
      if(!last.destination_location_id||!next.origin_location_id||!same(last.destination_location_id,next.origin_location_id))throw fail('El origen del siguiente servicio debe coincidir con la ubicación final del anterior; registra un traslado explícito antes de encadenar',409,'OUTING_LOCATION_CONFLICT');
      if(await findOuting(db,cid,next.id))throw fail('El siguiente servicio ya tiene salida');
      await db.query(`insert into operational_outing_services(company_id,outing_id,trip_id,sequence)
       select $1,$2,$3,coalesce(max(sequence),0)+1 from operational_outing_services where company_id=$1 and outing_id=$2`,[cid,outing.id,next.id]);
      await linkedResources(db,req,next,outing,reasonOf(b),assertTripResourcesReady,b.itinerary_review);
     }
     const before=outing;
     outing=(await db.query(`update operational_outings set status=$1,version=version+1,
      closed_at=case when $1 in ('arrived_base','released') then now() else null end,
      release_reason=case when $1='released' then $2 else release_reason end where id=$3 and company_id=$4 returning *`,[state,reasonOf(b),outing.id,cid])).rows[0];
     await event(db,req,outing,action,reasonOf(b),action==='link'?Number(b.next_trip_id):last.id);
     await writeAudit(db,req,{companyId:cid,action,entity:'operational_outing',entityId:outing.id,beforeData:before,afterData:outing});
    }
   }
   const result=await snapshot(db,trip,driver);await db.query('COMMIT');return res.status(mode==='create'?201:200).json(result);
  }catch(error){
   if(db)try{await db.query('ROLLBACK');}catch{}
   if(error.code?.startsWith('P75'))return res.status(409).json({code:'COMMERCIAL_BLOCKED',error:error.message});
   const conflict=['23505','55P03','40P01'].includes(error.code);
   return res.status(conflict?409:error.status||500).json({code:conflict?'OUTING_CONFLICT':error.code||'OUTING_ERROR',error:conflict?'Los recursos o servicios cambiaron; actualiza y reintenta':error.status?error.message:'No se pudo procesar la salida operacional'});
  }finally{db?.release();}
 };
 const admin='/api/operations/trips/:id/outing',driver='/api/driver/trips/:id/outing';
 app.get(admin,requirePermission('trips.manage'),handler('get'));
 app.post(admin,requirePermission('trips.manage'),handler('create'));
 app.post(admin+'/action',requirePermission('trips.manage'),handler('action'));
 app.get(driver,handler('get',true));
 app.post(driver+'/action',handler('action',true));
 app.post(driver+'/positions',handler('position',true));
}
module.exports={registerOperationalOutings,findOuting};
