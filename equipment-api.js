'use strict';
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {assertTripResourcesReady,resourceFailure}=require('./trip-eligibility');
const {assertDriverOperationalReady}=require('./driver-readiness');
const {activationError,syncResourceAlert,terminal,inExecution}=require('./trip-resources');
const E=require('./equipment-domain');
const CAT='/api/fleet/compositions',OPS='/api/operations/trips';
function company(req){const a=resolveActorContext(req);if(!a||a.scope!=='company'||!a.company_id)throw E.fail('Selecciona una empresa para gestionar conjuntos',403);return a.company_id;}
function has(req,p){let yes=false;requirePermission(p)(req,{status(){return this;},json(){return this;}},()=>{yes=true;});return yes;}
function readCatalog(req,res,next){if(has(req,'fleet.manage')||has(req,'trips.manage'))return next();return res.status(403).json({error:'Se requiere fleet.manage o trips.manage'});}
async function vehicles(db,cid,ids,lock=false,strict=true){
 const values=[...new Set(ids.filter(Boolean).map(Number))].sort((a,b)=>a-b);
 if(!values.length)return [];
 const rows=(await db.query(`select id,company_id,patente,tipo,capacidad_t from trucks where company_id=$1 and id=any($2::integer[]) order by id${lock?' for share':''}`,[cid,values])).rows;
 if(strict&&rows.length!==values.length)throw E.fail('Uno de los vehículos no pertenece a la empresa',403);
 return rows;
}
const viewVehicle=v=>v?{id:v.id,patente:v.patente,tipo:v.tipo,capacity_t:v.capacidad_t==null?null:Number(v.capacidad_t)}:null;
function equipmentSnapshot(c,rows){
 const truck=rows.find(v=>String(v.id)===String(c.truck_id)),trailer=rows.find(v=>String(v.id)===String(c.trailer_id));
 E.pair(truck,trailer);
 return {composition_id:c.id||null,composition_version:c.version||null,name:c.name||null,valid_from:c.valid_from?new Date(c.valid_from).toISOString():null,
  valid_until:c.valid_until?new Date(c.valid_until).toISOString():null,truck:viewVehicle(truck),trailer:viewVehicle(trailer),capacity_t:E.capacity(truck,trailer)};
}
async function catalogRows(db,cid){return (await db.query(`select c.*,t.patente truck_patente,t.tipo truck_type,r.patente trailer_patente,r.tipo trailer_type,
 case when r.id is not null then r.capacidad_t else t.capacidad_t end capacity_t
 from fleet_compositions c join trucks t on t.id=c.truck_id and t.company_id=c.company_id left join trucks r on r.id=c.trailer_id and r.company_id=c.company_id
 where c.company_id=$1 order by c.active desc,c.name,c.id`,[cid])).rows.map(c=>({...c,capacity_t:!c.trailer_id&&E.role(c.truck_type)==='tractor'?null:c.capacity_t}));}
