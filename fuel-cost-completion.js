'use strict';
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const {provision}=require('./fuel-registration');
const {recognize}=require('./fuel-cost-policy');
const fail=(status,message)=>Object.assign(Error(message),{status});
const positiveId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
function registerFuelCostCompletion(app,pool){
 app.post('/api/fleet/fuel/from-cost/:id',requirePermission('fuel.manage'),requirePermission('economics.manage'),async(req,res)=>{
  let db;
  try{
   const actor=resolveActorContext(req),cid=actor?.scope==='company'?actor.company_id:null,b=req.body||{};
   if(!cid)throw fail(403,'Selecciona una empresa autorizada');
   if(!positiveId(req.params.id)||!positiveId(b.truck_id)||!Number.isSafeInteger(b.expected_version_id))throw fail(400,'Selecciona costo, versión y camión válidos');
   const liters=Number(b.liters),odometer=Number(b.odometer_km);
   if(!['number','string'].includes(typeof b.liters)||!Number.isFinite(liters)||liters<=0||!['number','string'].includes(typeof b.odometer_km)||String(b.odometer_km).trim()===''||!Number.isFinite(odometer)||odometer<0)throw fail(400,'Indica litros positivos y odómetro válido');
   if(typeof b.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.date)||Number.isNaN(Date.parse(b.date))||new Date(b.date).toISOString().slice(0,10)!==b.date)throw fail(400,'Indica la fecha real del abastecimiento');
   const p=provision({...b,valuation_pending:true,price_clp:null});
   db=await pool.connect();await db.query('BEGIN');
   await db.query("select commercial_require($1,'fuel'),commercial_require($1,'economics')",[cid]);
   // Obtain the trip first, then serialize the financial operation before locking the item.
   const lookup=(await db.query('select trip_id from trip_cost_items where id=$1 and company_id=$2',[req.params.id,cid])).rows[0];
   if(!lookup)throw fail(404,'Costo no encontrado');
   const trip=(await db.query('select * from trips where id=$1 and company_id=$2 for update',[lookup.trip_id,cid])).rows[0];
   const control=(await db.query('select state from trip_finance_control where trip_id=$1 and company_id=$2 for update',[trip.id,cid])).rows[0];
   if(!control||control.state==='closed')throw fail(409,'Reabre el control económico antes de completar el abastecimiento');
   const item=(await db.query(`select i.*,c.code from trip_cost_items i join economic_cost_categories c on c.id=i.category_id where i.id=$1 and i.company_id=$2 for update of i`,[req.params.id,cid])).rows[0];
   if(item.status==='voided'||item.code!=='fuel')throw fail(409,'El costo debe ser combustible vigente');
   let version=(await db.query('select * from trip_cost_versions where id=$1 and company_id=$2 for update',[item.current_version_id,cid])).rows[0];
   if(String(version.id)!==String(b.expected_version_id))throw fail(409,'El costo cambió. Recarga antes de completar');
   if(!['observed','allocated'].includes(version.cost_basis)||!['draft','approved','reconciled'].includes(version.status)||Number(version.amount_clp)<=0)throw fail(409,'Se requiere un gasto real positivo, no un presupuesto ni una autorización pendiente');
   if((await db.query('select id from economic_source_allocations where cost_item_id=$1',[item.id])).rows.length)throw fail(409,'Este costo ya tiene un origen o historial de asignación. Revisa su vínculo existente');
   const truck=(await db.query('select id,patente from trucks where id=$1 and company_id=$2 for share',[b.truck_id,cid])).rows[0];
   if(!truck)throw fail(404,'Camión no encontrado');
   const fuel=(await db.query(`insert into fuel(company_id,date,truck,truck_id,liters,price_clp,total_clp,station,odometer_km,supply_type,payment_method,receipt_reference)
    values($1,$2,$3,$4,$5,$6::numeric/$5::numeric,$6,$7,$8,$9,$10,$11) returning *`,[cid,b.date,truck.patente,truck.id,liters,version.amount_clp,typeof b.station==='string'?b.station.trim().slice(0,200):null,odometer,p.supply,p.payment,p.reference])).rows[0];
   const source=(await db.query(`insert into economic_sources(company_id,kind,provider,reference,fuel_id,truck_id,occurred_on,amount_clp,includes_vat,description,original,created_by)
    values($1,'fuel','fuel',$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[cid,String(fuel.id),fuel.id,truck.id,b.date,version.amount_clp,version.amount_includes_vat,version.description||'Abastecimiento completado desde gasto existente',JSON.stringify({fuel_id:fuel.id,cost_item_id:item.id,cost_version_id:version.id,trip_id:trip.id,unit_price:'calculated_from_total_and_liters'}),req.user.id])).rows[0];
   const before={...version};
   if(version.status!=='reconciled')version=await recognize(db,req,version,'fuel');
   const allocation=(await db.query('insert into economic_source_allocations(company_id,source_id,trip_id,cost_item_id,amount_clp,reason,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[cid,source.id,trip.id,item.id,version.amount_clp,'Completar abastecimiento sin duplicar el costo original',req.user.id])).rows[0];
   await writeAudit(db,req,{companyId:cid,action:'complete',entity:'fuel',entityId:fuel.id,beforeData:{cost_version:before},afterData:{fuel,source,allocation,cost_version:version}});
   await db.query('COMMIT');res.status(201).json({...fuel,economic_link:{trip_id:trip.id,cost_item_id:item.id,source_id:source.id}});
  }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}res.status(e.status||(/^P75/.test(e.code||'')?403:['23505','55000'].includes(e.code)?409:503)).json({error:e.status?e.message:/^P75/.test(e.code||'')?'La licencia no habilita esta operación':'No se pudo completar el abastecimiento; recarga y revisa el vínculo existente'});}finally{db?.release();}
 });
}
module.exports={registerFuelCostCompletion};
