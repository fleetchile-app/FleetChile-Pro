'use strict';
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {assertTripResourcesReady}=require('./trip-eligibility');
const {terminal,inExecution}=require('./trip-resources');
const E=require('./equipment-domain'),D=require('./itinerary-domain');
const C=require('./itinerary-coherence');
const BASE='/api/operations/trips/:id/itinerary';
function company(req){const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id)throw D.fail('Selecciona una empresa',403);return a.company_id;}
async function currentPlan(db,trip){return (await db.query('select * from trip_itinerary_revisions where company_id=$1 and trip_id=$2 and version=$3',[trip.company_id,trip.id,trip.itinerary_version])).rows[0]||null;}
async function loadState(db,trip){const [loads,events]=await Promise.all([db.query('select * from trip_loads where trip_id=$1 order by id',[trip.id]),db.query('select * from trip_itinerary_events where company_id=$1 and trip_id=$2 order by id',[trip.company_id,trip.id])]);return {loads:loads.rows,events:events.rows};}
async function vehicleState(db,trip){
 const rows=(await db.query('select id,tipo,capacidad_t from trucks where company_id=$1 and id=any($2::integer[]) order by id',[trip.company_id,[trip.truck_id,trip.trailer_id].filter(Boolean)])).rows;
 const truck=rows.find(r=>String(r.id)===String(trip.truck_id)),trailer=rows.find(r=>String(r.id)===String(trip.trailer_id));
 return {truck_id:trip.truck_id||null,trailer_id:trip.trailer_id||null,capacity_t:E.capacity(truck,trailer)};
}
function assertLoads(plan,loads){if(JSON.stringify(D.signature(loads))!==JSON.stringify(plan.load_signature))throw D.fail('Las cargas cambiaron: revisa y guarda nuevamente el itinerario',409,'ITINERARY_STALE');}
function historicCapacities(previous,stops,events){
 return stops.slice(0,-1).map((s,i)=>{
  if(!events.some(e=>e.kind==='arrive'&&e.stop_key===stops[i+1].key))return undefined;
  return previous?.capacity?.segments.find(c=>c.from===s.key&&c.to===stops[i+1].key)?.capacity_kg;
 });
}
async function checkItinerary(db,trip,{truckId=trip.truck_id,trailerId=trip.trailer_id,review=true}={}){
 if(!trip.itinerary_version)return;
 const revision=await currentPlan(db,trip);if(!revision)throw D.fail('No se encontró la versión del itinerario',409);
 const {loads,events}=await loadState(db,trip);assertLoads(revision.plan,loads);await C.verify(db,trip,revision.plan,loads,events);
 const vehicle=await vehicleState(db,{...trip,truck_id:truckId,trailer_id:trailerId}),cap=D.capacityPlan(revision.plan.stops,revision.plan.loads,loads,vehicle.capacity_t,events,historicCapacities(revision.plan,revision.plan.stops,events));
 if(cap.overloaded)throw D.fail('La carga supera la capacidad del conjunto en uno o más tramos',409,'ITINERARY_OVERLOAD');
 if(!cap.verified)throw D.fail('Completa los pesos y la capacidad para verificar cada tramo antes de operar',409,'ITINERARY_CAPACITY_UNKNOWN');
 if(review&&(String(vehicle.truck_id)!==String(revision.plan.vehicle.truck_id)||String(vehicle.trailer_id)!==String(revision.plan.vehicle.trailer_id)))throw D.fail('Cambió el equipo: revisa las restricciones y guarda el itinerario',409,'ITINERARY_REVIEW_REQUIRED');
}
async function checkCompletion(db,trip){
 if(!trip.itinerary_version){if(trip.origin_location_id||trip.destination_location_id)throw D.fail('El viaje georreferenciado no tiene itinerario confirmado. Revisa el recorrido antes de completar.',409,'ITINERARY_LOCATION_CONFLICT');return;}
 const revision=await currentPlan(db,trip),state=await loadState(db,trip);
 if(!revision)throw D.fail('No se encontró el itinerario',409);
 assertLoads(revision.plan,state.loads);
 await C.verify(db,trip,revision.plan,state.loads,state.events);
 if(D.progress(revision.plan,state.events).some(s=>!s.actual_departure))throw D.fail('Hay paradas pendientes: finalízalas antes de completar el viaje',409,'ITINERARY_PENDING');
 if(state.loads.some(l=>l.status!=='Entregada'&&!l.delivered_at))throw D.fail('Hay cargas pendientes: entrega o transfiere las cargas antes de completar el viaje',409,'ITINERARY_PENDING');
}
async function appendPlan(db,req,trip,plan,reason){
 const version=trip.itinerary_version+1;
 const row=(await db.query('insert into trip_itinerary_revisions(company_id,trip_id,version,resource_version,plan,reason,actor_user_id,actor_name) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[trip.company_id,trip.id,version,trip.resource_version,plan,reason,req.user.id,req.user.name||'Usuario autenticado'])).rows[0];
 await db.query('update trips set itinerary_version=$1 where id=$2 and company_id=$3',[version,trip.id,trip.company_id]);
 await writeAudit(db,req,{companyId:trip.company_id,action:'update',entity:'trip_itinerary',entityId:trip.id,afterData:row});return version;
}
async function reviewEquipmentChange(db,req,trip,review,reason){
 if(!trip.itinerary_version)return trip.itinerary_version;
 const revision=await currentPlan(db,trip),state=await loadState(db,trip),vehicle=await vehicleState(db,trip);
 assertLoads(revision.plan,state.loads);
 const capacity=D.capacityPlan(revision.plan.stops,revision.plan.loads,state.loads,vehicle.capacity_t,state.events,historicCapacities(revision.plan,revision.plan.stops,state.events));
 if(capacity.overloaded)throw D.fail('El nuevo conjunto está sobrecargado en un tramo',409,'ITINERARY_OVERLOAD');
 if(inExecution(trip)&&!capacity.verified)throw D.fail('Verifica pesos y capacidad antes de reemplazar el equipo de un viaje en ejecución',409,'ITINERARY_CAPACITY_UNKNOWN');
 if(JSON.stringify(vehicle)===JSON.stringify(revision.plan.vehicle))return trip.itinerary_version;
 if(review?.acknowledged!==true)throw D.fail('El cambio de equipo requiere revisar nuevamente las restricciones de la ruta',409,'ITINERARY_REVIEW_REQUIRED');
 const notes=E.text(review.notes,'Revisión de restricciones del nuevo equipo',2000);
 return appendPlan(db,req,trip,{...revision.plan,vehicle,capacity,vehicle_review:{acknowledged:true,notes,reviewed_by:req.user.id,reviewed_at:new Date().toISOString()}},reason||'Revisión por reemplazo de equipo');
}
async function transferredLoad(db,req,trip,loadId,reason){
 if(!trip.itinerary_version)return;
 const previous=await currentPlan(db,trip),state=await loadState(db,trip),plan={...previous.plan,loads:previous.plan.loads.filter(l=>String(l.load_id)!==String(loadId)),load_signature:D.signature(state.loads),location_signature:C.signature(state.loads)};
 plan.capacity=D.capacityPlan(plan.stops,plan.loads,state.loads,plan.vehicle.capacity_t,state.events,historicCapacities(previous.plan,plan.stops,state.events));
 await appendPlan(db,req,trip,plan,'Transferencia de carga #'+loadId+': '+reason);
}
async function recordItineraryEvent(db,req,locked,b,{pickups=false}={}){
 const kind=b.kind,eventKey=D.key(b.event_key),version=E.id(b.version,'Versión');
 if(!['arrive','depart','pickup','failed','partial','reschedule','delay'].includes(kind))throw D.fail('Evento no válido');
 const duplicate=(await db.query('select * from trip_itinerary_events where company_id=$1 and trip_id=$2 and event_key=$3',[locked.company_id,locked.id,eventKey])).rows[0];
 if(duplicate){
  if(duplicate.kind!==kind||String(duplicate.stop_key||'')!==String(b.stop_key||'')||String(duplicate.load_id||'')!==String(b.load_id||'')||Number(duplicate.itinerary_version)!==version||String(duplicate.reason||'')!==String(b.reason||'').trim()||Number(duplicate.minutes||0)!==Number(b.minutes||0)||Number(duplicate.delivered_kg||0)!==Number(b.delivered_kg||0))throw D.fail('El identificador de reintento corresponde a otra acción',409);
  return {row:duplicate,created:false};
 }
 if(terminal(locked.status)||locked.itinerary_version!==version)throw D.fail('El viaje cambió o está cerrado; recarga el itinerario',409,'ITINERARY_STALE');
 const revision=await currentPlan(db,locked),state=await loadState(db,locked);
 if(!revision)throw D.fail('No se encontró el itinerario',409);
 const plan=revision.plan;assertLoads(plan,state.loads);
 if(kind!=='delay')await C.verify(db,locked,plan,state.loads,state.events);
 const stop=b.stop_key?plan.stops.find(s=>s.key===D.key(b.stop_key)):null,loadId=b.load_id?E.id(b.load_id,'Carga'):null;
 if(loadId&&!['pickup','failed','partial','reschedule'].includes(kind))throw D.fail('Esta acción no admite una carga');
 if(b.stop_key&&!stop)throw D.fail('La parada no pertenece al itinerario');
 if(kind!=='delay'&&!stop)throw D.fail('Selecciona una parada del itinerario');
 const next=D.progress(plan,state.events).find(s=>!s.actual_departure);
 if(['arrive','depart','pickup','failed','partial'].includes(kind)&&(!next||next.key!==stop.key))throw D.fail('Registra las paradas en su orden de ejecución',409);
 if(kind==='arrive'&&next.actual_arrival||['depart','pickup','failed','partial'].includes(kind)&&!next.actual_arrival)throw D.fail('Primero registra la llegada; no repitas una llegada ya registrada',409);
 if(kind==='depart'){
  if(plan.loads.some(m=>m.delivery===stop.key&&state.loads.some(l=>Number(l.id)===m.load_id&&l.status!=='Entregada'&&!l.delivered_at)))throw D.fail('Hay entregas pendientes, fallidas o parciales: entrega el saldo o reprograma su destino antes de salir',409);
  if(pickups&&plan.loads.some(m=>m.pickup===stop.key&&!state.events.some(e=>e.kind==='pickup'&&String(e.load_id)===String(m.load_id))))throw D.fail('Confirma las recogidas de esta parada antes de salir',409);
 }
 let delivered=null,delay=null,reason=null;
 if(['failed','partial','reschedule','delay'].includes(kind))reason=E.text(b.reason,'Motivo',2000);
 if(kind==='delay'){delay=D.minutes(b.minutes,'Demora');if(!delay)throw D.fail('La demora debe ser mayor que cero');}
 if(['pickup','failed','partial','reschedule'].includes(kind)){
  const l=state.loads.find(l=>Number(l.id)===loadId),mapped=plan.loads.find(l=>l.load_id===loadId);
  if(!l||!mapped||(kind==='pickup'?mapped.pickup:mapped.delivery)!==stop.key)throw D.fail('La carga no corresponde a esta parada',409);
  if(l.status==='Entregada'||l.delivered_at)throw D.fail('La carga ya tiene entrega registrada',409);
  if(kind==='pickup'&&state.events.some(e=>e.kind==='pickup'&&String(e.load_id)===String(loadId)))throw D.fail('La recogida ya fue confirmada',409);
  if(kind==='partial'){
   delivered=Number(b.delivered_kg);const previous=state.events.filter(e=>String(e.load_id)===String(loadId)&&e.kind==='partial').reduce((n,e)=>n+Number(e.delivered_kg),0);
   if(!Number.isFinite(delivered)||delivered<=0||!l.weight_kg||previous+delivered>=Number(l.weight_kg))throw D.fail('Indica un peso parcial positivo menor al saldo pendiente');
  }
 }
 const reported=b.reported_at?new Date(b.reported_at):null;
 if(reported&&(!Number.isFinite(reported.getTime())||reported.getTime()>Date.now()+300000))throw D.fail('Fecha informada no válida');
 const row=(await db.query('insert into trip_itinerary_events(company_id,trip_id,itinerary_version,event_key,stop_key,load_id,kind,minutes,delivered_kg,reason,actor_user_id,actor_name,reported_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[locked.company_id,locked.id,version,eventKey,stop?.key||null,loadId,kind,delay,delivered,reason,req.user.id,req.user.name||'Usuario autenticado',reported])).rows[0];
 await db.query('insert into trip_events(trip_id,event_type,notes,created_by,details) values($1,$2,$3,$4,$5)',[locked.id,'Itinerario: '+kind,reason||'Registro de '+kind,req.user.id,{stop_key:stop?.key||null,load_id:loadId,itinerary_event_id:row.id}]);
 await writeAudit(db,req,{companyId:locked.company_id,action:'create',entity:'trip_itinerary_event',entityId:row.id,afterData:row});
 return {row,created:true};
}
function registerItineraryRoutes(app,pool,router){
 const route=(method,path,permission,work)=>app[method](path,requirePermission(permission),async(req,res)=>{try{const cid=company(req),trip=(await pool.query('select * from trips where id=$1 and company_id=$2',[E.id(req.params.id,'Viaje'),cid])).rows[0];if(!trip)return res.sendStatus(404);await work(req,res,trip);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'No se pudo procesar el itinerario',code:e.code||'ITINERARY_ERROR'});}});
 require('./saved-routes-api').registerSavedRoutes(pool,route);
 route('get',BASE+'/options','trips.manage',async(req,res,trip)=>{
  const [locations,loads]=await Promise.all([pool.query('select id,name,address,commune,region,lat,lng from operational_locations where company_id=$1 order by name,id',[trip.company_id]),pool.query('select l.*,c.name client_name from trip_loads l join clients c on c.id=l.client_id and c.company_id=$2 where l.trip_id=$1 order by l.id',[trip.id,trip.company_id])]);
  res.json({locations:locations.rows,loads:loads.rows,load_locations_token:C.token(loads.rows),trip:{origin:trip.origin,destination:trip.destination,origin_location_id:trip.origin_location_id,destination_location_id:trip.destination_location_id,planned_departure:trip.planned_departure},vehicle:await vehicleState(pool,trip)});
 });
 route('get',BASE,'trips.manage',async(req,res,trip)=>{
  const revision=await currentPlan(pool,trip),state=await loadState(pool,trip);let gps=null;
  if(trip.truck_id)gps=(await pool.query('select lat,lng,recorded_at from telemetry where truck_id=$1 and trip_id=$2 order by recorded_at desc,id desc limit 1',[trip.truck_id,trip.id])).rows[0]||null;
  const plan=revision?.plan||null,vehicle=await vehicleState(pool,trip),capacity=plan?D.capacityPlan(plan.stops,plan.loads.filter(l=>state.loads.some(r=>String(r.id)===String(l.load_id))),state.loads,vehicle.capacity_t,state.events,historicCapacities(plan,plan.stops,state.events)):null;
  res.json({version:trip.itinerary_version,resource_version:trip.resource_version,trip_status:trip.status,coherence:await C.report(pool,trip,plan,state.loads,state.events),revision,events:state.events,progress:plan?D.progress(plan,state.events):[],capacity,vehicle,loads:D.outcomes(state.loads,state.events),
   stale_loads:plan?JSON.stringify(D.signature(state.loads))!==JSON.stringify(plan.load_signature):false,
   review_required:plan?String(plan.vehicle.truck_id)!==String(vehicle.truck_id)||String(plan.vehicle.trailer_id)!==String(vehicle.trailer_id):false,
   eta:plan?D.eta(plan,state.events,gps):null});
 });
 route('get',BASE+'/history','trips.manage',async(req,res,trip)=>{
  const page=E.id(req.query.page||1,'Página'),rows=(await pool.query('select * from trip_itinerary_revisions where company_id=$1 and trip_id=$2 order by version desc limit 10 offset $3',[trip.company_id,trip.id,(page-1)*10])).rows;
  res.json({rows,page,page_size:10,total:(await pool.query('select count(*)::int total from trip_itinerary_revisions where company_id=$1 and trip_id=$2',[trip.company_id,trip.id])).rows[0].total});
 });
 route('put',BASE,'trips.manage',async(req,res,trip)=>{
  const b=req.body||{},version=E.id(b.version,'Versión',{zero:true}),resourceVersion=E.id(b.resource_version,'Versión de recursos',{zero:true}),p=D.normalize(b),reason=E.text(b.reason,'Motivo',2000);
  if(terminal(trip.status))throw D.fail('No se modifica el itinerario de un viaje cerrado',409);
  if(version!==trip.itinerary_version||resourceVersion!==trip.resource_version)throw D.fail('El viaje cambió; recarga antes de guardar',409,'ITINERARY_STALE');
  const baseline=version?await currentPlan(pool,trip):null,priorEvents=version?(await loadState(pool,trip)).events:[];
  const locationIds=[...new Set(p.stops.map(s=>s.location_id))],locations=(await pool.query('select * from operational_locations where company_id=$1 and id=any($2::bigint[])',[trip.company_id,locationIds])).rows;
  if(locations.length!==locationIds.length)throw D.fail('Selecciona ubicaciones de esta empresa',403);
  p.stops=p.stops.map(s=>{const l=locations.find(l=>Number(l.id)===s.location_id);if(l.lat==null||l.lng==null||!Number.isFinite(Number(l.lat))||!Number.isFinite(Number(l.lng))||Math.abs(l.lat)>90||Math.abs(l.lng)>180)throw D.fail('Una ubicación no tiene coordenadas válidas',422);return {...s,location:{name:l.name,address:l.address,commune:l.commune,region:l.region,lat:Number(l.lat),lng:Number(l.lng)}};});
  p.stops=p.stops.map(s=>{const frozen=baseline?.plan.stops.find(old=>old.key===s.key&&old.location_id===s.location_id&&priorEvents.some(e=>e.stop_key===s.key&&['arrive','depart'].includes(e.kind)));return frozen?{...s,location:{...frozen.location}}:s;});
  D.preserveProgress(baseline?.plan,p,priorEvents);C.preserveHistory(baseline?.plan,p,priorEvents);
  if(C.endpointChange(trip,p)&&b.endpoint_change_ack!==true)throw D.fail('Cambiarás el origen o destino confirmado del viaje. Revisa y confirma expresamente el cambio.',409,'ITINERARY_LOCATION_CONFLICT');
  let legs;try{legs=await Promise.all(p.stops.slice(1).map((s,i)=>baseline?.plan.stops[i]?.key===p.stops[i].key&&baseline?.plan.stops[i+1]?.key===s.key&&priorEvents.some(e=>e.stop_key===s.key&&e.kind==='arrive')?baseline.plan.legs[i]:router.route(p.stops[i].location,s.location)));}catch{throw D.fail('No se pudo calcular la ruta vial. No se guardaron distancias ni tiempos inventados.',502,'ITINERARY_ROUTING_UNAVAILABLE');}
  if(!legs.every(D.routeValid))throw D.fail('No hay una ruta válida para todos los tramos',502,'ITINERARY_ROUTING_UNAVAILABLE');
  const db=await pool.connect();try{
   await db.query('BEGIN');
   // Same personnel -> trip -> vehicle lock order used by resource assignments.
   if(trip.driver_id)await require('./driver-readiness').assertDriverOperationalReady(db,{companyId:trip.company_id,driverId:trip.driver_id,lock:true});
   const locked=(await db.query('select * from trips where company_id=$1 and id=$2 for update',[trip.company_id,trip.id])).rows[0];
   if(!locked||terminal(locked.status)||locked.itinerary_version!==version||locked.resource_version!==resourceVersion||['truck_id','trailer_id','driver_id','status','origin_location_id','destination_location_id'].some(k=>String(locked[k])!==String(trip[k])))throw D.fail('El viaje cambió durante el cálculo. Recarga antes de guardar.',409,'ITINERARY_STALE');
   const reread=(await db.query('select id,lat,lng,name,address from operational_locations where company_id=$1 and id=any($2::bigint[]) order by id for share',[trip.company_id,locationIds])).rows;
   if(reread.length!==locations.length||reread.some(l=>{const old=locations.find(o=>String(o.id)===String(l.id));return !old||String(old.lat)!==String(l.lat)||String(old.lng)!==String(l.lng)||old.name!==l.name||old.address!==l.address;}))throw D.fail('Las ubicaciones cambiaron durante el cálculo',409);
   const state=await loadState(db,locked),old=await currentPlan(db,locked);
   if(p.loads.length!==state.loads.length||p.loads.some(l=>!state.loads.some(row=>Number(row.id)===l.load_id)))throw D.fail('Asocia todas las cargas de este viaje a sus recogidas y entregas',409);
   D.preserveProgress(old?.plan,p,state.events);
   C.preserveHistory(old?.plan,p,state.events);
   if((b.load_locations_token!==undefined&&b.load_locations_token!==C.token(state.loads))||(b.load_locations_ack===true&&C.loadChanges(p,state.loads).length&&!b.load_locations_token))throw D.fail('Las ubicaciones de las cargas cambiaron o falta la revisión vigente. Recarga el planificador antes de confirmar.',409,'ITINERARY_STALE');
   await C.reconcileLoads(db,req,locked,p,state.loads,state.events,b.load_locations_ack,reason);
   for(const load of state.loads.filter(l=>l.status==='Entregada'||l.delivered_at)){
    const before=old?.plan.loads.find(l=>String(l.load_id)===String(load.id)),after=p.loads.find(l=>String(l.load_id)===String(load.id));
    if(!before||JSON.stringify(before)!==JSON.stringify(after))throw D.fail('No se reprograma una carga entregada; conserva su recogida y entrega originales',409);
   }
   const vehicle=await vehicleState(db,locked),capacity=D.capacityPlan(p.stops,p.loads,state.loads,vehicle.capacity_t,state.events,historicCapacities(old?.plan,p.stops,state.events));
   if(capacity.overloaded)throw D.fail('La carga supera la capacidad del conjunto en un tramo',409,'ITINERARY_OVERLOAD');
   const plan=D.schedule({...p,vehicle,load_signature:D.signature(state.loads),location_signature:C.signature(state.loads),capacity,vehicle_review:{...p.vehicle_review,reviewed_by:req.user.id,reviewed_at:new Date().toISOString()}},legs);
   plan.impact={previous_version:version,arrival_delta_seconds:old?(Date.parse(plan.arrival)-Date.parse(old.plan.arrival))/1000:null,remaining_deliveries:plan.loads.filter(m=>state.loads.some(l=>Number(l.id)===m.load_id&&l.status!=='Entregada'&&!l.delivered_at)).map(m=>{
    const previous=old?.plan.loads.find(l=>l.load_id===m.load_id),before=old?.plan.stops.find(s=>s.key===previous?.delivery),after=plan.stops.find(s=>s.key===m.delivery);
    return {load_id:m.load_id,previous_stop:previous?.delivery||null,next_stop:m.delivery,previous_arrival:before?.planned_arrival||null,planned_arrival:after.planned_arrival,delta_seconds:before?(Date.parse(after.planned_arrival)-Date.parse(before.planned_arrival))/1000:null};
   })};
   await assertTripResourcesReady(db,{companyId:locked.company_id,truckId:locked.truck_id,trailerId:locked.trailer_id,driverId:locked.driver_id,tripId:locked.id,status:locked.status,plannedDeparture:plan.departure,plannedArrival:plan.arrival,compositionSnapshot:locked.composition_snapshot});
   if(JSON.stringify(vehicle)!==JSON.stringify(await vehicleState(db,locked)))throw D.fail('La capacidad del vehículo cambió durante el cálculo; recarga el itinerario',409);
   const next=(await db.query('insert into trip_itinerary_revisions(company_id,trip_id,version,resource_version,plan,reason,actor_user_id,actor_name) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[trip.company_id,trip.id,version+1,resourceVersion,plan,reason,req.user.id,req.user.name||'Usuario autenticado'])).rows[0];
   await db.query('update trips set itinerary_version=$1,planned_departure=$2,planned_arrival=$3,distance_km=$4,origin=$7,destination=$8,origin_location_id=$9,destination_location_id=$10,updated_at=now() where id=$5 and company_id=$6',[version+1,plan.departure,plan.arrival,plan.distance_meters/1000,trip.id,trip.company_id,plan.stops[0].location.name,plan.stops.at(-1).location.name,plan.stops[0].location_id,plan.stops.at(-1).location_id]);
   await C.snapshot(db,req,trip,plan);
   await db.query('insert into trip_events(trip_id,event_type,notes,created_by,details) values($1,$2,$3,$4,$5)',[trip.id,'Itinerario',reason,req.user.id,{version:version+1,previous_version:version,arrival:plan.arrival}]);
   await writeAudit(db,req,{companyId:trip.company_id,action:'update',entity:'trip_itinerary',entityId:trip.id,beforeData:old,afterData:next});
   await db.query('COMMIT');res.json(next);
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
 route('post',BASE+'/events','trips.manage',async(req,res,trip)=>{
  const db=await pool.connect();try{
   await db.query('BEGIN');const locked=(await db.query('select * from trips where company_id=$1 and id=$2 for update',[trip.company_id,trip.id])).rows[0];
   if(!locked)throw D.fail('Viaje no disponible',404);
   const result=await recordItineraryEvent(db,req,locked,req.body||{});
   await db.query('COMMIT');res.status(result.created?201:200).json(result.row);
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
}
module.exports={registerItineraryRoutes,currentPlan,loadState,recordItineraryEvent,checkItinerary,checkCompletion,vehicleState,reviewEquipmentChange,transferredLoad};