async function recordCatalog(db,req,c,reason,rows){
 const snapshot=equipmentSnapshot(c,rows);
 await db.query(`insert into fleet_composition_revisions(company_id,composition_id,version,actor_user_id,actor_name,reason,snapshot)
  values($1,$2,$3,$4,$5,$6,$7)`,[c.company_id,c.id,c.version,req.user.id,req.user.name||'Usuario autenticado',reason,{...snapshot,active:c.active}]);
 return snapshot;
}
async function observedResources(db,cid,trip){
 const rows=await vehicles(db,cid,[trip.truck_id,trip.trailer_id],false,false);
 const driver=trip.driver_id?(await db.query('select id,name from drivers where company_id=$1 and id=$2',[cid,trip.driver_id])).rows[0]||null:null;
 return {truck_id:trip.truck_id||null,trailer_id:trip.trailer_id||null,driver_id:trip.driver_id||null,truck:viewVehicle(rows.find(v=>String(v.id)===String(trip.truck_id))),trailer:viewVehicle(rows.find(v=>String(v.id)===String(trip.trailer_id))),
  driver,client_id:trip.client_id||null,route_id:trip.route_id||null,composition:trip.composition_snapshot||null};
}
async function revision(db,req,trip,version,snapshot,reason,baseline=false){
 await db.query(`insert into trip_resource_revisions(company_id,trip_id,version,effective_at,baseline_observation,actor_user_id,actor_name,reason,snapshot)
  values($1,$2,$3,case when $4::boolean then null else clock_timestamp() end,$4,$5,$6,$7,$8)`,[trip.company_id,trip.id,version,baseline,req.user.id,req.user.name||'Usuario autenticado',reason,snapshot]);
}
function registerEquipmentRoutes(app,pool){
 const route=(method,path,permission,work)=>app[method](path,permission,async(req,res)=>{
  try{await work(req,res,company(req));}catch(e){if(e.code?.startsWith('EQUIPMENT')||e.code?.startsWith('COMPOSITION')||e.status)return res.status(e.status||400).json({code:e.code,error:e.message});
   return res.status(500).json({error:'No se pudo procesar el conjunto o la asignación'});}
 });
 route('get',CAT,readCatalog,async(req,res,cid)=>res.json({rows:await catalogRows(pool,cid),can_manage:has(req,'fleet.manage')}));
 route('get',CAT+'/options',readCatalog,async(req,res,cid)=>res.json((await pool.query('select id,patente,tipo,capacidad_t,status from trucks where company_id=$1 order by patente',[cid])).rows));
 route('get',CAT+'/:id/history',readCatalog,async(req,res,cid)=>{
  const id=E.id(req.params.id),page=E.id(req.query.page||1),count=(await pool.query('select count(*)::int total from fleet_composition_revisions where company_id=$1 and composition_id=$2',[cid,id])).rows[0].total;
  res.json({rows:(await pool.query('select * from fleet_composition_revisions where company_id=$1 and composition_id=$2 order by version desc limit 25 offset $3',[cid,id,(page-1)*25])).rows,total:count,page,page_size:25});
 });
 const saveCatalog=async(req,res,cid,edit)=>{
  const b=req.body||{},db=await pool.connect();try{
   await db.query('BEGIN');
   const old=edit?(await db.query('select * from fleet_compositions where id=$1 and company_id=$2 for update',[E.id(req.params.id),cid])).rows[0]:null;
   if(edit&&!old)throw E.fail('Conjunto no encontrado',404);
   if(edit&&E.id(b.version,'Versión')!==old.version)throw E.fail('El conjunto cambió. Vuelve a cargar su ficha.',409,'COMPOSITION_CONFLICT');
   const read=k=>Object.hasOwn(b,k)?b[k]:old?.[k];
   const name=E.text(read('name'),'Nombre del conjunto',160),truckId=E.id(read('truck_id'),'Vehículo principal'),trailerId=E.id(read('trailer_id'),'Remolque',{optional:true});
   const from=read('valid_from'),until=read('valid_until');
   const validFrom=E.instant(from instanceof Date?from.toISOString():from,'Inicio de vigencia'),validUntil=until?E.instant(until instanceof Date?until.toISOString():until,'Término de vigencia'):null;
   if(validUntil&&validUntil<=validFrom)throw E.fail('El término debe ser posterior al inicio');
   const active=read('active')??true;if(typeof active!=='boolean')throw E.fail('Estado del conjunto no válido');
   const reason=edit?E.text(b.reason,'Motivo del cambio'):b.reason?E.text(b.reason,'Motivo'):'Creación del conjunto';
   const rows=await vehicles(db,cid,[truckId,trailerId],true);E.pair(rows.find(v=>Number(v.id)===truckId),rows.find(v=>Number(v.id)===trailerId));
   const c=(edit?await db.query(`update fleet_compositions set name=$1,truck_id=$2,trailer_id=$3,valid_from=$4,valid_until=$5,active=$6,
    version=version+1,updated_at=now() where id=$7 and company_id=$8 returning *`,[name,truckId,trailerId,validFrom,validUntil,active,old.id,cid]):
    await db.query(`insert into fleet_compositions(name,truck_id,trailer_id,valid_from,valid_until,active,company_id) values($1,$2,$3,$4,$5,$6,$7) returning *`,[name,truckId,trailerId,validFrom,validUntil,active,cid])).rows[0];
   const snapshot=await recordCatalog(db,req,c,reason,rows);
   await writeAudit(db,req,{companyId:cid,action:edit?'update':'create',entity:'fleet_composition',entityId:c.id,beforeData:old,afterData:{...c,snapshot,reason}});
   await db.query('COMMIT');res.status(edit?200:201).json({...c,snapshot});
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 };
 route('post',CAT,requirePermission('fleet.manage'),(req,res,cid)=>saveCatalog(req,res,cid,false));
 route('patch',CAT+'/:id',requirePermission('fleet.manage'),(req,res,cid)=>saveCatalog(req,res,cid,true));
 route('get',OPS+'/:id/resources/options',requirePermission('trips.manage'),async(req,res,cid)=>{
  if(!(await pool.query('select id from trips where id=$1 and company_id=$2',[E.id(req.params.id),cid])).rows.length)throw E.fail('Viaje no encontrado',404);
  const [compositions,trucks,drivers,clients,routes]=await Promise.all([catalogRows(pool,cid),pool.query('select id,patente,tipo,capacidad_t,status from trucks where company_id=$1 order by patente',[cid]),
   pool.query('select id,name,status from drivers where company_id=$1 order by name',[cid]),pool.query('select id,name from clients where company_id=$1 and active=true order by name',[cid]),pool.query('select id,origin,destination from routes where company_id=$1 order by id desc',[cid])]);
  res.json({compositions:compositions.filter(c=>c.active),trucks:trucks.rows,drivers:drivers.rows,clients:clients.rows,routes:routes.rows});
 });
 route('get',OPS+'/:id/resources',requirePermission('trips.manage'),async(req,res,cid)=>{
  const trip=(await pool.query('select * from trips where id=$1 and company_id=$2',[E.id(req.params.id),cid])).rows[0];if(!trip)throw E.fail('Viaje no encontrado',404);
  const page=E.id(req.query.page||1),history=(await pool.query(`select h.*,lead(h.effective_at) over(order by h.version) effective_until
   from trip_resource_revisions h where h.trip_id=$1 and h.company_id=$2 order by h.version desc limit 25 offset $3`,[trip.id,cid,(page-1)*25])).rows;
  const total=(await pool.query('select count(*)::int total from trip_resource_revisions where trip_id=$1 and company_id=$2',[trip.id,cid])).rows[0].total;
  res.json({trip,current:await observedResources(pool,cid,trip),history,total,page,page_size:25});
 });
 route('patch',OPS+'/:id/resources',requirePermission('trips.manage'),async(req,res,cid)=>{
  const b=req.body||{},allowed=new Set(['resource_version','composition_id','composition_version','truck_id','trailer_id','driver_id','client_id','route_id','reason']);
  if(Object.keys(b).some(k=>!allowed.has(k)))throw E.fail('Campo de asignación no permitido');
  if(!Object.hasOwn(b,'composition_id'))throw E.fail('Indica conjunto o asignación individual explícitamente');
  if(!Object.hasOwn(b,'driver_id'))throw E.fail('Indica el conductor o su asignación pendiente explícitamente');
  const requestedDriver=E.id(b.driver_id,'Conductor',{optional:true}),requestedVersion=E.id(b.resource_version,'Versión de asignación',{zero:true});
  const db=await pool.connect();try{
   await db.query('BEGIN');
   const own=(await db.query('select id from trips where id=$1 and company_id=$2',[E.id(req.params.id),cid])).rows[0];if(!own)throw E.fail('Viaje no encontrado',404);
   // Match the PWA order: personnel -> trip -> vehicles (sorted by id).
   if(requestedDriver)await assertDriverOperationalReady(db,{companyId:cid,driverId:requestedDriver,lock:true});
   const current=(await db.query('select * from trips where id=$1 and company_id=$2 for update',[E.id(req.params.id),cid])).rows[0];if(!current)throw E.fail('Viaje no encontrado',404);
   if(terminal(current.status))throw E.fail('No se reasignan recursos de un viaje completado o cancelado',409);
   if(requestedVersion!==current.resource_version)throw E.fail('La asignación cambió. Actualiza el viaje antes de guardar.',409,'EQUIPMENT_ASSIGNMENT_CONFLICT');
   const compositionId=E.id(b.composition_id,'Conjunto',{optional:true});let selected=null;
   if(compositionId){selected=(await db.query('select * from fleet_compositions where id=$1 and company_id=$2 for share',[compositionId,cid])).rows[0];
    if(!selected||!selected.active)throw E.fail('Conjunto no disponible en la empresa',409);
    if(E.id(b.composition_version,'Versión del conjunto')!==selected.version)throw E.fail('La composición cambió. Selecciónala nuevamente.',409,'COMPOSITION_CONFLICT');
   }
   const truckId=selected?selected.truck_id:E.id(b.truck_id,'Vehículo principal',{optional:true}),trailerId=selected?selected.trailer_id:E.id(b.trailer_id,'Remolque',{optional:true});
   if(selected&&['truck_id','trailer_id'].some(k=>Object.hasOwn(b,k)&&String(E.id(b[k],k,{optional:true})||'')!==String(selected[k]||'')))throw E.fail('Los componentes enviados no coinciden con el conjunto seleccionado');
   const read=k=>Object.hasOwn(b,k)?b[k]:current[k];
   const driverId=requestedDriver,clientId=E.id(read('client_id'),'Cliente'),routeId=E.id(read('route_id'),'Ruta',{optional:true});
   if(trailerId&&!truckId)throw E.fail('El remolque requiere un vehículo principal');
   const activation=current.status==='Planificado'?null:activationError({truck_id:truckId,driver_id:driverId},'Asignado');if(activation)throw E.fail(activation,409);
   if(!(await db.query('select id from clients where id=$1 and company_id=$2 and active=true for share',[clientId,cid])).rows.length)throw E.fail('Selecciona un cliente activo de la empresa',403);
   if(routeId&&!(await db.query('select id from routes where id=$1 and company_id=$2',[routeId,cid])).rows.length)throw E.fail('La ruta no pertenece a la empresa',403);
   const changed=String(current.truck_id||'')!==String(truckId||'')||String(current.trailer_id||'')!==String(trailerId||'')||String(current.driver_id||'')!==String(driverId||'')||String(current.client_id||'')!==String(clientId)||String(current.route_id||'')!==String(routeId||'')||String(current.composition_id||'')!==String(compositionId||'');
   const reason=b.reason?E.text(b.reason,'Motivo'):null;
   const catalogChanged=selected&&Number(current.composition_snapshot?.composition_version)!==Number(selected.version);
   if((changed||catalogChanged)&&(inExecution(current)||current.resource_version>0)&&!reason)throw E.fail('Indica el motivo del reemplazo o cambio de recursos');
   const before=await observedResources(db,cid,current);
   await assertTripResourcesReady(db,{companyId:cid,truckId,driverId,trailerId,tripId:current.id,status:current.status,plannedDeparture:current.planned_departure,plannedArrival:current.planned_arrival,effectiveFrom:new Date().toISOString()});
   const rows=await vehicles(db,cid,[truckId,trailerId]);let equipment=null;
   if(truckId)equipment=equipmentSnapshot(selected||{truck_id:truckId,trailer_id:trailerId},rows);
   if(selected)E.windowCheck(equipment,{status:current.status,plannedDeparture:current.planned_departure,plannedArrival:current.planned_arrival});
   const nextVersion=current.resource_version+1;
   const next=(await db.query(`update trips set truck_id=$1,trailer_id=$2,driver_id=$3,client_id=$4,route_id=$5,composition_id=$6,composition_snapshot=$7,resource_version=$8,
    status=case when status='Planificado' and $1::integer is not null and $3::integer is not null then 'Asignado' else status end,updated_at=now()
    where id=$9 and company_id=$10 returning *`,[truckId,trailerId,driverId,clientId,routeId,compositionId,equipment,nextVersion,current.id,cid])).rows[0];
   if(current.resource_version===0)await revision(db,req,current,0,before,'Estado observado antes de iniciar el historial versionado; fecha inicial desconocida',true);
   const after=await observedResources(db,cid,next);await revision(db,req,next,nextVersion,after,reason||'Asignación de recursos');
   if(next.status!==current.status)await db.query('insert into trip_status_history(trip_id,from_status,to_status,notes,created_by) values($1,$2,$3,$4,$5)',[next.id,current.status,next.status,reason||'Recursos asignados',req.user.id]);
   await db.query('insert into trip_events(trip_id,event_type,notes,created_by,details) values($1,$2,$3,$4,$5)',[next.id,changed?'Reasignación de recursos':'Confirmación de recursos',reason||'Asignación de recursos',req.user.id,{before,after,resource_version:nextVersion}]);
   await writeAudit(db,req,{companyId:cid,action:'assign_resources',entity:'trip',entityId:next.id,beforeData:before,afterData:{...after,resource_version:nextVersion,reason}});
   await syncResourceAlert(db,next);await db.query('COMMIT');res.json({trip:next,current:after});
  }catch(e){await db.query('ROLLBACK');if(e.status)throw e;return resourceFailure(res,e,'No se pudo guardar la asignación; no se confirmó ningún cambio');}finally{db.release();}
 });
}
module.exports={registerEquipmentRoutes,equipmentSnapshot};
