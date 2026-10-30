'use strict';
const {requirePermission,resolveActorContext,reauthenticateUser}=require('./auth');
const {writeAudit}=require('./audit');
const E=require('./equipment-domain'),F=require('./finance-domain');
const BASE='/api/economics/trips/:id/finance',SOURCES='/api/economics/sources';
function company(req){const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id)throw E.fail('Selecciona una empresa',403);return a.company_id;}
async function control(db,cid,tripId,lock=false){const c=(await db.query(`select * from trip_finance_control where company_id=$1 and trip_id=$2${lock?' for update':''}`,[cid,tripId])).rows[0];if(!c)throw E.fail('Viaje no encontrado',404);return c;}
function open(c,version){if(c.state==='closed')throw E.fail('Reabre el cierre económico con motivo antes de modificar',409,'FINANCE_CLOSED');if(E.id(version,'Versión financiera',{zero:true})!==Number(c.version))throw E.fail('La información económica cambió. Recarga antes de guardar.',409,'FINANCE_STALE');}
async function view(db,cid,tripId){
 const trip=(await db.query('select * from trips where id=$1 and company_id=$2',[tripId,cid])).rows[0];if(!trip)throw E.fail('Viaje no encontrado',404);
 const [profile,costs,loads,budgets,distributions,sources,events]=await Promise.all([
  db.query('select * from trip_economic_profiles where trip_id=$1 and company_id=$2',[tripId,cid]),
  db.query(`select i.id,i.status item_status,c.code category_code,c.cost_group,v.id version_id,v.version_number,v.cost_basis,v.amount_clp,v.amount_includes_vat,v.status,v.effective_date,v.description,(select count(*)::int from financial_support_links sl join financial_support_entries se on se.id=sl.entry_id where sl.company_id=i.company_id and sl.kind='cost' and sl.target_id=v.id and se.storage_key is not null) attachment_count from trip_cost_items i join economic_cost_categories c on c.id=i.category_id join trip_cost_versions v on v.id=i.current_version_id and v.trip_cost_item_id=i.id and v.company_id=i.company_id where i.trip_id=$1 and i.company_id=$2 order by i.id`,[tripId,cid]),
  db.query('select l.id,l.client_id,l.cargo,c.name client_name from trip_loads l join clients c on c.id=l.client_id and c.company_id=$2 where l.trip_id=$1 order by l.id',[tripId,cid]),
  db.query('select * from trip_budget_revisions where trip_id=$1 and company_id=$2 order by version desc limit 10',[tripId,cid]),
  db.query('select * from trip_distribution_revisions where trip_id=$1 and company_id=$2 order by version desc limit 10',[tripId,cid]),
  db.query('select a.*,s.kind,s.provider,s.reference,s.occurred_on,s.fuel_id,s.includes_vat,x.id reversal_id from economic_source_allocations a join economic_sources s on s.id=a.source_id and s.company_id=a.company_id left join economic_source_reversals x on x.allocation_id=a.id where a.trip_id=$1 and a.company_id=$2 order by a.id',[tripId,cid]),
  db.query('select * from trip_finance_events where trip_id=$1 and company_id=$2 order by id desc limit 20',[tripId,cid])
 ]);
 const p=profile.rows[0]||null,summary=F.summarize(trip,p,costs.rows),basis=F.basis(trip,p,costs.rows,loads.rows),basisHash=F.hash(basis),latest=distributions.rows[0]||null;
 const authorizations=(await db.query("select * from economic_authorization_requests where company_id=$1 and trip_id=$2 and status='pending' order by id",[cid,tripId])).rows,pendingAuth=authorizations.length;
 if(summary.delta_status==='reconciled'&&(p?.tag_pending||pendingAuth))summary.delta_status='provisional';
 const comparison=(budgets.rows[0]?.entries||[]).map(b=>{const observed=costs.rows.filter(c=>c.category_code===b.category_code&&F.recognized(c)),comparable=b.includes_vat!=null&&observed.length>0&&observed.every(c=>c.amount_includes_vat===b.includes_vat),actual=observed.length?F.sum(observed.map(c=>c.amount_clp)):null;return {...b,actual_clp:actual,comparable,variance_clp:comparable?actual-Number(b.amount_clp):null};});
 const blockers=[];if(!['Completado','Cancelado'].includes(trip.status))blockers.push('El servicio todavía no ha terminado operacionalmente');
 if(summary.revenue_clp==null)blockers.push('Ingreso sin confirmar');if(summary.recognized_costs_clp==null)blockers.push('Costos sin confirmar: registra y concilia un costo cero explícito si corresponde');
 if(summary.pending_items||pendingAuth)blockers.push('Hay costos o autorizaciones pendientes');if(costs.rows.some(c=>F.recognized(c)&&c.status!=='reconciled'))blockers.push('Hay costos reconocidos sin conciliar');
 if(p?.tag_pending)blockers.push('Hay TAG o peajes pendientes');
 if(loads.rows.length>1&&(!latest||latest.basis_hash!==basisHash))blockers.push('Falta distribución vigente por carga/cliente');
 return {trip:{id:trip.id,trip_number:trip.trip_number,status:trip.status,truck_id:trip.truck_id},control:await control(db,cid,tripId),profile:p,summary,costs:costs.rows,loads:loads.rows,budgets:budgets.rows,comparison,distributions:distributions.rows,distribution_stale:!!latest&&latest.basis_hash!==basisHash,basis,basis_hash:basisHash,sources:sources.rows,events:events.rows,authorizations,close_blockers:blockers};
}
function registerFinanceRoutes(app,pool){
 const route=(method,path,permission,work)=>app[method](path,requirePermission(permission),async(req,res)=>{try{await work(req,res,company(req));}catch(e){res.status(e.status||(e.code==='23505'||e.code==='55000'?409:500)).json({code:e.code||'FINANCE_ERROR',error:e.status?e.message:e.code==='23505'?'El registro ya existe; recarga para evitar duplicarlo':e.code==='55000'?e.message:'No se pudo procesar la operación económica'});}});
 const transaction=async work=>{const db=await pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
 const read=async(cid,id)=>{const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const data=await view(db,cid,id);await db.query('COMMIT');return data;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
 route('get',BASE,'economics.read',async(req,res,cid)=>res.json(await read(cid,E.id(req.params.id))));
 route('get',BASE+'/export','economics.export',async(req,res,cid)=>{
  const data=await read(cid,E.id(req.params.id)),rows=data.distributions[0]?.entries||[],fields=['load_id','client_id','cargo','revenue_clp','cost_clp','delta_clp'];
  const cell=F.csvCell;
  res.type('text/csv').set('Content-Disposition','attachment; filename="fleetchile-distribution-'+req.params.id+'.csv"').send([['version','stale',...fields].join(','),...rows.map(r=>[data.distributions[0].version,data.distribution_stale,...fields.map(k=>r[k])].map(cell).join(','))].join('\r\n'));
 });
 route('post',BASE+'/budget','economics.manage',async(req,res,cid)=>{
  const b=req.body||{},entries=F.budget(b.entries),reason=E.text(b.reason,'Motivo');
  res.status(201).json(await transaction(async db=>{const c=await control(db,cid,E.id(req.params.id),true);open(c,b.version);
   const codes=(await db.query("select code from economic_cost_categories where active=true and cost_group='direct'",[])).rows;
   if(entries.some(e=>!codes.some(c=>c.code===e.category_code)))throw E.fail('Categoría de presupuesto no disponible');
   const n=Number((await db.query('select coalesce(max(version),0)+1 n from trip_budget_revisions where trip_id=$1 and company_id=$2',[c.trip_id,cid])).rows[0].n);
   const row=(await db.query('insert into trip_budget_revisions(company_id,trip_id,version,entries,reason,created_by,actor_name) values($1,$2,$3,$4,$5,$6,$7) returning *',[cid,c.trip_id,n,JSON.stringify(entries),reason,req.user.id,req.user.name||'Usuario autenticado'])).rows[0];
   await writeAudit(db,req,{companyId:cid,action:'create',entity:'trip_budget',entityId:row.id,afterData:row});return row;
  }));
 });
 route('post',BASE+'/distribution','economics.manage',async(req,res,cid)=>{
  const b=req.body||{},reason=E.text(b.reason,'Criterio y motivo del reparto');
  res.status(201).json(await transaction(async db=>{const c=await control(db,cid,E.id(req.params.id),true);open(c,b.version);const data=await view(db,cid,c.trip_id),entries=F.distribution(b.entries,data.loads,data.summary);
   if(b.basis_hash!==data.basis_hash)throw E.fail('Cambió la base del reparto; recarga antes de guardar',409,'FINANCE_STALE');
   const n=Number((await db.query('select coalesce(max(version),0)+1 n from trip_distribution_revisions where trip_id=$1 and company_id=$2',[c.trip_id,cid])).rows[0].n);
   const row=(await db.query('insert into trip_distribution_revisions(company_id,trip_id,version,entries,basis_hash,basis,reason,created_by,actor_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[cid,c.trip_id,n,JSON.stringify(entries),data.basis_hash,data.basis,reason,req.user.id,req.user.name||'Usuario autenticado'])).rows[0];
   await writeAudit(db,req,{companyId:cid,action:'create',entity:'trip_distribution',entityId:row.id,afterData:row});return row;
  }));
 });
 route('post',BASE+'/pending-tolls','economics.manage',async(req,res,cid)=>{
  const b=req.body||{},reason=E.text(b.reason,'Motivo');if(typeof b.pending!=='boolean')throw E.fail('Estado de TAG pendiente no válido');
  res.json(await transaction(async db=>{const c=await control(db,cid,E.id(req.params.id),true);open(c,b.version);
   await db.query("insert into trip_economic_profiles(trip_id,company_id,tag_pending) values($1,$2,$3) on conflict(trip_id) do update set tag_pending=excluded.tag_pending,updated_at=now()",[c.trip_id,cid,b.pending]);
   await writeAudit(db,req,{companyId:cid,action:'update',entity:'trip_tag_pending',entityId:c.trip_id,afterData:{pending:b.pending,reason}});return {pending:b.pending};
  }));
 });
 for(const action of ['close','reopen'])route('post',BASE+'/'+action,'economics.close',async(req,res,cid)=>{
  const b=req.body||{},reason=E.text(b.reason,'Motivo');if(!await reauthenticateUser(pool,req.user.id,b.password))throw E.fail('Reautenticación inválida',401);
  res.json(await transaction(async db=>{const c=await control(db,cid,E.id(req.params.id),true);
   if(Number(c.version)!==E.id(b.version,'Versión',{zero:true}))throw E.fail('La ficha económica cambió. Recarga antes de confirmar.',409);
   if((action==='close'&&c.state==='closed')||(action==='reopen'&&c.state!=='closed'))throw E.fail('El estado económico ya cambió',409);
   const data=await view(db,cid,c.trip_id);if(action==='close'&&data.close_blockers.length)throw E.fail(data.close_blockers.join('. '),409,'FINANCE_INCOMPLETE');
   const snapshot={trip:data.trip,control:data.control,profile:data.profile,summary:data.summary,costs:data.costs,loads:data.loads,sources:data.sources,budget:data.budgets[0]||null,distribution:data.distributions[0]||null,basis_hash:data.basis_hash};
   if(action==='reopen')await db.query("update trip_finance_control set state='open',version=version+1 where trip_id=$1 and company_id=$2",[c.trip_id,cid]);
   await db.query("insert into trip_economic_profiles(trip_id,company_id,economic_status) values($1,$2,$3) on conflict(trip_id) do update set economic_status=excluded.economic_status,updated_at=now()",[c.trip_id,cid,action==='close'?'closed':'open']);
   if(action==='close')await db.query("update trip_finance_control set state='closed',version=version+1 where trip_id=$1 and company_id=$2",[c.trip_id,cid]);
   const row=(await db.query('insert into trip_finance_events(company_id,trip_id,kind,reason,snapshot,created_by,actor_name) values($1,$2,$3,$4,$5,$6,$7) returning *',[cid,c.trip_id,action,reason,snapshot,req.user.id,req.user.name||'Usuario autenticado'])).rows[0];
   await writeAudit(db,req,{companyId:cid,action,entity:'trip_finance',entityId:c.trip_id,afterData:row});return {state:action==='close'?'closed':'open',event_id:row.id};
  }));
 });
 route('get',SOURCES,'economics.read',async(req,res,cid)=>{
  const page=E.id(req.query.page||1,'Página');res.json({rows:(await pool.query('select s.*,coalesce(a.used,0) allocated_clp,s.amount_clp-coalesce(a.used,0) remaining_clp from economic_sources s left join (select a.source_id,sum(a.amount_clp) used from economic_source_allocations a where not exists(select 1 from economic_source_reversals x where x.allocation_id=a.id) group by a.source_id) a on a.source_id=s.id where s.company_id=$1 order by s.id desc limit 25 offset $2',[cid,(page-1)*25])).rows,page,page_size:25});
 });
 route('get',SOURCES+'/fuel-options','economics.read',async(req,res,cid)=>{
  const page=E.id(req.query.page||1,'Página');res.json({rows:(await pool.query('select f.id,f.date,f.truck,f.total_clp,f.station from fuel f where f.company_id=$1 and f.total_clp is not null and not exists(select 1 from economic_sources s where s.fuel_id=f.id) order by f.id desc limit 25 offset $2',[cid,(page-1)*25])).rows,page,page_size:25});
 });
 route('post',SOURCES,'economics.manage',async(req,res,cid)=>{
  const b=req.body||{};if(!['fuel','toll'].includes(b.kind))throw E.fail('Origen no válido');if(b.includes_vat!==true&&b.includes_vat!==false&&b.includes_vat!==null)throw E.fail('Indica la condición de IVA');
  res.status(201).json(await transaction(async db=>{
   let fuel=null,amount,truckId,date,provider,reference,original;
   const directTrip=b.trip_id==null?null:E.id(b.trip_id,'Viaje');
   if(directTrip)open(await control(db,cid,directTrip,true),b.finance_version);
   if(b.kind==='fuel'){
    fuel=(await db.query('select * from fuel where id=$1 and company_id=$2 for update',[E.id(b.fuel_id,'Carga de combustible'),cid])).rows[0];if(!fuel)throw E.fail('Registro de combustible no encontrado',404);
    if(fuel.total_clp===null)throw E.fail('Completa la valoración del combustible antes de crear su origen económico',409);amount=F.money(fuel.total_clp);truckId=fuel.truck_id;date=fuel.date;provider='fuel';reference=String(fuel.id);original={fuel_id:fuel.id,date:fuel.date,truck_id:fuel.truck_id,total_clp:fuel.total_clp,liters:fuel.liters,station:fuel.station};
   }else{
    amount=F.money(b.amount_clp);truckId=E.id(b.truck_id,'Vehículo',{optional:true});date=b.occurred_on;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw E.fail('Fecha del peaje no válida');
    provider=E.text(b.provider,'Proveedor',100).toUpperCase();reference=E.text(b.reference,'Referencia única del comprobante',160).toUpperCase();original={provider,reference,amount_clp:amount,occurred_on:date};
   }
   if(truckId&&!(await db.query('select id from trucks where id=$1 and company_id=$2',[truckId,cid])).rows.length)throw E.fail('Vehículo ajeno a la empresa',403);
   const row=(await db.query('insert into economic_sources(company_id,kind,provider,reference,fuel_id,truck_id,occurred_on,amount_clp,includes_vat,description,original,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[cid,b.kind,provider,reference,fuel?.id||null,truckId,date,amount,b.includes_vat,E.text(b.description,'Descripción y respaldo',2000),original,req.user.id])).rows[0];
   const link=directTrip?await require('./fuel-cost-policy').linkSource(db,req,row,directTrip):null;
   await writeAudit(db,req,{companyId:cid,action:'create',entity:'economic_source',entityId:row.id,afterData:row});return {...row,...(link?{economic_link:link}:{})};
  }));
 });
 route('post',SOURCES+'/:sourceId/allocate','economics.manage',async(req,res,cid)=>{
  const b=req.body||{},tripId=E.id(b.trip_id,'Viaje'),amount=F.money(b.amount_clp),reason=E.text(b.reason,'Motivo y criterio de asignación');
  res.status(201).json(await transaction(async db=>{
   const c=await control(db,cid,tripId,true);open(c,b.version);
   const source=(await db.query('select * from economic_sources where id=$1 and company_id=$2 for update',[E.id(req.params.sourceId),cid])).rows[0];if(!source)throw E.fail('Origen no encontrado',404);
   if(Number(source.version)!==E.id(b.source_version,'Versión del origen',{zero:true}))throw E.fail('El saldo del origen cambió. Recarga antes de asignar.',409);
   let itemId;
   if(b.cost_item_id)itemId=E.id(b.cost_item_id,'Costo existente');else{
    const cat=(await db.query('select id from economic_cost_categories where code=$1 and active=true',[source.kind])).rows[0];if(!cat)throw E.fail('Categoría inactiva',409);
    const item=(await db.query("insert into trip_cost_items(company_id,trip_id,category_id,created_by) values($1,$2,$3,$4) returning *",[cid,tripId,cat.id,req.user.id])).rows[0];itemId=item.id;
    const version=(await db.query("insert into trip_cost_versions(company_id,trip_cost_item_id,version_number,cost_basis,amount_clp,amount_includes_vat,support_status,justification,description,status,created_by) values($1,$2,1,'allocated',$3,$4,null,$5,$6,'draft',$7) returning *",[cid,itemId,amount,source.includes_vat,reason,source.description,req.user.id])).rows[0];
    await require('./fuel-cost-policy').recognize(db,req,version,source.kind);
    await db.query('update trip_cost_items set current_version_id=$1 where id=$2',[version.id,itemId]);
   }
   const item=(await db.query('select * from trip_cost_items where id=$1 and trip_id=$2 and company_id=$3 for update',[itemId,tripId,cid])).rows[0];if(!item||item.status==='voided')throw E.fail('Costo no disponible en este viaje',403);
   const row=(await db.query('insert into economic_source_allocations(company_id,source_id,trip_id,cost_item_id,amount_clp,reason,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[cid,source.id,tripId,itemId,amount,reason,req.user.id])).rows[0];
   await writeAudit(db,req,{companyId:cid,action:'allocate',entity:'economic_source',entityId:source.id,afterData:row});return row;
  }));
 });
 route('post',SOURCES+'/:sourceId/allocations/:allocationId/reverse','economics.approve',async(req,res,cid)=>{
  const b=req.body||{},reason=E.text(b.reason,'Motivo de reversión');if(!await reauthenticateUser(pool,req.user.id,b.password))throw E.fail('Reautenticación inválida',401);
  res.json(await transaction(async db=>{
   const a=(await db.query('select * from economic_source_allocations where company_id=$1 and id=$2 and source_id=$3',[cid,E.id(req.params.allocationId),E.id(req.params.sourceId)])).rows[0];if(!a)throw E.fail('Asignación no encontrada',404);
   const c=await control(db,cid,a.trip_id,true);open(c,b.version);
   await db.query('select id from economic_sources where id=$1 and company_id=$2 for update',[a.source_id,cid]);
   const row=(await db.query('insert into economic_source_reversals(allocation_id,company_id,trip_id,reason,created_by) values($1,$2,$3,$4,$5) returning *',[a.id,cid,a.trip_id,reason,req.user.id])).rows[0];
   await db.query("update trip_cost_items set status='voided',updated_at=now() where id=$1 and trip_id=$2 and company_id=$3",[a.cost_item_id,a.trip_id,cid]);
   await db.query('update economic_sources set version=version+1 where id=$1',[a.source_id]);
   await writeAudit(db,req,{companyId:cid,action:'reverse',entity:'economic_source_allocation',entityId:a.id,afterData:row});return row;
  }));
 });
}
module.exports={registerFinanceRoutes,view};
