'use strict';
const {createHash}=require('node:crypto');
const {reserve}=require('./ors-budget');
const ATTRIBUTION='© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors';
const cache=new Map(),pending=new Map(),MAX_CACHE=100,TTL=600000;
const MAX_CACHE_BYTES=8*1024*1024,MAX_ENTRY_BYTES=1024*1024;
let cacheBytes=0;
function evict(key){const entry=cache.get(key);if(entry){cacheBytes-=entry.bytes;cache.delete(key);}}
const fail=(message,code='provider_error')=>Object.assign(new Error(message),{code});
const coordinate=(v,min,max)=>['number','string'].includes(typeof v)&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=min&&Number(v)<=max;
const metric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
function validate(data,service){
 if(data?.type!=='FeatureCollection'||!Array.isArray(data.features))throw fail('OpenRouteService devolvió una respuesta no válida','invalid_result');
 if(service==='geocoding'){
  for(const f of data.features.slice(0,5)){const p=f?.geometry?.coordinates;if(f?.geometry?.type!=='Point'||!Array.isArray(p)||!coordinate(p[0],-180,180)||!coordinate(p[1],-90,90))throw fail('OpenRouteService devolvió coordenadas no válidas','invalid_result');}
 }else{
  const f=data.features[0],g=f?.geometry,s=f?.properties?.summary;
  if(data.features.length!==1||!metric(s?.distance)||!metric(s?.duration)||g?.type!=='LineString'||!Array.isArray(g.coordinates)||g.coordinates.length<2||!g.coordinates.every(p=>Array.isArray(p)&&coordinate(p[0],-180,180)&&coordinate(p[1],-90,90)))throw fail('OpenRouteService devolvió una ruta no válida','invalid_result');
 }
}
function transport({fetchImpl=globalThis.fetch,apiKey=process.env.ORS_API_KEY,pool,env=process.env,budget=reserve,now=()=>new Date()}={}){
 return async(service,path,{query,body}={})=>{
  if(typeof apiKey!=='string'||!apiKey.trim()||typeof fetchImpl!=='function')throw fail('Configura ORS_API_KEY en el servidor para usar OpenRouteService','configuration_error');
  const url=new URL(path,'https://api.openrouteservice.org');
  for(const [k,v] of Object.entries(query||{}))url.searchParams.set(k,v);
  // Pelias uses api_key in the server-to-server query (official SDK contract).
  if(service==='geocoding')url.searchParams.set('api_key',apiKey);
  const key=createHash('sha256').update(JSON.stringify([apiKey,service,path,query,body])).digest('hex'),at=+now();
  const saved=cache.get(key);if(saved&&saved.until>at)return structuredClone(saved.value);
  if(pending.has(key))return structuredClone(await pending.get(key));
  const work=(async()=>{
   await budget(pool,apiKey,service,env);
   let response;try{response=await fetchImpl(url,{method:body?'POST':'GET',redirect:'error',headers:{Accept:'application/geo+json, application/json',...(body?{'Content-Type':'application/json',Authorization:apiKey}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});}catch{throw fail('No se pudo contactar a OpenRouteService');}
   if(!response.ok){
    if(service==='directions'&&response.status===400){try{const error=await response.json();if(Number(error?.error?.code)===2009)return null;}catch{}}
    if(response.status===429)throw fail('OpenRouteService limitó las consultas. Reintenta más tarde.','quota_exceeded');
    if([401,403].includes(response.status))throw fail('OpenRouteService rechazó la credencial o se agotó su cuota. Revisa el panel del proveedor.','provider_denied');
    throw fail('OpenRouteService no pudo atender la solicitud');
   }
   let data;try{data=await response.json();}catch{throw fail('OpenRouteService devolvió una respuesta no válida','invalid_result');}
   if(data?.error){if(Number(data.error.code)===2009)return null;throw fail('OpenRouteService no encontró un resultado válido','invalid_result');}
   validate(data,service);
   for(const [k,v] of cache)if(v.until<=at)evict(k);
   const result={payload:data,fetched_at:now().toISOString()},bytes=Buffer.byteLength(JSON.stringify(result));
   if(bytes<=MAX_ENTRY_BYTES){while(cache.size&&(cache.size>=MAX_CACHE||cacheBytes+bytes>MAX_CACHE_BYTES))evict(cache.keys().next().value);cache.set(key,{until:at+TTL,value:result,bytes});cacheBytes+=bytes;}
   return result;
  })();pending.set(key,work);
  try{return structuredClone(await work);}finally{pending.delete(key);}
 };
}
function createOrsGeocoder(options={}){
 const request=transport(options);
 async function search(query){
  if(typeof query!=='string'||query.trim().length<3||query.length>500)throw fail('Dirección no válida','invalid_coordinates');
  const response=await request('geocoding','/geocode/search',{query:{text:query.trim(),'boundary.country':'CHL',size:'5',lang:'es'}});
  const data=response?.payload;
  if(data?.type!=='FeatureCollection'||!Array.isArray(data.features))throw fail('OpenRouteService devolvió ubicaciones no válidas','invalid_result');
  return data.features.slice(0,5).map(f=>{
   const [lng,lat]=f.geometry?.coordinates||[],p=f.properties||{};
   if(f.geometry?.type!=='Point'||!coordinate(lat,-90,90)||!coordinate(lng,-180,180))throw fail('OpenRouteService devolvió coordenadas no válidas','invalid_result');
   if(p.country_a&&p.country_a!=='CHL')return null;
   return {name:p.name||p.label||query.trim(),address:p.label||p.name||query.trim(),commune:p.localadmin||p.locality||null,region:p.region||null,lat:Number(lat),lng:Number(lng),source:'openrouteservice',external_id:typeof p.gid==='string'?p.gid:null,normalized_at:response.fetched_at,attribution:ATTRIBUTION};
  }).filter(Boolean);
 }
 return {provider:'openrouteservice',search,async geocode(query){return (await search(query))[0]||null;}};
}
// Only the gap from the requested access to the provider's route endpoint is
// measured here. It is NOT used as road distance or added to provider metrics.
function gap(a,b){const rad=x=>x*Math.PI/180,dlat=rad(a.lat-b.lat),dlng=rad(a.lng-b.lng),s=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlng/2)**2;return 6371000*2*Math.asin(Math.sqrt(Math.min(1,s)));}
function createOrsRouter(options={}){
 const request=transport(options),profile=options.profile||process.env.ORS_ROUTING_PROFILE||'driving-car';
 return {provider:'openrouteservice',async route(a,b){
  if(!['driving-car','driving-hgv'].includes(profile))throw fail('Perfil de OpenRouteService no válido','configuration_error');
  for(const p of [a,b])if(!coordinate(p?.lat,-90,90)||!coordinate(p?.lng,-180,180))throw fail('Coordenadas de ruteo no válidas','invalid_coordinates');
  const response=await request('directions',`/v2/directions/${profile}/geojson`,{body:{coordinates:[[Number(a.lng),Number(a.lat)],[Number(b.lng),Number(b.lat)]],instructions:false,units:'m'}});
  if(response===null)return null;const data=response.payload;
  const feature=data?.features?.[0],summary=feature?.properties?.summary,g=feature?.geometry;
  if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)||data.features.length!==1||!metric(summary?.distance)||!metric(summary?.duration)||g?.type!=='LineString'||!Array.isArray(g.coordinates)||g.coordinates.length<2||!g.coordinates.every(p=>Array.isArray(p)&&coordinate(p[0],-180,180)&&coordinate(p[1],-90,90)))throw fail('OpenRouteService devolvió una ruta no válida','invalid_result');
  const points=[g.coordinates[0],g.coordinates.at(-1)].map(([lng,lat],i)=>({lat:Number(lat),lng:Number(lng),distance:gap({lat:Number([a,b][i].lat),lng:Number([a,b][i].lng)},{lat:Number(lat),lng:Number(lng)})}));
  return {distance_meters:summary.distance,duration_seconds:summary.duration,geometry:{type:'LineString',coordinates:g.coordinates.map(p=>[Number(p[0]),Number(p[1])])},provider:'openrouteservice/'+profile,calculated_at:response.fetched_at,snapped_points:points,attribution:ATTRIBUTION};
 }};
}
module.exports={createOrsGeocoder,createOrsRouter,ATTRIBUTION};
