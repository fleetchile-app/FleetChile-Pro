'use strict';

// Only real fuel/toll costs entered through an authorized administrative path.
// Budgets and the authorization rules for other categories remain unchanged.
const simpleCost = (category, basis) => ['fuel', 'toll'].includes(category) && ['observed', 'allocated'].includes(basis);
async function recognize(db, req, version, category) {
 if (!simpleCost(category, version.cost_basis)) return version;
 const reason = 'Registro directo autorizado de combustible/peaje; sin aprobación adicional';
 const row = (await db.query("update trip_cost_versions set status='reconciled',reconciled_by=$2,reconciled_at=now(),reconciliation_reason=$3 where id=$1 returning *", [version.id, req.user.id, reason])).rows[0];
 if (!row) throw Error('No se pudo reconocer el gasto');
 return row;
}

async function linkFuel(db, req, fuel, tripId) {
 if (!Number.isSafeInteger(tripId) || tripId < 1) throw Object.assign(Error('Viaje no válido'), {status:400});
 // The fuel endpoint is gated as "fuel"; economic writes also need the paid module.
 await db.query("select commercial_require($1,'economics')",[fuel.company_id]);
 const trip = (await db.query('select * from trips where id=$1 and company_id=$2 for update', [tripId, fuel.company_id])).rows[0];
 if (!trip || String(trip.truck_id) !== String(fuel.truck_id)) throw Object.assign(Error('Selecciona un viaje del camión y de la empresa del abastecimiento'), {status:409});
 if (fuel.total_clp == null) throw Object.assign(Error('Para imputar al viaje indica el precio; un importe pendiente no se considera cero'), {status:400});
 const control = (await db.query('select state from trip_finance_control where trip_id=$1 and company_id=$2 for update',[trip.id,fuel.company_id])).rows[0];
 if (!control || control.state === 'closed') throw Object.assign(Error('Reabre el control económico antes de imputar combustible'), {status:409});
 const source = (await db.query("insert into economic_sources(company_id,kind,provider,reference,fuel_id,truck_id,occurred_on,amount_clp,includes_vat,description,original,created_by) values($1,'fuel','fuel',$2,$3,$4,$5,$6,null,$7,$8,$9) returning *", [fuel.company_id,String(fuel.id),fuel.id,fuel.truck_id,fuel.date,fuel.total_clp,'Abastecimiento registrado en el viaje',JSON.stringify({fuel_id:fuel.id,liters:fuel.liters,total_clp:fuel.total_clp}),req.user.id])).rows[0];
 return linkSource(db,req,source,trip.id);
}

// Caller holds the open trip financial-control lock, in the same transaction.
async function linkSource(db, req, source, tripId) {
 const cat = (await db.query('select id from economic_cost_categories where code=$1 and active=true',[source.kind])).rows[0];
 if (!cat) throw Object.assign(Error('Categoría inactiva'), {status:409});
 const item = (await db.query('insert into trip_cost_items(company_id,trip_id,category_id,created_by) values($1,$2,$3,$4) returning *', [source.company_id,tripId,cat.id,req.user.id])).rows[0];
 let version = (await db.query("insert into trip_cost_versions(company_id,trip_cost_item_id,version_number,cost_basis,amount_clp,amount_includes_vat,description,status,created_by) values($1,$2,1,'allocated',$3,$4,$5,'draft',$6) returning *", [source.company_id,item.id,source.amount_clp,source.includes_vat,source.description,req.user.id])).rows[0];
 version = await recognize(db,req,version,source.kind);
 await db.query('update trip_cost_items set current_version_id=$1 where id=$2',[version.id,item.id]);
 const allocation = (await db.query('insert into economic_source_allocations(company_id,source_id,trip_id,cost_item_id,amount_clp,reason,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[source.company_id,source.id,tripId,item.id,source.amount_clp,'Registro directo en el viaje',req.user.id])).rows[0];
 await require('./audit').writeAudit(db,req,{companyId:source.company_id,action:'create',entity:'trip_source_cost',entityId:item.id,afterData:{source,allocation,version}});
 return {trip_id:tripId,cost_item_id:item.id,source_id:source.id};
}
module.exports = {simpleCost,recognize,linkFuel,linkSource};
