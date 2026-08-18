class GeocodingError extends Error {
  constructor(message,code='provider_error'){
    super(message);
    this.name='GeocodingError';
    this.code=code;
  }
}

const text=value=>typeof value==='string'&&value.trim()?value.trim():null;

function normalizeNominatim(item,now=()=>new Date()){
  if(!item)return null;
  const lat=Number(item.lat),lng=Number(item.lon);
  if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lng)||lng < -180||lng > 180)throw new GeocodingError('El proveedor devolvió coordenadas no válidas','invalid_result');
  const address=item.address&&typeof item.address==='object'?item.address:{};
  const commune=text(address.city_district)||text(address.city)||text(address.town)||text(address.village)||text(address.municipality)||text(address.county);
  const region=text(address.state)||text(address.region);
  const name=text(item.name)||text(address.road)||text(address.city)||text(address.town)||text(address.village)||text(item.display_name);
  const externalId=item.osm_type&&item.osm_id!==undefined?`${item.osm_type}:${item.osm_id}`:null;
  return {name,address:text(item.display_name),commune,region,lat,lng,source:'nominatim',external_id:externalId,normalized_at:now().toISOString()};
}

function createNominatimGeocoder({fetchImpl=globalThis.fetch,baseUrl=process.env.GEOCODING_BASE_URL||'https://nominatim.openstreetmap.org',userAgent=process.env.GEOCODING_USER_AGENT,now}={}){
  if(typeof fetchImpl!=='function')throw new GeocodingError('No existe un cliente HTTP disponible','configuration_error');
  return {async geocode(query){
    if(!userAgent)throw new GeocodingError('GEOCODING_USER_AGENT no está configurado','configuration_error');
    const url=new URL('/search',baseUrl);
    url.searchParams.set('q',query);
    url.searchParams.set('format','jsonv2');
    url.searchParams.set('addressdetails','1');
    url.searchParams.set('limit','1');
    url.searchParams.set('countrycodes','cl');
    let response;
    try{response=await fetchImpl(url,{headers:{Accept:'application/json','User-Agent':userAgent},signal:AbortSignal.timeout(10000)})}catch(error){throw new GeocodingError(`No se pudo contactar al proveedor: ${error.message}`)}
    if(!response.ok)throw new GeocodingError(`El proveedor respondió HTTP ${response.status}`);
    let payload;
    try{payload=await response.json()}catch{throw new GeocodingError('El proveedor devolvió una respuesta inválida','invalid_result')}
    if(!Array.isArray(payload))throw new GeocodingError('El proveedor devolvió una respuesta inválida','invalid_result');
    return normalizeNominatim(payload[0],now);
  }};
}

function createGeocoder(options={}){
  const provider=(options.provider||process.env.GEOCODING_PROVIDER||'nominatim').toLowerCase();
  if(provider==='nominatim')return createNominatimGeocoder(options);
  throw new GeocodingError(`Proveedor de geocodificación no soportado: ${provider}`,'configuration_error');
}

module.exports={GeocodingError,createGeocoder,createNominatimGeocoder,normalizeNominatim};
