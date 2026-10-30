'use strict';
const {requirePermission,resolveActorContext}=require('./auth'),{writeAudit}=require('./audit'),Entry=require('./fuel-entry');
const fail=(status,message)=>Object.assign(Error(message),{status});
function registerFuelCorrections(app,pool){
 app.post('/api/fleet/fuel/:id/corrections',requirePermission('fuel.manage'),requirePermission('economics.manage'),async(req,res)=>{
  let db;
  try{
   const actor=resolveActorContext(req),cid=actor?.company_id,b=req.body||{},input=Entry.parse(b);
   if(!cid)throw fail(400,'Selecciona una empresa para rectificar');
   if(typeof b.reason!=='string'||b.reason.trim().length<5||b.reason.length>1000)throw fail(400,'Indica el motivo de la rectificación (5 a 1000 caracteres)');
   if(!Number.isSafeInteger(b.version)||b.version<0)throw fail(400,'Versión no válida');
   db=await pool.connect();await db.query('BEGIN');
   // Same lock order as registration: trip, financial control, fuel and source.
   const associations=(await db.query(`select a.* from economic_sources s join economic_source_allocations a on a.source_id=s.id and a.company_id=s.company_id where s.fuel_id=$1 and s.company_id=$2 and not exists(select 1 from economic_source_reversals r where r.allocation_id=a.id)`,[req.params.id,cid])).rows;
   if(associations.length!==1)throw fail(409,'Esta rectificación requiere un abastecimiento imputado íntegramente a un solo viaje');
   const a=associations[0];
   const trip=(await db.query('select * from trips where id=$1 and company_id=$2 for update',[a.trip_id,cid])).rows[0];
   const control=(await db.query('select state from trip_finance_control where trip_id=$1 and company_id=$2 for update',[a.trip_id,cid])).rows[0];
   if(!trip||control?.state!=='open')throw fail(409,'Reabre el control económico antes de rectificar');
   const old=(await db.query('select * from fuel where id=$1 and company_id=$2 for update',[req.params.id,cid])).rows[0];
   if(!old)throw fail(404,'Abastecimiento no disponible');
   if(Number(old.valuation_version)!==b.version|| (await db.query('select 1 from fuel_corrections where previous_fuel_id=$1',[old.id])).rows.length)throw fail(409,'El registro cambió. Actualiza antes de rectificar');
   await db.query("select commercial_require($1,'fuel',$2),commercial_require($1,'economics')",[cid,old.truck_id]);
   const source=(await db.query('select * from economic_sources where id=$1 and company_id=$2 for update',[a.source_id,cid])).rows[0];
   const active=(await db.query('select a.* from economic_source_allocations a where source_id=$1 and not exists(select 1 from economic_source_reversals r where r.allocation_id=a.id)',[source.id])).rows;
   if(active.length!==1||String(active[0].id)!==String(a.id)||Number(a.amount_clp)!==Number(source.amount_clp))throw fail(409,'El origen tiene un reparto o fue modificado. Revisa sus asignaciones');
   if(String(trip.truck_id)!==String(old.truck_id))throw fail(409,'El camión del viaje cambió. Revisa el historial antes de rectificar');
   const item=(await db.query('select * from trip_cost_items where id=$1 and company_id=$2 for update',[a.cost_item_id,cid])).rows[0];
   if(!item||item.status==='voided'||(await db.query("select 1 from economic_authorization_requests q join trip_cost_versions v on v.id=q.cost_version_id where v.trip_cost_item_id=$1 and q.status='pending'",[item.id])).rows.length)throw fail(409,'El costo tiene una condición pendiente de resolver');
   const truck=(await db.query('select id,patente from trucks where id=$1 and company_id=$2',[old.truck_id,cid])).rows[0];
   const fuel=await Entry.insert(db,cid,truck,input);
   await db.query('insert into fuel_inherited_support(company_id,fuel_id,entry_id) select company_id,$1,entry_id from financial_support_links where company_id=$2 and kind=\'fuel\' and target_id=$3',[fuel.id,cid,old.id]);
   await db.query('insert into economic_source_reversals(company_id,trip_id,allocation_id,reason,created_by) values($1,$2,$3,$4,$5)',[cid,a.trip_id,a.id,b.reason.trim(),req.user.id]);
   await db.query("update trip_cost_items set status='voided' where id=$1",[item.id]);
   const link=await require('./fuel-cost-policy').linkFuel(db,req,fuel,Number(trip.id));
   await db.query('insert into fuel_corrections(company_id,previous_fuel_id,fuel_id,reason,created_by) values($1,$2,$3,$4,$5)',[cid,old.id,fuel.id,b.reason.trim(),req.user.id]);
   await writeAudit(db,req,{companyId:cid,action:'correct',entity:'fuel',entityId:fuel.id,beforeData:old,afterData:{...fuel,economic_link:link,previous_fuel_id:old.id,reason:b.reason.trim()}});
   await db.query('COMMIT');res.status(201).json({...fuel,economic_link:link,previous_fuel_id:old.id});
  }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}res.status(e.status|| (e.code==='55000'||e.code==='23505'?409:/^P75/.test(e.code||'')?403:503)).json({error:e.status?e.message:'No se confirmó la rectificación; actualiza y revisa el registro'});}finally{db?.release();}
 });
}
module.exports={registerFuelCorrections};
