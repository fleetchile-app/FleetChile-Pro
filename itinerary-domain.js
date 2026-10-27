'use strict';
const E=require('./equipment-domain');
const kinds=['pickup','delivery','mixed','rest','toll','weigh','other'];
const fail=(m,status=400,code='ITINERARY_INVALID')=>E.fail(m,status,code);
const key=v=>{if(typeof v!=='string'||!/^[-a-zA-Z0-9_]{1,48}$/.test(v))throw fail('Identificador de parada no válido');return v;};
function minutes(v,label){const n=Number(v??0);if(!Number.isInteger(n)||n<0||n>10080)throw fail(label+' debe contener minutos entre 0 y 10080');return n;}
function normalize(b){
 if(!Array.isArray(b.stops)||b.stops.length<2||b.stops.length>12)throw fail('Define entre 2 y 12 paradas ordenadas');
 const seen=new Set(),stops=b.stops.map(s=>{
  if(!s||typeof s!=='object'||Array.isArray(s))throw fail('Cada parada debe ser un registro válido');
  const k=key(s.key);if(seen.has(k))throw fail('Las paradas deben tener identificadores distintos');seen.add(k);
  if(!kinds.includes(s.purpose))throw fail('Propósito de parada no válido');
  return {key:k,location_id:E.id(s.location_id,'Ubicación'),purpose:s.purpose,service_minutes:minutes(s.service_minutes,'Atención'),wait_minutes:minutes(s.wait_minutes,'Espera'),rest_minutes:minutes(s.rest_minutes,'Descanso')};
 });
 if(!Array.isArray(b.loads))throw fail('Indica las recogidas y entregas de las cargas');
 const ids=new Set(),loads=b.loads.map(l=>{
  if(!l||typeof l!=='object'||Array.isArray(l))throw fail('Cada carga debe ser un registro válido');
  const id=E.id(l.load_id,'Carga');if(ids.has(id))throw fail('Una carga sólo puede aparecer una vez');ids.add(id);
  const pickup=key(l.pickup),delivery=key(l.delivery),from=stops.findIndex(s=>s.key===pickup),to=stops.findIndex(s=>s.key===delivery);
  if(from<0||to<=from)throw fail('Cada entrega debe estar después de su recogida');
  if(!['pickup','mixed'].includes(stops[from].purpose)||!['delivery','mixed'].includes(stops[to].purpose))throw fail('El propósito debe permitir recoger o entregar la carga');
  return {load_id:id,pickup,delivery};
 });
 const review=b.vehicle_review;if(!review||review.acknowledged!==true)throw fail('Confirma la revisión operacional de restricciones del vehículo');
 return {stops,loads,departure:E.instant(b.departure,'Salida'),contingency_minutes:minutes(b.contingency_minutes,'Contingencia'),vehicle_review:{acknowledged:true,notes:E.text(review.notes,'Revisión de peso, altura, dimensiones y accesos',2000)}};
}
function signature(loads){return loads.map(l=>[String(l.id),String(l.client_id),l.weight_kg==null?null:String(l.weight_kg)]).sort((a,b)=>a[0].localeCompare(b[0]));}
function capacityPlan(stops,mapping,loads,capacityT,events=[],historicCapacities=[]){
 const byId=new Map(loads.map(l=>[String(l.id),l])),knownCap=capacityT!=null&&Number.isFinite(Number(capacityT)),capacity=knownCap?Number(capacityT)*1000:null;
 const segments=[];let onboard=0,unknown=0;
 for(let i=0;i<stops.length;i++){
  const s=stops[i];
  for(const e of events.filter(e=>e.kind==='partial'&&e.stop_key===s.key&&mapping.some(l=>String(l.load_id)===String(e.load_id))))onboard-=Number(e.delivered_kg||0);
  for(const l of mapping.filter(l=>l.delivery===s.key)){const row=byId.get(String(l.load_id));if(!row)throw fail('Una carga ya no pertenece al viaje',409);const w=row.weight_kg==null||Number(row.weight_kg)<=0?null:Number(row.weight_kg);
   const unresolved=row.status!=='Entregada'&&!row.delivered_at&&events.some(e=>String(e.load_id)===String(l.load_id)&&e.stop_key===s.key&&['failed','partial'].includes(e.kind));
   if(unresolved)continue;
   const partial=events.filter(e=>String(e.load_id)===String(l.load_id)&&e.kind==='partial'&&stops.findIndex(s=>s.key===e.stop_key)<=i).reduce((n,e)=>n+Number(e.delivered_kg||0),0);
   if(w==null)unknown--;else onboard-=Math.max(0,w-partial);
  }
  for(const l of mapping.filter(l=>l.pickup===s.key)){const row=byId.get(String(l.load_id));if(!row)throw fail('Una carga ya no pertenece al viaje',409);const w=row.weight_kg==null||Number(row.weight_kg)<=0?null:Number(row.weight_kg);if(w==null)unknown++;else onboard+=w;}
  if(i<stops.length-1){const limit=historicCapacities[i]===undefined?capacity:historicCapacities[i];segments.push({from:s.key,to:stops[i+1].key,weight_kg:onboard,unknown_weights:unknown,capacity_kg:limit,overloaded:limit!=null&&onboard>limit});}
 }
 return {segments,verified:segments.every(s=>!s.unknown_weights&&(s.capacity_kg!=null||s.weight_kg===0)),overloaded:segments.some(s=>s.overloaded)};
}
function routeValid(r){return r&&Number.isFinite(r.distance_meters)&&r.distance_meters>=0&&Number.isFinite(r.duration_seconds)&&r.duration_seconds>=0&&typeof r.provider==='string'&&r.provider.trim()&&typeof r.calculated_at==='string'&&!Number.isNaN(Date.parse(r.calculated_at))&&r.geometry?.type==='LineString'&&Array.isArray(r.geometry.coordinates)&&r.geometry.coordinates.length>=2&&r.geometry.coordinates.every(c=>Array.isArray(c)&&c.length>=2&&Number.isFinite(c[0])&&Math.abs(c[0])<=180&&Number.isFinite(c[1])&&Math.abs(c[1])<=90);}
function schedule(p,legs){
 let time=Date.parse(p.departure),distance=0,driving=0,additional=0;
 const stops=p.stops.map((s,i)=>{const leg=i?legs[i-1]:null;if(leg){distance+=leg.distance_meters;driving+=leg.duration_seconds;time+=leg.duration_seconds*1000;}
  const arrival=new Date(time).toISOString(),minutes=s.service_minutes+s.wait_minutes+s.rest_minutes;additional+=minutes*60;time+=minutes*60000;
  return {...s,planned_arrival:arrival,planned_departure:new Date(time).toISOString()};
 });
 return {...p,stops,legs,distance_meters:distance,driving_seconds:driving,stop_seconds:additional,total_seconds:driving+additional+p.contingency_minutes*60,arrival:new Date(time+p.contingency_minutes*60000).toISOString()};
}
function progress(plan,events){return plan.stops.map(s=>({...s,actual_arrival:events.find(e=>e.stop_key===s.key&&e.kind==='arrive')?.occurred_at||null,actual_departure:events.find(e=>e.stop_key===s.key&&e.kind==='depart')?.occurred_at||null}));}
function outcomes(loads,events){return loads.map(l=>{
 const partial=events.filter(e=>String(e.load_id)===String(l.id)&&e.kind==='partial').reduce((n,e)=>n+Number(e.delivered_kg||0),0),last=[...events].reverse().find(e=>String(e.load_id)===String(l.id)&&['partial','failed','reschedule'].includes(e.kind));
 return {...l,itinerary_state:l.status==='Entregada'||l.delivered_at?'delivered':last?.kind||'pending',partial_kg:partial,remaining_kg:l.status==='Entregada'||l.delivered_at?0:l.weight_kg>0?Math.max(0,Number(l.weight_kg)-partial):null};
});}
function preserveProgress(previous,next,events){
 if(!previous)return;
 const touched=new Set(events.filter(e=>['arrive','depart'].includes(e.kind)).map(e=>e.stop_key));
 for(let i=0;i<previous.stops.length;i++){const s=previous.stops[i];if(!touched.has(s.key))continue;const n=next.stops[i];
  if(!n||n.key!==s.key||n.location_id!==s.location_id||n.purpose!==s.purpose)throw fail('No se puede eliminar, mover ni cambiar una parada iniciada',409);
  const oldPickup=previous.loads.filter(l=>l.pickup===s.key).map(l=>l.load_id).sort(),newPickup=next.loads.filter(l=>l.pickup===s.key).map(l=>l.load_id).sort();
  if(JSON.stringify(oldPickup)!==JSON.stringify(newPickup))throw fail('No se pueden reescribir recogidas de una parada iniciada',409);
 }
 for(const l of previous.loads){const nextLoad=next.loads.find(n=>n.load_id===l.load_id);if(touched.has(l.pickup)&&(!nextLoad||nextLoad.pickup!==l.pickup))throw fail('Conserva las cargas que ya fueron recogidas',409);}
}
// Estimate along the stored road geometry, not straight-line kilometres as a new road route.
function projection(geometry,lat,lng){
 if(!Number.isFinite(Number(lat))||!Number.isFinite(Number(lng)))return null;
 const c=geometry.coordinates,scale=Math.cos(Number(lat)*Math.PI/180),x=Number(lng)*scale,y=Number(lat);let total=0,best=Infinity,at=0;
 for(let i=1;i<c.length;i++){const ax=c[i-1][0]*scale,ay=c[i-1][1],dx=c[i][0]*scale-ax,dy=c[i][1]-ay,len=Math.hypot(dx,dy);const t=len?Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(len*len))):0,d=Math.hypot(x-ax-t*dx,y-ay-t*dy);if(d<best){best=d;at=total+t*len;}total+=len;}
 return {fraction:total?at/total:0,off_route_m:best*111320};
}
function eta(plan,events,telemetry,now=new Date()){
 const stops=progress(plan,events),next=stops.findIndex(s=>!s.actual_departure);
 if(next<0)return {state:'finished',estimated_arrival:stops.at(-1).actual_departure,source:'actual',next_stop:null};
 const recent=telemetry&&Date.parse(telemetry.recorded_at)<=+now&&+now-Date.parse(telemetry.recorded_at)<=300000;
 let remaining=0,fraction=0,state=recent?'gps_estimate':'stale_gps',source=recent?'stored_road_geometry':'last_plan';
 if(next>0&&recent&&!stops[next].actual_arrival){const q=projection(plan.legs[next-1].geometry,telemetry.lat,telemetry.lng);if(q&&q.off_route_m<=2000)fraction=q.fraction;else {state='off_route';source='last_plan';}}
 for(let i=next;i<stops.length;i++){
  if(i>0)remaining+=plan.legs[i-1].duration_seconds*(i===next?1-fraction:1);
  const service=(stops[i].service_minutes+stops[i].wait_minutes+stops[i].rest_minutes)*60;
  remaining+=i===next&&stops[i].actual_arrival?Math.max(0,service-(+now-Date.parse(stops[i].actual_arrival))/1000):service;
 }
 if(stops[next].actual_arrival&&next>0)remaining-=plan.legs[next-1].duration_seconds;
 const lastDeparture=[...stops].reverse().find(s=>s.actual_departure),anchor=stops[next].actual_arrival?+now:lastDeparture?Date.parse(lastDeparture.actual_departure):Math.max(+now,Date.parse(plan.departure));
 // Without a fresh usable GPS fix, do not present an old estimate as a live position-based ETA.
 const base=state==='gps_estimate'?Math.max(+now,next===0?Date.parse(plan.departure):+now):anchor;
 const latestActual=stops.reduce((t,s)=>Math.max(t,Date.parse(s.actual_departure||s.actual_arrival)||0),0);
 const delays=events.filter(e=>e.kind==='delay'&&(!e.occurred_at||Date.parse(e.occurred_at)>latestActual)).reduce((n,e)=>{
  const seconds=Number(e.minutes||0)*60;
  return n+((state==='gps_estimate'||stops[next].actual_arrival)&&e.occurred_at?Math.max(0,seconds-(+now-Date.parse(e.occurred_at))/1000):seconds);
 },0);
 return {state,source,estimated_arrival:new Date(Math.max(+now,base+remaining*1000+plan.contingency_minutes*60000+delays*1000)).toISOString(),next_stop:stops[next].key,gps_recorded_at:telemetry?.recorded_at||null,delay_seconds:delays};
}
module.exports={fail,key,minutes,normalize,signature,capacityPlan,routeValid,schedule,progress,outcomes,preserveProgress,projection,eta};
