const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {GeocodingError}=require('./geocoding');

const clean=value=>typeof value==='string'?value.trim():'';
const actorContext=req=>resolveActorContext(req);
const isLegacyAdmin=req=>{
  const actor=actorContext(req);
  return actor?.actor_type==='legacy'&&actor.role==='admin'&&!actor.membership_id&&!actor.platform_membership_id;
};
const companyId=req=>{
  const actor=actorContext(req);
  if(actor?.actor_type==='company')return actor.company_id||null;
  if(actor?.actor_type==='legacy')return isLegacyAdmin(req)?(req.body?.company_id||actor.company_id||null):(actor.company_id||null);
  return null;
};
const validCoordinates=result=>Number.isFinite(result?.lat)&&result.lat>=-90&&result.lat<=90&&Number.isFinite(result?.lng)&&result.lng>=-180&&result.lng<=180;

function geocodingFailure(res,error){
  if(error instanceof GeocodingError&&error.code==='configuration_error')return res.status(503).json({error:'El servicio de geocodificación no está configurado'});
  return res.status(502).json({error:'No se pudo geocodificar la ubicación'});
}

function registerGeographyRoutes(app,pool,geocoder){
  app.post('/api/geography/geocode',requirePermission('trips.manage'),async(req,res)=>{
    const query=clean(req.body?.query);
    if(!query||query.length>500)return res.status(400).json({error:'La dirección o localidad es obligatoria y debe tener hasta 500 caracteres'});
    try{const result=await geocoder.geocode(query);if(!result)return res.status(404).json({error:'No se encontró una ubicación'});if(!validCoordinates(result))return res.status(502).json({error:'El proveedor devolvió una ubicación no válida'});res.json(result)}catch(error){geocodingFailure(res,error)}
  });

  app.post('/api/geography/locations',requirePermission('trips.manage'),async(req,res)=>{
    const query=clean(req.body?.query),requestedName=clean(req.body?.name),cid=companyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para crear la ubicación'});
    if(!query||query.length>500)return res.status(400).json({error:'La dirección o localidad es obligatoria y debe tener hasta 500 caracteres'});
    let normalized;
    try{normalized=await geocoder.geocode(query)}catch(error){return geocodingFailure(res,error)}
    if(!normalized)return res.status(404).json({error:'No se encontró una ubicación'});
    if(!validCoordinates(normalized))return res.status(502).json({error:'El proveedor devolvió una ubicación no válida'});
    const name=requestedName||clean(normalized.name)||clean(normalized.address);
    if(!name)return res.status(502).json({error:'El proveedor devolvió una ubicación no válida'});
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const result=await db.query(`insert into operational_locations(company_id,name,address,commune,region,lat,lng,source,external_id,normalized_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[cid,name,normalized.address||null,normalized.commune||null,normalized.region||null,normalized.lat,normalized.lng,normalized.source,normalized.external_id||null,normalized.normalized_at]);
      await writeAudit(db,req,{companyId:cid,action:'create',entity:'operational_location',entityId:result.rows[0].id,afterData:result.rows[0]});
      await db.query('COMMIT');
      res.status(201).json(result.rows[0]);
    }catch(error){await db.query('ROLLBACK');res.status(400).json({error:'No se pudo guardar la ubicación'})}finally{db.release()}
  });
}

module.exports={registerGeographyRoutes};
