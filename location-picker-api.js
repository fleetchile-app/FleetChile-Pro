'use strict';
const {resolveActorContext,isPlatformOwner}=require('./auth');
const {writeAudit}=require('./audit');
const clean=(v,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const number=(v,min,max)=>['string','number'].includes(typeof v)&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):null;
const id=v=>number(v,1,Number.MAX_SAFE_INTEGER)&&Number.isSafeInteger(Number(v))?Number(v):null;
// Reuse existing permissions; this does not grant any new role privilege.
function access(req,res,next){
 const actor=resolveActorContext(req);
 if(!req.user)return res.status(401).json({error:'Autenticación requerida'});
 if(!actor?.company_id||actor.scope!=='company'||actor.actor_type==='unresolved')return res.status(403).json({error:'Selecciona una empresa autorizada'});
 const legacy=actor.actor_type==='legacy'&&actor.role==='admin';
 if(!legacy&&!isPlatformOwner(req.user)&&!['trips.manage','loads.manage'].some(p=>(req.user.permissions||[]).includes(p)))return res.status(403).json({error:'Se requiere permiso para gestionar viajes o cargas'});
 req.locationCompanyId=actor.company_id;next();
}
function registerLocationPickerRoutes(app,pool,geocoder,router,{env=process.env}={}){
 app.get('/api/location-picker/clients',access,async(req,res)=>{try{res.json((await pool.query('select id,name from clients where company_id=$1 and active=true order by name,id',[req.locationCompanyId])).rows);}catch{res.status(500).json({error:'No se pudieron consultar los clientes'});}});
 app.get('/api/location-picker/catalog',access,async(req,res)=>{
  try{
   const region=id(req.query.region_id),commune=id(req.query.commune_id);
   if((req.query.region_id&&!region)||(req.query.commune_id&&!commune))return res.status(400).json({error:'Selección geográfica no válida'});
   const regions=(await pool.query('select id,official_code,name from geo_regions order by official_code')).rows;
   const communes=region?(await pool.query('select c.id,c.official_code,c.name from geo_communes c join geo_provinces p on p.id=c.province_id where p.region_id=$1 order by c.name,c.id',[region])).rows:[];
   const localities=commune?(await pool.query('select id,official_code,name,type,latitude,longitude,source,source_version from geo_localities where commune_id=$1 and name ilike $2 order by name,id limit 100',[commune,'%'+clean(req.query.q,100)+'%'])).rows:[];
   res.json({countries:[{code:'CL',name:'Chile'}],regions,communes,localities,locality_notice:'El catálogo puede no incluir sectores rurales. Confirma el acceso exacto en el mapa.'});
  }catch{res.status(500).json({error:'No se pudo consultar el catálogo geográfico'});}
 });
 app.get('/api/location-picker/locations',access,async(req,res)=>{
  try{res.json((await pool.query('select * from operational_locations where company_id=$1 and (name ilike $2 or address ilike $2) order by name,id limit 100',[req.locationCompanyId,'%'+clean(req.query.q,100)+'%'])).rows);}catch{res.status(500).json({error:'No se pudieron consultar las ubicaciones'});}
 });
 app.post('/api/location-picker/search',access,async(req,res)=>{
  // Public OSM Nominatim is not a suitable place-search service for this product.
  let host;try{host=new URL(env.GEOCODING_BASE_URL||'https://nominatim.openstreetmap.org').hostname;}catch{}
  if(geocoder.provider!=='openrouteservice'&&(!host||host==='nominatim.openstreetmap.org'))return res.status(503).json({error:'La búsqueda de direcciones requiere configurar un proveedor autorizado. Puedes seleccionar el punto directamente en el mapa.'});
  const query=clean(req.body?.query);if(query.length<3)return res.status(400).json({error:'Escribe una dirección o establecimiento'});
  try{const results=geocoder.search?await geocoder.search(query):[await geocoder.geocode(query)].filter(Boolean);res.json(results);}catch(e){res.status(e.code==='quota_exceeded'?429:503).json({error:['quota_exceeded','configuration_error','provider_denied','budget_unavailable'].includes(e.code)?e.message:'No se pudo buscar la dirección. El punto del mapa sigue disponible.'});}
 });
 app.post('/api/location-picker/locations',access,async(req,res)=>{
  const b=req.body||{},name=clean(b.name,160),lat=number(b.lat,-90,90),lng=number(b.lng,-180,180),commune=id(b.commune_id),locality=b.locality_id?id(b.locality_id):null;
  if(!name||lat===null||lng===null||!commune||(b.country_code&&b.country_code!=='CL')||(b.locality_id&&!locality)||(b.client_id&&!id(b.client_id)))return res.status(400).json({error:'Indica nombre, comuna y un punto válido en el mapa'});
  const db=await pool.connect();try{
   await db.query('BEGIN');
   const geo=(await db.query('select c.name commune,r.name region,p.region_id from geo_communes c join geo_provinces p on p.id=c.province_id join geo_regions r on r.id=p.region_id where c.id=$1',[commune])).rows[0];
   if(!geo||Number(geo.region_id)!==id(b.region_id))throw new Error('La comuna no corresponde a la región');
   if(locality&&!(await db.query('select id from geo_localities where id=$1 and commune_id=$2',[locality,commune])).rows[0])throw new Error('La localidad no corresponde a la comuna');
   if(b.client_id&&!(await db.query('select id from clients where id=$1 and company_id=$2 and active=true',[id(b.client_id),req.locationCompanyId])).rows[0])throw new Error('El cliente no pertenece a la empresa');
   const row=(await db.query(`insert into operational_locations(company_id,name,address,commune,region,lat,lng,source,country_code,commune_id,locality_id,access_notes,client_id,created_by) values($1,$2,$3,$4,$5,$6,$7,'map_confirmed','CL',$8,$9,$10,$11,$12) returning *`,[req.locationCompanyId,name,clean(b.address)||null,geo.commune,geo.region,lat,lng,commune,locality,clean(b.access_notes,1000)||null,id(b.client_id),req.user.id])).rows[0];
   await writeAudit(db,req,{companyId:req.locationCompanyId,action:'create',entity:'operational_location',entityId:row.id,afterData:row});await db.query('COMMIT');res.status(201).json(row);
  }catch{await db.query('ROLLBACK');res.status(400).json({error:'No se pudo guardar la ubicación. Revisa región, comuna, localidad y cliente.'});}finally{db.release();}
 });
 app.post('/api/location-picker/route',access,async(req,res)=>{
  let host;try{host=new URL(env.ROUTING_BASE_URL||'https://router.project-osrm.org').hostname;}catch{}
  if(router.provider!=='openrouteservice'&&(!host||['router.project-osrm.org','routing.openstreetmap.de'].includes(host)))return res.status(503).json({error:'Configura un proveedor de ruteo autorizado para producción. No se calcularon kilómetros.'});
  const a=id(req.body?.origin_location_id),b=id(req.body?.destination_location_id);if(!a||!b)return res.status(400).json({error:'Confirma origen y destino'});
  try{
   const rows=(await pool.query('select * from operational_locations where company_id=$1 and id=any($2::bigint[])',[req.locationCompanyId,[a,b]])).rows,origin=rows.find(x=>Number(x.id)===a),destination=rows.find(x=>Number(x.id)===b);
   if(!origin||!destination)return res.status(404).json({error:'Ubicación no encontrada'});
   const route=await router.route(origin,destination);if(!route)return res.status(404).json({error:'No se encontró una ruta por carretera'});
   const db=await pool.connect();try{await db.query('BEGIN');const row=(await db.query('insert into road_routes(company_id,origin_location_id,destination_location_id,distance_meters,duration_seconds,geometry,provider,calculated_at,snapped_points) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[req.locationCompanyId,a,b,route.distance_meters,route.duration_seconds,route.geometry,route.provider,route.calculated_at,route.snapped_points?JSON.stringify(route.snapped_points):null])).rows[0];await writeAudit(db,req,{companyId:req.locationCompanyId,action:'create',entity:'road_route',entityId:row.id,afterData:row});await db.query('COMMIT');res.status(201).json(row);}catch{await db.query('ROLLBACK');throw new Error('persist');}finally{db.release();}
  }catch(e){res.status(e.code==='quota_exceeded'?429:502).json({error:['quota_exceeded','configuration_error','provider_denied','budget_unavailable'].includes(e.code)?e.message:'No se pudo calcular la ruta; no se guardaron kilómetros inventados'});}
 });
}
module.exports={registerLocationPickerRoutes,access};
