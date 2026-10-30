'use strict';
const {writeAudit}=require('./audit');
const {createHash}=require('node:crypto');
const fail=message=>Object.assign(new Error(message),{status:409,code:'ITINERARY_LOCATION_CONFLICT'});
const same=(a,b)=>String(a??'')===String(b??'');
const signature=loads=>loads.map(l=>[String(l.id),l.origin_location_id==null?null:String(l.origin_location_id),l.destination_location_id==null?null:String(l.destination_location_id),l.origin||null,l.destination||null]).sort((a,b)=>a[0].localeCompare(b[0]));
const token=loads=>createHash('sha256').update(JSON.stringify(signature(loads))).digest('hex');
function endpointChange(trip,plan){
 return ['origin','destination'].some((key,i)=>trip[key+'_location_id']!=null&&!same(trip[key+'_location_id'],(i?plan.stops.at(-1):plan.stops[0]).location_id));
}
function preserveHistory(previous,plan,events){
 if(!previous)return;
 const started=new Set(events.filter(e=>['arrive','depart'].includes(e.kind)).map(e=>e.stop_key));
 if(started.size&&new Date(previous.departure).getTime()!==new Date(plan.departure).getTime())throw fail('No se cambia la salida planificada de un recorrido ya iniciado; registra una demora.');
 for(const old of previous.stops.filter(s=>started.has(s.key))){
  const next=plan.stops.find(s=>s.key===old.key);
  if(!next||['service_minutes','wait_minutes','rest_minutes'].some(k=>Number(next[k])!==Number(old[k]))||Number(next.location?.lat)!==Number(old.location.lat)||Number(next.location?.lng)!==Number(old.location.lng))throw fail('Conserva los puntos y tiempos de las paradas ya iniciadas; modifica sólo las pendientes.');
 }
}
function loadChanges(plan,loads){
 return plan.loads.flatMap(mapping=>{
  const load=loads.find(l=>same(l.id,mapping.load_id));if(!load)throw fail('Una carga ya no pertenece al viaje');
  return [['origin',mapping.pickup],['destination',mapping.delivery]].flatMap(([field,key])=>{
   const stop=plan.stops.find(s=>s.key===key);if(!stop)throw fail('La carga no tiene una parada válida');
   if((load.status==='Entregada'||load.delivered_at)&&load[field+'_location_id']==null)return [];return same(load[field+'_location_id'],stop.location_id)?[]:[{load,field,stop}];
  });
 });
}
// Only called under the trip lock, after preserveProgress; all writes roll back
// together with the revision, its route snapshot and audit.
async function reconcileLoads(db,req,trip,plan,loads,events,acknowledged,reason){
 const changes=loadChanges(plan,loads);
 if(!changes.length)return;
 if(acknowledged!==true)throw fail('Las recogidas o entregas de las cargas no coinciden con las paradas. Revisa y confirma expresamente sus ubicaciones.');
 const ids=[...new Set(changes.map(c=>String(c.load.id)))];
 for(const id of ids){
  const before=loads.find(l=>same(l.id,id)),selected=changes.filter(c=>same(c.load.id,id));
  if(before.status==='Entregada'||before.delivered_at)throw fail('No se cambian ubicaciones de una carga entregada');
  if(selected.some(c=>c.field==='origin')&&events.some(e=>same(e.load_id,id)&&e.kind==='pickup'))throw fail('No se cambia el origen de una recogida ya ejecutada');
  const next={...before};
  for(const c of selected){next[c.field+'_location_id']=c.stop.location_id;next[c.field]=c.stop.location.name;}
  const after=(await db.query('update trip_loads set origin_location_id=$1,destination_location_id=$2,origin=$3,destination=$4 where id=$5 and trip_id=$6 returning *',[next.origin_location_id,next.destination_location_id,next.origin,next.destination,before.id,trip.id])).rows[0];
  if(!after)throw fail('La carga cambió durante la revisión de ubicaciones');
  await writeAudit(db,req,{companyId:trip.company_id,action:'update',entity:'trip_load',entityId:before.id,beforeData:before,afterData:{...after,location_review_reason:reason}});
  Object.assign(before,after);
 }
}
async function verify(db,trip,plan,loads,events=[]){
 if(loadChanges(plan,loads).length)throw fail('Las ubicaciones de las cargas cambiaron o no están confirmadas. Revisa el itinerario.');
 if(plan.location_signature&&JSON.stringify(signature(loads))!==JSON.stringify(plan.location_signature))throw fail('Cambió el origen o destino de una carga: revisa y guarda una nueva versión.');
 const current=(await db.query('select origin_location_id,destination_location_id,origin,destination from trips where id=$1 and company_id=$2',[trip.id,trip.company_id])).rows[0];
 if(current&&endpointChange(current,plan))throw fail('Los puntos del viaje no coinciden con el itinerario vigente.');if(current&&((current.origin&&current.origin!==plan.stops[0].location.name)||(current.destination&&current.destination!==plan.stops.at(-1).location.name)))throw fail('La cabecera del viaje cambió respecto de su itinerario vigente.');
 const pending=plan.stops.filter(s=>!events.some(e=>e.stop_key===s.key&&['arrive','depart'].includes(e.kind)));
 if(!pending.length)return;
 const locations=(await db.query('select id,name,address,lat,lng from operational_locations where company_id=$1 and id=any($2::bigint[]) order by id for share',[trip.company_id,[...new Set(pending.map(s=>s.location_id))]])).rows;
 for(const stop of pending){
  const point=locations.find(l=>same(l.id,stop.location_id));
  if(!point||point.lat==null||point.lng==null||Number(point.lat)!==Number(stop.location.lat)||Number(point.lng)!==Number(stop.location.lng))throw fail('Un acceso del mapa cambió o ya no está disponible. Recalcula el itinerario antes de operar.');
 }
}
async function report(db,trip,plan,loads,events){
 if(!plan)return {ready:false,issues:['Itinerario pendiente: confirma las paradas y calcula el recorrido antes de iniciar.']};
 try{await verify(db,trip,plan,loads,events);return {ready:true,issues:[]};}
 catch(e){if(e.code!=='ITINERARY_LOCATION_CONFLICT')throw e;return {ready:false,issues:[e.message]};}
}
async function snapshot(db,req,trip,plan){
 const row=(await db.query('insert into trip_route_snapshots(company_id,trip_id,origin_location_id,destination_location_id,distance_meters,duration_seconds,geometry,provider,route_calculated_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',[trip.company_id,trip.id,plan.stops[0].location_id,plan.stops.at(-1).location_id,plan.distance_meters,plan.driving_seconds,{type:'MultiLineString',coordinates:plan.legs.map(l=>l.geometry.coordinates)},[...new Set(plan.legs.map(l=>l.provider))].join(' + '),plan.legs.at(-1).calculated_at,req.user.id])).rows[0];
 await db.query('update trips set planned_route_snapshot_id=$1,road_route_id=null where id=$2 and company_id=$3',[row.id,trip.id,trip.company_id]);
}
module.exports={signature,token,endpointChange,preserveHistory,loadChanges,reconcileLoads,verify,report,snapshot};
