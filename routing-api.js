const {requirePermission}=require('./auth');
const {writeAudit}=require('./audit');
const {RoutingError}=require('./routing');

const isAdmin=req=>req.user?.role_code==='admin';
const companyId=req=>isAdmin(req)?(req.body?.company_id||null):(req.user?.company_id||null);
const positiveId=value=>Number.isInteger(Number(value))&&Number(value)>0?Number(value):null;
const coordinate=(value,min,max)=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max;
const validCoordinates=location=>coordinate(location?.lat,-90,90)&&coordinate(location?.lng,-180,180);
const validRoute=result=>Number.isFinite(result?.distance_meters)&&result.distance_meters>=0&&Number.isFinite(result?.duration_seconds)&&result.duration_seconds>=0&&result.geometry?.type==='LineString'&&Array.isArray(result.geometry.coordinates)&&result.geometry.coordinates.length>=2&&typeof result.provider==='string'&&result.provider.trim()&&typeof result.calculated_at==='string'&&!Number.isNaN(Date.parse(result.calculated_at));

function routingFailure(res,error){
  if(error instanceof RoutingError&&error.code==='configuration_error')return res.status(503).json({error:'El servicio de ruteo no está configurado'});
  return res.status(502).json({error:'No se pudo calcular la ruta'});
}

function registerRoutingRoutes(app,pool,routingAdapter){
  app.post('/api/geography/routes',requirePermission('trips.manage'),async(req,res)=>{
    const originId=positiveId(req.body?.origin_location_id),destinationId=positiveId(req.body?.destination_location_id),cid=companyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para calcular la ruta'});
    if(!originId||!destinationId)return res.status(400).json({error:'Origen y destino son obligatorios'});
    try{
      const origin=(await pool.query('select id,company_id,name,lat,lng from operational_locations where id=$1 and company_id=$2',[originId,cid])).rows[0];
      if(!origin)return res.status(404).json({error:'Ubicación de origen no encontrada'});
      if(!validCoordinates(origin))return res.status(422).json({error:'La ubicación de origen no tiene coordenadas válidas'});
      const destination=(await pool.query('select id,company_id,name,lat,lng from operational_locations where id=$1 and company_id=$2',[destinationId,cid])).rows[0];
      if(!destination)return res.status(404).json({error:'Ubicación de destino no encontrada'});
      if(!validCoordinates(destination))return res.status(422).json({error:'La ubicación de destino no tiene coordenadas válidas'});
      let calculated;
      try{calculated=await routingAdapter.route(origin,destination)}catch(error){return routingFailure(res,error)}
      if(!calculated)return res.status(404).json({error:'No se encontró una ruta por carretera'});
      if(!validRoute(calculated))return res.status(502).json({error:'El proveedor devolvió una ruta no válida'});
      const db=await pool.connect();
      try{
        await db.query('BEGIN');
        const result=await db.query(`insert into road_routes(company_id,origin_location_id,destination_location_id,distance_meters,duration_seconds,geometry,provider,calculated_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[cid,originId,destinationId,calculated.distance_meters,calculated.duration_seconds,calculated.geometry,calculated.provider,calculated.calculated_at]);
        await writeAudit(db,req,{companyId:cid,action:'create',entity:'road_route',entityId:result.rows[0].id,afterData:result.rows[0]});
        await db.query('COMMIT');
        res.status(201).json(result.rows[0]);
      }catch(error){await db.query('ROLLBACK');res.status(400).json({error:'No se pudo guardar la ruta calculada'})}finally{db.release()}
    }catch(error){res.status(500).json({error:'No se pudieron consultar las ubicaciones'})}
  });
}

module.exports={registerRoutingRoutes};
