class RoutingError extends Error {
  constructor(message,code='provider_error'){
    super(message);
    this.name='RoutingError';
    this.code=code;
  }
}

const validCoordinate=(value,min,max)=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max;

function normalizeOsrmRoute(route,now=()=>new Date()){
  if(!route)return null;
  const distanceMeters=Number(route.distance),durationSeconds=Number(route.duration),geometry=route.geometry;
  const validGeometry=geometry?.type==='LineString'&&Array.isArray(geometry.coordinates)&&geometry.coordinates.length>=2&&geometry.coordinates.every(point=>Array.isArray(point)&&point.length>=2&&validCoordinate(point[0],-180,180)&&validCoordinate(point[1],-90,90));
  if(!Number.isFinite(distanceMeters)||distanceMeters<0||!Number.isFinite(durationSeconds)||durationSeconds<0||!validGeometry)throw new RoutingError('El proveedor devolvió una ruta no válida','invalid_result');
  return {distance_meters:distanceMeters,duration_seconds:durationSeconds,geometry,provider:'osrm',calculated_at:now().toISOString()};
}

function createOsrmRouter({fetchImpl=globalThis.fetch,baseUrl=process.env.ROUTING_BASE_URL||'https://router.project-osrm.org',now}={}){
  if(typeof fetchImpl!=='function')throw new RoutingError('No existe un cliente HTTP disponible','configuration_error');
  return {async route(origin,destination){
    if(!validCoordinate(origin?.lat,-90,90)||!validCoordinate(origin?.lng,-180,180)||!validCoordinate(destination?.lat,-90,90)||!validCoordinate(destination?.lng,-180,180))throw new RoutingError('Las coordenadas de ruteo no son válidas','invalid_coordinates');
    const coordinates=`${Number(origin.lng)},${Number(origin.lat)};${Number(destination.lng)},${Number(destination.lat)}`;
    const url=new URL(`/route/v1/driving/${coordinates}`,baseUrl);
    url.searchParams.set('overview','full');
    url.searchParams.set('geometries','geojson');
    url.searchParams.set('steps','false');
    url.searchParams.set('alternatives','false');
    let response;
    try{response=await fetchImpl(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)})}catch(error){throw new RoutingError(`No se pudo contactar al proveedor: ${error.message}`)}
    if(!response.ok)throw new RoutingError(`El proveedor respondió HTTP ${response.status}`);
    let payload;
    try{payload=await response.json()}catch{throw new RoutingError('El proveedor devolvió una respuesta inválida','invalid_result')}
    if(payload?.code==='NoRoute'||!Array.isArray(payload?.routes)||payload.routes.length===0)return null;
    if(payload.code!=='Ok')throw new RoutingError('El proveedor devolvió una respuesta inválida','invalid_result');
    return normalizeOsrmRoute(payload.routes[0],now);
  }};
}

function createRoutingAdapter(options={}){
  const provider=(options.provider||process.env.ROUTING_PROVIDER||'osrm').toLowerCase();
  if(provider==='osrm')return createOsrmRouter(options);
  throw new RoutingError(`Proveedor de ruteo no soportado: ${provider}`,'configuration_error');
}

module.exports={RoutingError,createRoutingAdapter,createOsrmRouter,normalizeOsrmRoute};
