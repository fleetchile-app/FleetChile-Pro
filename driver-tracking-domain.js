'use strict';
const crypto=require('node:crypto');
const ACTIVE=['En carga','En tránsito','Detenido','Llegó a destino','Descargando'];
const terminal=s=>['Completado','Cancelado'].includes(s);
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const same=(a,b)=>String(a)===String(b);
function phase(session,trip,outing,latest){
 if(session.closed_at)return {state:'closed',review_required:session.review_required};
 if(!trip||!same(trip.company_id,session.company_id)||!same(trip.driver_id,session.driver_id)||!same(trip.truck_id,session.truck_id)||trip.resource_version!==session.resource_version||trip.itinerary_version!==session.itinerary_version)
  return {state:'closed',review_required:true,reason:'RESOURCE_CHANGED'};
 if(session.outing_id&&(!outing||!same(outing.driver_id,session.driver_id)||!same(outing.truck_id,session.truck_id)))return {state:'closed',review_required:true,reason:'OUTING_RESOURCE_CHANGED'};
 if(outing?.closed_at)return {state:'closed',review_required:false,reason:'OUTING_CLOSED'};
 if(latest&&!same(latest.id,trip.id))return {state:'closed',review_required:true,reason:'NEXT_SERVICE_REQUIRES_START'};
 if(ACTIVE.includes(trip.status))return {state:'active',review_required:false};
 if(terminal(trip.status)&&outing&&!outing.closed_at){
  if(outing.status==='returning')return {state:'returning',review_required:false};
  if(['waiting','in_service'].includes(outing.status))return {state:'waiting',review_required:false};
 }
 return {state:'closed',review_required:!terminal(trip.status),reason:'TRIP_NOT_TRACKABLE'};
}
function positions(body,session,now=Date.now()){
 if(!Array.isArray(body.positions)||body.positions.length<1||body.positions.length>50)throw fail(400,'INVALID_BATCH','Envía entre 1 y 50 posiciones');
 if(body.resource_version!==session.resource_version)throw fail(409,'RESOURCE_CHANGED','La versión de recursos no corresponde a la sesión');
 return body.positions.map(p=>{
  if(!p||!uuid(p.client_position_id)||typeof p.captured_at!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(p.captured_at))throw fail(400,'INVALID_POSITION','Identificador o fecha GPS no válida');
  const time=Date.parse(p.captured_at),number=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  if(!Number.isFinite(time)||time>now||time<now-86400000||time<new Date(session.created_at).getTime()||time>=new Date(session.expires_at).getTime())throw fail(400,'INVALID_CAPTURE_TIME','La posición está fuera de la sesión o de las 24 horas permitidas');
  if(!number(p.lat,-90,90)||!number(p.lng,-180,180)||!number(p.accuracy_m,0,Number.MAX_VALUE)||(p.speed_kmh!==undefined&&!number(p.speed_kmh,0,Number.MAX_VALUE)))throw fail(400,'INVALID_POSITION','Coordenadas, precisión o velocidad no válidas');
  if(!['active','waiting','returning'].includes(p.state))throw fail(400,'INVALID_PHASE','Cada posición debe conservar su fase de captura');
  const row={client_position_id:p.client_position_id.toLowerCase(),captured_at:new Date(time).toISOString(),state:p.state,lat:p.lat,lng:p.lng,accuracy_m:p.accuracy_m,speed_kmh:p.speed_kmh??null};
  return {...row,payload_hash:hash(JSON.stringify(row))};
 });
}
module.exports={ACTIVE,terminal,fail,uuid,hash,same,phase,positions};
