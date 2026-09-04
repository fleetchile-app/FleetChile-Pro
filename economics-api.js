const {requirePermission,resolveActorContext}=require('./auth');
const {reauthenticateUser}=require('./auth');
const {writeAudit}=require('./audit');

const isLegacyAdmin=req=>req.user?.actor_type==='legacy'&&req.user?.role_code==='admin'&&!req.user?.membership_id&&!req.user?.platform_membership_id;
const isAdmin=isLegacyAdmin;
const explicitCompanyId=req=>{
  const raw=req.body?.company_id??req.query?.company_id;
  if(raw===undefined||raw===null||raw==='')return null;
  const value=Number(raw);
  return Number.isInteger(value)&&value>0?value:null;
};
const scopedCompanyId=req=>{
  const actor=resolveActorContext(req);
  if(!actor)return null;
  if(actor.actor_type==='legacy')return explicitCompanyId(req)||actor.company_id||null;
  if(actor.scope!=='company'||(!actor.membership_id&&!actor.context_company_id)||!actor.company_id)return null;
  return actor.company_id;
};
const revenueStatus=(defined,value,legacy)=>legacy?'legacy_unverified':!defined?'not_informed':Number(value)===0?'confirmed_zero':'confirmed_positive';
const economicView=(trip,profile)=>{
  const legacy=!profile;
  const defined=profile?.revenue_defined===true;
  return {
    trip_id:trip.id,
    company_id:trip.company_id,
    revenue_clp:trip.revenue_clp===null?null:Number(trip.revenue_clp),
    revenue_defined:defined,
    revenue_status:revenueStatus(defined,trip.revenue_clp,legacy),
    revenue_includes_vat:profile?.revenue_includes_vat??null,
    revenue_confirmed_by:profile?.revenue_confirmed_by??null,
    revenue_confirmed_at:profile?.revenue_confirmed_at??null,
    economic_status:profile?.economic_status??null,
    actual_departure:trip.actual_departure??null,
    trip_status:trip.status,
    legacy_unverified:legacy
  };
};
const operationalDelta=({revenueClp,revenueDefined,recognizedCosts,hasRecognizedCosts,pending=false,distanceKm=null})=>{
  const revenueComplete=revenueDefined===true&&revenueClp!==null&&revenueClp!==undefined;
  const costsComplete=hasRecognizedCosts===true;
  const status=!revenueComplete||!costsComplete?'missing_data':pending?'provisional':'reconciled';
  const delta=status==='missing_data'?null:Number(revenueClp)-Number(recognizedCosts);
  return {delta_status:status,delta,delta_per_km:delta!==null&&distanceKm!==null?delta/distanceKm:null,revenue_complete:revenueComplete,costs_complete:costsComplete};
};
const COST_BASES=new Set(['planned','observed','allocated']);
const COST_SUPPORT=new Set(['documented','undocumented']);
const COST_STATUSES=new Set(['draft']);
const clean=v=>typeof v==='string'?v.trim():v;
const validDate=v=>v===undefined||v===null||v===''||(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(v))&&(()=>{const d=new Date(`${v}T00:00:00.000Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v})());
const kpiDate=v=>v===undefined||v===null||v===''?null:(validDate(v)?String(v):false);
function costInput(body={}){
  const amount=body.amount_clp;
  if(amount===undefined||amount===null||typeof amount==='boolean'||Array.isArray(amount)||typeof amount==='object'||!Number.isSafeInteger(Number(amount))||Number(amount)<0)return {error:'amount_clp debe ser un entero no negativo'};
  const vat=body.amount_includes_vat;
  if(vat!==undefined&&vat!==null&&typeof vat!=='boolean')return {error:'amount_includes_vat debe ser boolean o null'};
  const basis=clean(body.cost_basis);
  if(!COST_BASES.has(basis))return {error:'cost_basis no válido'};
  const support=body.support_status===undefined||body.support_status===null?null:clean(body.support_status);
  if(support!==null&&!COST_SUPPORT.has(support))return {error:'support_status no válido'};
  const description=body.description===undefined||body.description===null?null:clean(body.description);
  if(description!==null&&(!description||description.length>1000))return {error:'description no válida'};
  const justification=body.justification===undefined||body.justification===null?null:clean(body.justification);
  if(support==='undocumented'&&!justification)return {error:'justification es obligatoria para costos sin respaldo'};
  const effectiveDate=body.effective_date===undefined||body.effective_date===null||body.effective_date===''?null:body.effective_date;
  if(!validDate(effectiveDate))return {error:'effective_date no válida'};
  return {amount:Number(amount),vat:vat??null,basis,support,justification:justification||null,description,effectiveDate,status:'draft'};
}
const costView=row=>({...row,amount_clp:Number(row.amount_clp)});
async function createRevenueAuthorization(db,req,{companyId,trip,revenue,includesVat,reason}){
  const pending=(await db.query("select id from economic_authorization_requests where company_id=$1 and trip_id=$2 and request_type='revenue_change' and status='pending' for update",[companyId,trip.id])).rows[0];
  if(pending)return {existing:true,request:pending};
  const request=(await db.query(`insert into economic_authorization_requests(company_id,trip_id,request_type,requested_by,reason,previous_revenue_clp,requested_revenue_clp) values($1,$2,'revenue_change',$3,$4,$5,$6) returning *`,[companyId,trip.id,req.user.id,reason,trip.revenue_clp,revenue])).rows[0];
  await writeAudit(db,req,{companyId,action:'create',entity:'economic_authorization',entityId:request.id,afterData:{...request,revenue_includes_vat:includesVat}});
  return {existing:false,request};
}

function registerEconomicsRoutes(app,pool){
  app.get('/api/economics/authorizations',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{const r=await pool.query(`select a.*,u.name requested_by_name,r.name resolved_by_name from economic_authorization_requests a
      left join users u on u.id=a.requested_by left join users r on r.id=a.resolved_by
      where a.company_id=$1 order by a.requested_at desc,a.id desc`,[cid]);res.json(r.rows)}catch{res.status(500).json({error:'No se pudieron consultar las autorizaciones'})}
  });
  app.get('/api/economics/authorizations/:id',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{const r=await pool.query(`select a.*,u.name requested_by_name,r.name resolved_by_name from economic_authorization_requests a
      left join users u on u.id=a.requested_by left join users r on r.id=a.resolved_by where a.id=$1 and a.company_id=$2`,[req.params.id,cid]);if(!r.rowCount)return res.sendStatus(404);res.json(r.rows[0])}catch{res.status(500).json({error:'No se pudo consultar la autorización'})}
  });
  app.post('/api/economics/authorizations',requirePermission('economics.manage'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});
    const type=clean(req.body?.request_type),reason=clean(req.body?.reason);if(!['revenue_change','cost_version'].includes(type))return res.status(400).json({error:'request_type no válido'});if(!reason)return res.status(400).json({error:'El motivo es obligatorio'});
    const revenue=req.body?.requested_revenue_clp;if(type==='revenue_change'&&(revenue===undefined||!Number.isSafeInteger(Number(revenue))||Number(revenue)<0))return res.status(400).json({error:'requested_revenue_clp no válido'});
    const versionId=req.body?.cost_version_id;let db=null,open=false;
    try{db=await pool.connect();await db.query('BEGIN');open=true;const trip=(await db.query('select id,company_id from trips where id=$1 and company_id=$2 for update',[req.body?.trip_id,cid])).rows[0];if(!trip){await db.query('ROLLBACK');open=false;return res.sendStatus(404)}let version=null;if(type==='cost_version'){version=(await db.query(`select v.*,i.trip_id from trip_cost_versions v join trip_cost_items i on i.id=v.trip_cost_item_id and i.company_id=v.company_id where v.id=$1 and v.company_id=$2 and i.trip_id=$3 for update`,[versionId,cid,trip.id])).rows[0];if(!version){await db.query('ROLLBACK');open=false;return res.sendStatus(404)}if(!['draft'].includes(version.status)){await db.query('ROLLBACK');open=false;return res.status(409).json({error:'La versión ya no puede solicitar autorización'})}}
      const created=(await db.query(`insert into economic_authorization_requests(company_id,trip_id,request_type,requested_by,reason,cost_version_id,requested_revenue_clp) values($1,$2,$3,$4,$5,$6,$7) returning *`,[cid,trip.id,type,req.user.id,reason,type==='cost_version'?version.id:null,type==='revenue_change'?Number(revenue):null])).rows[0];if(version)await db.query('update trip_cost_versions set status=\'pending_approval\',authorization_request_id=$1 where id=$2 and company_id=$3',[created.id,version.id,cid]);await writeAudit(db,req,{companyId:cid,action:'create',entity:'economic_authorization',entityId:created.id,afterData:created});await db.query('COMMIT');open=false;res.status(201).json(created)}catch(e){if(open){try{await db.query('ROLLBACK')}catch{}}res.status(e.code==='23505'?409:500).json({error:'No se pudo crear la autorización'})}finally{if(db)db.release()}
  });
  async function resolveAuthorization(req,res,decision){const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});const reason=clean(req.body?.reason);if(!reason)return res.status(400).json({error:'El motivo de resolución es obligatorio'});if(!await reauthenticateUser(pool,req.user.id,req.body?.password))return res.status(401).json({error:'Reautenticación inválida'});let db=null,open=false;try{db=await pool.connect();await db.query('BEGIN');open=true;const a=(await db.query('select * from economic_authorization_requests where id=$1 and company_id=$2 for update',[req.params.id,cid])).rows[0];if(!a){await db.query('ROLLBACK');open=false;return res.sendStatus(404)}if(a.status!=='pending'){await db.query('ROLLBACK');open=false;return res.status(409).json({error:'La solicitud ya fue resuelta'})}if(a.requested_by===req.user.id){await db.query('ROLLBACK');open=false;return res.status(403).json({error:'El solicitante no puede autorizar su propia solicitud'})}if(a.cost_version_id){const v=(await db.query('select id,status,authorization_request_id from trip_cost_versions where id=$1 and company_id=$2 for update',[a.cost_version_id,cid])).rows[0];if(!v||v.authorization_request_id!==a.id||v.status!=='pending_approval'){await db.query('ROLLBACK');open=false;return res.status(409).json({error:'La versión económica fue reemplazada o ya no es autorizable'})}}const updated=(await db.query('update economic_authorization_requests set status=$1,resolved_by=$2,resolved_at=now(),resolution_reason=$3,reauthenticated_at=now() where id=$4 and company_id=$5 and status=\'pending\' returning *',[decision,req.user.id,reason,a.id,cid])).rows[0];if(a.cost_version_id)await db.query('update trip_cost_versions set status=$1 where id=$2 and company_id=$3 and authorization_request_id=$4',[decision==='approved'?'approved':'rejected',a.cost_version_id,cid,a.id]);await writeAudit(db,req,{companyId:cid,action:decision,entity:'economic_authorization',entityId:a.id,beforeData:a,afterData:updated});await db.query('COMMIT');open=false;res.json(updated)}catch{if(open){try{await db.query('ROLLBACK')}catch{}}res.status(500).json({error:'No se pudo resolver la autorización'})}finally{if(db)db.release()}}
  async function resolveRevenueAuthorization(req,res,decision,next){const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});const reason=clean(req.body?.reason);if(!reason)return res.status(400).json({error:'El motivo de resolución es obligatorio'});const existing=(await pool.query('select * from economic_authorization_requests where id=$1 and company_id=$2',[req.params.id,cid])).rows[0];if(!existing||existing.request_type!=='revenue_change')return next();if(!await reauthenticateUser(pool,req.user.id,req.body?.password))return res.status(401).json({error:'Reautenticación inválida'});if(existing.requested_by===req.user.id)return res.status(403).json({error:'El solicitante no puede autorizar su propia solicitud'});let db=null,open=false;try{db=await pool.connect();await db.query('BEGIN');open=true;const a=(await db.query('select * from economic_authorization_requests where id=$1 and company_id=$2 for update',[req.params.id,cid])).rows[0];if(!a||a.status!=='pending'){await db.query('ROLLBACK');open=false;return res.status(a?409:404).json({error:a?'La solicitud ya fue resuelta':'Solicitud inexistente'})}const trip=(await db.query('select id,company_id,revenue_clp,actual_departure,status from trips where id=$1 and company_id=$2 for update',[a.trip_id,cid])).rows[0];if(!trip||trip.actual_departure===null||Number(trip.revenue_clp)!==Number(a.previous_revenue_clp)){await db.query('ROLLBACK');open=false;return res.status(409).json({error:'El viaje o el ingreso cambió y la solicitud ya no es aplicable'})}if(decision==='approved'){const profile=(await db.query('select * from trip_economic_profiles where trip_id=$1 and company_id=$2 for update',[trip.id,cid])).rows[0];const updatedProfile=(await db.query(`insert into trip_economic_profiles(trip_id,company_id,revenue_defined,revenue_confirmed_by,revenue_confirmed_at,economic_status,updated_at) values($1,$2,true,$3,now(),'open',now()) on conflict(trip_id) do update set revenue_defined=true,revenue_confirmed_by=excluded.revenue_confirmed_by,revenue_confirmed_at=now(),updated_at=now() returning *`,[trip.id,cid,req.user.id])).rows[0];await db.query(`insert into trip_revenue_history(company_id,trip_id,previous_revenue_clp,new_revenue_clp,revenue_defined,includes_vat,change_reason,authorization_request_id,created_by) values($1,$2,$3,$4,true,$5,$6,$7,$8)`,[cid,trip.id,a.previous_revenue_clp,a.requested_revenue_clp,updatedProfile.revenue_includes_vat,reason,a.id,req.user.id]);await db.query('update trips set revenue_clp=$1,updated_at=now() where id=$2 and company_id=$3 and revenue_clp=$4',[a.requested_revenue_clp,trip.id,cid,a.previous_revenue_clp]);await writeAudit(db,req,{companyId:cid,action:'authorized_update',entity:'trip_revenue',entityId:trip.id,beforeData:{trip,profile},afterData:{revenue_clp:a.requested_revenue_clp,authorization_request_id:a.id}})}const updated=(await db.query("update economic_authorization_requests set status=$1,resolved_by=$2,resolved_at=now(),resolution_reason=$3,reauthenticated_at=now() where id=$4 and company_id=$5 and status='pending' returning *",[decision,req.user.id,reason,a.id,cid])).rows[0];await writeAudit(db,req,{companyId:cid,action:decision,entity:'economic_authorization',entityId:a.id,beforeData:a,afterData:updated});await db.query('COMMIT');open=false;return res.json(updated)}catch{if(open){try{await db.query('ROLLBACK')}catch{}}return res.status(500).json({error:'No se pudo resolver la autorización'})}finally{if(db)db.release()}}
  app.post('/api/economics/authorizations/:id/approve',requirePermission('economics.approve'),(req,res,next)=>resolveRevenueAuthorization(req,res,'approved',next));
  app.post('/api/economics/authorizations/:id/reject',requirePermission('economics.approve'),(req,res,next)=>resolveRevenueAuthorization(req,res,'rejected',next));
  app.post('/api/economics/authorizations/:id/approve',requirePermission('economics.approve'),(req,res)=>resolveAuthorization(req,res,'approved'));
  app.post('/api/economics/authorizations/:id/reject',requirePermission('economics.approve'),(req,res)=>resolveAuthorization(req,res,'rejected'));
  app.get('/api/economics/trips/:id/costs',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{
      const trip=await pool.query('select id from trips where id=$1 and company_id=$2',[req.params.id,cid]);
      if(!trip.rowCount)return res.sendStatus(404);
      const result=await pool.query(`select i.id,i.company_id,i.trip_id,i.status item_status,i.current_version_id,c.code category_code,c.name category_name,c.cost_group,
        v.id version_id,v.version_number,v.cost_basis,v.amount_clp,v.amount_includes_vat,v.support_status,v.justification,v.description,v.effective_date,v.status
        from trip_cost_items i join economic_cost_categories c on c.id=i.category_id
        join trip_cost_versions v on v.id=i.current_version_id and v.trip_cost_item_id=i.id and v.company_id=i.company_id
        where i.trip_id=$1 and i.company_id=$2 order by i.id desc`,[req.params.id,cid]);
      res.json(result.rows.map(costView));
    }catch{res.status(500).json({error:'No se pudieron consultar los costos del viaje'})}
  });
  app.post('/api/economics/trips/:id/costs',requirePermission('economics.manage'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});
    const input=costInput(req.body);if(input.error)return res.status(400).json({error:input.error});
    let db=null,open=false;
    try{
      db=await pool.connect();await db.query('BEGIN');open=true;
      const trip=(await db.query('select id,company_id from trips where id=$1 and company_id=$2 for update',[req.params.id,cid])).rows[0];
      if(!trip){await db.query('ROLLBACK');open=false;return res.sendStatus(404)}
      const category=(await db.query("select id,code,name,cost_group from economic_cost_categories where code=$1 and active=true for share",[clean(req.body.category_code)])).rows[0];
      if(!category){await db.query('ROLLBACK');open=false;return res.status(400).json({error:'categoría inexistente o inactiva'})}
      if(category.cost_group!=='direct'){await db.query('ROLLBACK');open=false;return res.status(400).json({error:'la categoría no es directa'})}
      const item=(await db.query('insert into trip_cost_items(company_id,trip_id,category_id,status,created_by) values($1,$2,$3,\'active\',$4) returning *',[cid,trip.id,category.id,req.user.id])).rows[0];
      const version=(await db.query(`insert into trip_cost_versions(company_id,trip_cost_item_id,version_number,cost_basis,amount_clp,amount_includes_vat,support_status,justification,description,effective_date,status,created_by)
        values($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'draft',$10) returning *`,[cid,item.id,input.basis,input.amount,input.vat,input.support,input.justification,input.description,input.effectiveDate,req.user.id])).rows[0];
      const updated=(await db.query('update trip_cost_items set current_version_id=$1,updated_at=now() where id=$2 and company_id=$3 returning *',[version.id,item.id,cid])).rows[0];
      await writeAudit(db,req,{companyId:cid,action:'create',entity:'trip_cost',entityId:item.id,beforeData:null,afterData:{item:updated,version,category}});
      await db.query('COMMIT');open=false;res.status(201).json(costView({...version,item_id:item.id,category_code:category.code,category_name:category.name,item_status:updated.status,current_version_id:version.id}));
    }catch{if(open){try{await db.query('ROLLBACK')}catch{}}res.status(500).json({error:'No se pudo crear el costo directo'})}finally{if(db)db.release()}
  });
  app.get('/api/economics/costs/:id',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{const r=await pool.query(`select i.id,i.company_id,i.trip_id,i.status item_status,i.current_version_id,c.code category_code,c.name category_name,c.cost_group,
      v.id version_id,v.version_number,v.cost_basis,v.amount_clp,v.amount_includes_vat,v.support_status,v.justification,v.description,v.effective_date,v.status
      from trip_cost_items i join economic_cost_categories c on c.id=i.category_id join trip_cost_versions v on v.trip_cost_item_id=i.id and v.company_id=i.company_id
      where i.id=$1 and i.company_id=$2 order by v.version_number desc`,[req.params.id,cid]);if(!r.rowCount)return res.sendStatus(404);res.json(r.rows.map(costView))}catch{res.status(500).json({error:'No se pudo consultar el costo'})}
  });
  app.post('/api/economics/costs/:id/versions',requirePermission('economics.manage'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});const input=costInput(req.body);if(input.error)return res.status(400).json({error:input.error});let db=null,open=false;
    try{db=await pool.connect();await db.query('BEGIN');open=true;const item=(await db.query(`select i.*,c.code category_code,c.name category_name,c.cost_group from trip_cost_items i join economic_cost_categories c on c.id=i.category_id where i.id=$1 and i.company_id=$2 for update`,[req.params.id,cid])).rows[0];if(!item){await db.query('ROLLBACK');open=false;return res.sendStatus(404)}if(item.cost_group!=='direct'){await db.query('ROLLBACK');open=false;return res.status(400).json({error:'la categoría no es directa'})}const last=(await db.query('select * from trip_cost_versions where trip_cost_item_id=$1 and company_id=$2 order by version_number desc limit 1 for update',[item.id,cid])).rows[0];const version=(await db.query(`insert into trip_cost_versions(company_id,trip_cost_item_id,version_number,cost_basis,amount_clp,amount_includes_vat,support_status,justification,description,effective_date,status,supersedes_version_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12) returning *`,[cid,item.id,Number(last.version_number)+1,input.basis,input.amount,input.vat,input.support,input.justification,input.description,input.effectiveDate,last.id,req.user.id])).rows[0];const updated=(await db.query('update trip_cost_items set current_version_id=$1,updated_at=now() where id=$2 and company_id=$3 returning *',[version.id,item.id,cid])).rows[0];await writeAudit(db,req,{companyId:cid,action:'version',entity:'trip_cost',entityId:item.id,beforeData:{item,version:last},afterData:{item:updated,version}});await db.query('COMMIT');open=false;res.status(201).json(costView({...version,item_id:item.id,category_code:item.category_code,category_name:item.category_name,item_status:updated.status,current_version_id:version.id}))}catch{if(open){try{await db.query('ROLLBACK')}catch{}}res.status(500).json({error:'No se pudo crear la nueva versión del costo'})}finally{if(db)db.release()}
  });
  app.post('/api/economics/costs/:id/reconcile',requirePermission('economics.manage'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});
    const reason=clean(req.body?.reason);if(!reason)return res.status(400).json({error:'El motivo de conciliación es obligatorio'});
    let db=null,open=false;
    try{db=await pool.connect();await db.query('BEGIN');open=true;
      const item=(await db.query(`select i.*,c.code category_code,c.name category_name,c.cost_group from trip_cost_items i join economic_cost_categories c on c.id=i.category_id where i.id=$1 and i.company_id=$2 for update`,[req.params.id,cid])).rows[0];
      if(!item||Number(item.company_id)!==Number(cid)){await db.query('ROLLBACK');open=false;return res.sendStatus(404)}
      if(item.cost_group!=='direct'){await db.query('ROLLBACK');open=false;return res.status(400).json({error:'la categoría no es directa'})}
      const current=(await db.query('select * from trip_cost_versions where id=$1 and trip_cost_item_id=$2 and company_id=$3 for update',[item.current_version_id,item.id,cid])).rows[0];
      if(!current){await db.query('ROLLBACK');open=false;return res.status(409).json({error:'El costo no tiene una versión vigente válida'})}
      if(current.status!=='approved'){await db.query('ROLLBACK');open=false;return res.status(409).json({error:'Solo se puede conciliar una versión aprobada'})}
      if(current.cost_basis==='indirect'){await db.query('ROLLBACK');open=false;return res.status(400).json({error:'Los costos indirectos no se concilian automáticamente'})}
      const version=(await db.query(`insert into trip_cost_versions(company_id,trip_cost_item_id,version_number,cost_basis,amount_clp,amount_includes_vat,support_status,justification,description,effective_date,status,supersedes_version_id,created_by,reconciled_by,reconciled_at,reconciliation_reason)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reconciled',$11,$12,$12,now(),$13) returning *`,[cid,item.id,Number(current.version_number)+1,current.cost_basis,current.amount_clp,current.amount_includes_vat,current.support_status,current.justification,current.description,current.effective_date,current.id,req.user.id,reason])).rows[0];
      const updated=(await db.query('update trip_cost_items set current_version_id=$1,status=\'reconciled\',updated_at=now() where id=$2 and company_id=$3 returning *',[version.id,item.id,cid])).rows[0];
      await writeAudit(db,req,{companyId:cid,action:'reconcile',entity:'trip_cost',entityId:item.id,beforeData:{item,version:current},afterData:{item:updated,version}});
      await db.query('COMMIT');open=false;res.status(201).json(costView({...version,item_id:item.id,category_code:item.category_code,category_name:item.category_name,item_status:updated.status,current_version_id:version.id}));
    }catch{if(open){try{await db.query('ROLLBACK')}catch{}}res.status(500).json({error:'No se pudo conciliar el costo'})}finally{if(db)db.release()}
  });
  app.get('/api/economics/trips/:id',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{
      const result=await pool.query(
        `select t.id,t.company_id,t.revenue_clp,t.actual_departure,t.status,
                ep.revenue_defined,ep.revenue_includes_vat,ep.revenue_confirmed_by,
                ep.revenue_confirmed_at,ep.economic_status,ep.trip_id as economic_profile_trip_id
           from trips t
           left join trip_economic_profiles ep on ep.trip_id=t.id and ep.company_id=t.company_id
          where t.id=$1 and t.company_id=$2`,
        [req.params.id,cid]
      );
      if(!result.rowCount)return res.sendStatus(404);
      const row=result.rows[0];
      const profile=row.economic_profile_trip_id?row:null;
      res.json(economicView(row,profile));
    }catch{
      res.status(500).json({error:'No se pudo consultar la información económica del viaje'});
    }
  });

  app.get('/api/economics/trips/:id/delta',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{
      const result=await pool.query(`select t.id trip_id,t.company_id,t.revenue_clp,ep.revenue_defined,ep.revenue_includes_vat,
        s.distance_meters/1000.0 snapshot_distance_km,t.distance_km trip_distance_km,r.distance_km route_distance_km,
        i.id cost_item_id,i.status item_status,i.current_version_id,c.code category_code,c.name category_name,c.cost_group,
        v.id version_id,v.version_number,v.amount_clp,v.cost_basis,v.status version_status
        from trips t left join trip_economic_profiles ep on ep.trip_id=t.id and ep.company_id=t.company_id
        left join trip_route_snapshots s on s.id=t.planned_route_snapshot_id and s.trip_id=t.id and s.company_id=t.company_id
        left join routes r on r.id=t.route_id and r.company_id=t.company_id
        left join trip_cost_items i on i.trip_id=t.id and i.company_id=t.company_id
        left join economic_cost_categories c on c.id=i.category_id
        left join trip_cost_versions v on v.id=i.current_version_id and v.trip_cost_item_id=i.id and v.company_id=i.company_id
        where t.id=$1 and t.company_id=$2`,[req.params.id,cid]);
      if(!result.rowCount)return res.sendStatus(404);
      const first=result.rows[0],defined=first.revenue_defined===true;
      const rows=result.rows.filter(row=>row.cost_item_id!==null);
      const recognized=rows.filter(row=>row.item_status!=='voided'&&row.cost_group==='direct'&&['approved','reconciled'].includes(row.version_status)&&row.cost_basis!=='indirect');
      const costs=recognized.map(row=>({cost_item_id:row.cost_item_id,category_code:row.category_code,category_name:row.category_name,version_id:row.version_id,version_number:row.version_number,amount:Number(row.amount_clp),cost_basis:row.cost_basis,status:row.version_status}));
      const excluded_costs=rows.filter(row=>!recognized.includes(row)).map(row=>({cost_item_id:row.cost_item_id,version_id:row.version_id,category_code:row.category_code,amount:row.amount_clp===null?null:Number(row.amount_clp),cost_basis:row.cost_basis??null,status:row.version_status??row.item_status,reason:row.item_status==='voided'?'voided':row.cost_group!=='direct'?'indirect':!row.version_id?'no_current_version':row.cost_basis==='indirect'?'indirect':`status_${row.version_status}`}));
       const total=costs.reduce((sum,cost)=>sum+cost.amount,0);
       const pending=rows.some(row=>row.item_status!=='voided'&&row.cost_group==='direct'&&['draft','pending_approval'].includes(row.version_status));
       const snapshot=Number(first.snapshot_distance_km),tripDistance=Number(first.trip_distance_km),routeDistance=Number(first.route_distance_km);
       const distance=Number.isFinite(snapshot)&&snapshot>0?snapshot:Number.isFinite(tripDistance)&&tripDistance>0?tripDistance:Number.isFinite(routeDistance)&&routeDistance>0?routeDistance:null;
       const finalCalculation=operationalDelta({revenueClp:first.revenue_clp,revenueDefined:defined,recognizedCosts:total,hasRecognizedCosts:costs.length>0,pending:pending||costs.some(cost=>cost.status==='approved'),distanceKm:distance});
      const distance_source=distance===null?null:Number.isFinite(snapshot)&&snapshot>0?'trip_route_snapshot':Number.isFinite(tripDistance)&&tripDistance>0?'trips.distance_km':'routes.distance_km';
       res.json({trip_id:first.trip_id,company_id:first.company_id,revenue:{amount:first.revenue_clp===null?null:Number(first.revenue_clp),defined,includes_vat:first.revenue_includes_vat??null},costs,total_recognized_costs:costs.length?total:null,delta:finalCalculation.delta,delta_status:finalCalculation.delta_status,distance_km:distance,distance_source,distance_kind:distance===null?null:'official_planned',delta_per_km:finalCalculation.delta_per_km,excluded_costs});
    }catch{res.status(500).json({error:'No se pudo calcular el Delta Operacional'})}
  });

  app.get('/api/economics/reports',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    const report=clean(req.query.report)||'trips';if(!['trips','economic','operational'].includes(report))return res.status(400).json({error:'report no válido'});
    const from=kpiDate(req.query.from),to=kpiDate(req.query.to);if(from===false||to===false)return res.status(400).json({error:'Rango de fechas no válido'});
    const values=[cid],where=['t.company_id=$1'];const add=(sql,value)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`))};
    if(from)add('coalesce(t.planned_departure,t.created_at)>=?',from);if(to)add('coalesce(t.planned_departure,t.created_at)<(?::date+interval \'1 day\')',to);
    for(const key of ['client_id','truck_id','driver_id'])if(req.query[key]!==undefined){const n=Number(req.query[key]);if(!Number.isInteger(n)||n<1)return res.status(400).json({error:`${key} no válido`});add(`t.${key}=?`,n)}
    const statuses=['Planificado','Asignado','En carga','En tránsito','Detenido','Llegó a destino','Descargando','Completado','Cancelado'];if(req.query.status!==undefined){if(!statuses.includes(req.query.status))return res.status(400).json({error:'status no válido'});add('t.status=?',req.query.status)}
    try{const rows=(await pool.query(`with costs as(select i.trip_id,sum(v.amount_clp) filter(where i.status<>'voided' and c.cost_group='direct' and v.cost_basis<>'indirect' and v.status in ('approved','reconciled')) costs,sum(v.amount_clp) filter(where i.status<>'voided' and c.cost_group='direct' and v.cost_basis<>'indirect' and v.status='approved') approved_costs,sum(v.amount_clp) filter(where i.status<>'voided' and c.cost_group='direct' and v.cost_basis<>'indirect' and v.status='reconciled') reconciled_costs from trip_cost_items i join trip_cost_versions v on v.id=i.current_version_id and v.trip_cost_item_id=i.id and v.company_id=i.company_id join economic_cost_categories c on c.id=i.category_id group by i.trip_id),loads as(select trip_id,count(*) load_count,sum(weight_kg) weight_kg,sum(volume_m3) volume_m3,count(*) filter(where delivered_at is not null) delivered_count from trip_loads group by trip_id) select t.id trip_id,t.trip_number,t.company_id,t.client_id,t.truck_id,t.driver_id,t.status,t.origin,t.destination,t.planned_departure,t.actual_departure,t.actual_arrival,t.revenue_clp,ep.revenue_defined,ep.revenue_includes_vat,coalesce(c.costs,0) direct_costs,c.approved_costs,c.reconciled_costs,coalesce(l.load_count,0) loads_registered,coalesce(l.delivered_count,0) loads_delivered,coalesce(l.weight_kg,0) weight_kg,coalesce(l.volume_m3,0) volume_m3,s.distance_meters/1000.0 snapshot_distance_km,t.distance_km,r.distance_km route_distance_km from trips t left join trip_economic_profiles ep on ep.trip_id=t.id and ep.company_id=t.company_id left join costs c on c.trip_id=t.id left join loads l on l.trip_id=t.id left join trip_route_snapshots s on s.id=t.planned_route_snapshot_id and s.trip_id=t.id and s.company_id=t.company_id left join routes r on r.id=t.route_id and r.company_id=t.company_id where ${where.join(' and ')} order by t.id`,values)).rows;const mapped=rows.map(row=>{const recognized=row.revenue_defined===true&&(row.approved_costs!==null||row.reconciled_costs!==null),distance=Number(row.snapshot_distance_km)>0?Number(row.snapshot_distance_km):Number(row.distance_km)>0?Number(row.distance_km):Number(row.route_distance_km)>0?Number(row.route_distance_km):null,calculation=operationalDelta({revenueClp:row.revenue_clp,revenueDefined:row.revenue_defined,recognizedCosts:row.direct_costs,hasRecognizedCosts:recognized,pending:Number(row.approved_costs||0)>0,distanceKm:distance});return {trip_id:row.trip_id,trip_number:row.trip_number,company_id:row.company_id,client_id:row.client_id,truck_id:row.truck_id,driver_id:row.driver_id,status:row.status,origin:row.origin,destination:row.destination,planned_departure:row.planned_departure,actual_departure:row.actual_departure,actual_arrival:row.actual_arrival,trip_count:1,revenue_recognized:calculation.revenue_complete?Number(row.revenue_clp):null,revenue_defined:calculation.revenue_complete,revenue_includes_vat:row.revenue_includes_vat??null,direct_costs_recognized:calculation.costs_complete?Number(row.direct_costs):null,delta:calculation.delta,delta_status:calculation.delta_status,distance_km:distance,distance_source:distance===null?null:Number(row.snapshot_distance_km)>0?'trip_route_snapshot':Number(row.distance_km)>0?'trips.distance_km':'routes.distance_km',delta_per_km:calculation.delta_per_km,loads_registered:Number(row.loads_registered),loads_delivered:Number(row.loads_delivered),weight_kg:Number(row.weight_kg),volume_m3:Number(row.volume_m3),duration_minutes:row.actual_departure&&row.actual_arrival?(new Date(row.actual_arrival)-new Date(row.actual_departure))/60000:null}});const fields=report==='trips'?['trip_id','trip_number','status','client_id','truck_id','driver_id','origin','destination','planned_departure']:report==='economic'?['trip_id','trip_number','revenue_recognized','direct_costs_recognized','delta','delta_per_km','delta_status','distance_source']:['trip_id','trip_number','status','loads_registered','loads_delivered','weight_kg','volume_m3','duration_minutes'];const output=mapped.map(row=>Object.fromEntries(fields.map(field=>[field,row[field]])));if(req.query.format==='csv'){const csv=[fields.join(','),...output.map(row=>fields.map(field=>{const value=row[field]??'';return `"${String(value).replace(/"/g,'""')}"`}).join(','))].join('\r\n');res.type('text/csv').set('Content-Disposition',`attachment; filename="fleetchile-${report}.csv"`).send(csv)}else res.json({report,filters:{from:from||null,to:to||null,client_id:req.query.client_id||null,truck_id:req.query.truck_id||null,driver_id:req.query.driver_id||null,status:req.query.status||null},rows:output,count:output.length})}catch{res.status(500).json({error:'No se pudo generar el reporte'})}
  });

  app.get('/api/economics/kpis',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    const from=kpiDate(req.query.from),to=kpiDate(req.query.to);if(from===false||to===false)return res.status(400).json({error:'Rango de fechas no válido'});
    const ids=[];for(const key of ['client_id','truck_id','driver_id']){if(req.query[key]!==undefined){const n=Number(req.query[key]);if(!Number.isInteger(n)||n<1)return res.status(400).json({error:`${key} no válido`});ids.push([key,n])}}
    const allowedStatus=['Planificado','Asignado','En carga','En tránsito','Detenido','Llegó a destino','Descargando','Completado','Cancelado'];if(req.query.status!==undefined&&!allowedStatus.includes(req.query.status))return res.status(400).json({error:'status no válido'});
    try{
      const values=[cid],where=['t.company_id=$1'];const add=(sql,value)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`))};
      if(from)add('coalesce(t.planned_departure,t.created_at)>=?',from);if(to)add('coalesce(t.planned_departure,t.created_at)<(?::date+interval \'1 day\')',to);for(const [key,n] of ids)add(`t.${key}=?`,n);if(req.query.status)add('t.status=?',req.query.status);
      const trips=(await pool.query(`with filtered as (select t.id,t.company_id,t.client_id,t.truck_id,t.driver_id,t.status,t.revenue_clp,t.distance_km,ep.revenue_defined,ep.revenue_includes_vat,s.distance_meters/1000.0 snapshot_distance_km,r.distance_km route_distance_km from trips t left join trip_economic_profiles ep on ep.trip_id=t.id and ep.company_id=t.company_id left join trip_route_snapshots s on s.id=t.planned_route_snapshot_id and s.trip_id=t.id and s.company_id=t.company_id left join routes r on r.id=t.route_id and r.company_id=t.company_id where ${where.join(' and ')}),costs as (select i.trip_id,sum(v.amount_clp) filter(where i.status<>'voided' and c.cost_group='direct' and v.cost_basis<>'indirect' and v.status in ('approved','reconciled')) recognized_costs,sum(v.amount_clp) filter(where i.status<>'voided' and c.cost_group='direct' and v.cost_basis<>'indirect' and v.status='approved') approved_costs,sum(v.amount_clp) filter(where i.status<>'voided' and c.cost_group='direct' and v.cost_basis<>'indirect' and v.status='reconciled') reconciled_costs from trip_cost_items i join trip_cost_versions v on v.id=i.current_version_id and v.trip_cost_item_id=i.id and v.company_id=i.company_id join economic_cost_categories c on c.id=i.category_id group by i.trip_id),loads as(select trip_id,count(*) load_count,sum(weight_kg) weight_kg,sum(volume_m3) volume_m3,count(*) filter(where delivered_at is not null) delivered_count from trip_loads group by trip_id) select f.*,coalesce(c.recognized_costs,0) recognized_costs,c.approved_costs,c.reconciled_costs,coalesce(l.load_count,0) load_count,coalesce(l.weight_kg,0) weight_kg,coalesce(l.volume_m3,0) volume_m3,coalesce(l.delivered_count,0) delivered_count from filtered f left join costs c on c.trip_id=f.id left join loads l on l.trip_id=f.id`,values)).rows;
       const countByStatus={};for(const t of trips)countByStatus[t.status]=(countByStatus[t.status]||0)+1;
      const planned=trips.filter(t=>t.status==='Planificado').length,completed=trips.filter(t=>t.status==='Completado').length,cancelled=trips.filter(t=>t.status==='Cancelado').length;
       const defined=trips.filter(t=>t.revenue_defined===true&&t.revenue_clp!==null),missing=trips.filter(t=>t.revenue_defined!==true||t.revenue_clp===null),economic=trips.map(t=>{const has=t.approved_costs!==null||t.reconciled_costs!==null;const d=Number(t.snapshot_distance_km)>0?Number(t.snapshot_distance_km):Number(t.distance_km)>0?Number(t.distance_km):Number(t.route_distance_km)>0?Number(t.route_distance_km):null;const calculation=operationalDelta({revenueClp:t.revenue_clp,revenueDefined:t.revenue_defined,recognizedCosts:t.recognized_costs,hasRecognizedCosts:has,pending:Number(t.approved_costs||0)>0,distanceKm:d});return {delta:calculation.delta,status:calculation.delta_status,distance:d}});
      const sum=(arr,key)=>arr.reduce((n,x)=>n+Number(x[key]||0),0),prov=economic.filter(x=>x.status==='provisional'),recon=economic.filter(x=>x.status==='reconciled');
      const q=async(sql,vals=[cid])=>(await pool.query(sql,vals)).rows;
      const [docs,maint,alerts,checks,fleet,fuel]=await Promise.all([
        q('select count(*) filter(where expires_at is null or expires_at>=current_date) active,count(*) filter(where expires_at<current_date) expired,count(*) filter(where resource_type=\'vehicle\') vehicle_count,count(*) filter(where resource_type=\'driver\') driver_count from (select expires_at,\'vehicle\' resource_type from vehicle_documents vd join trucks t on t.id=vd.truck_id where t.company_id=$1 union all select expires_at,\'driver\' from driver_documents dd join drivers d on d.id=dd.driver_id where d.company_id=$1) x'),
        q("select count(*) filter(where m.status='Pendiente') pending,count(*) filter(where m.status='En proceso') in_process,count(*) filter(where m.status='Completada') completed,count(*) filter(where m.status='Cancelada') cancelled,count(*) filter(where (m.next_due_date<current_date or (m.next_due_odometer_km is not null and t.km>=m.next_due_odometer_km)) and m.status not in ('Completada','Cancelada')) overdue from maintenance m left join trucks t on t.id=m.truck_id and t.company_id=m.company_id where m.company_id=$1"),
        q('select count(*) filter(where resolved=false) open,count(*) filter(where resolved=true) resolved,count(*) filter(where resolved=false and level=\'critical\') open_critical from alerts where company_id=$1'),
        q("select count(*) filter(where vc.status='Aprobado') approved,count(*) filter(where vc.status='Pendiente') pending,count(*) filter(where vc.status in ('Rechazado','Reprobado')) rejected from vehicle_checklists vc join trips t on t.id=vc.trip_id where t.company_id=$1"),
        q("select count(*) filter(where status not in ('Mantención','Inactivo')) active,count(*) filter(where status='Disponible') available,count(*) filter(where status='Mantención') maintenance from trucks where company_id=$1"),
        q('select coalesce(sum(liters),0) liters,coalesce(sum(total_clp),0) total_clp from fuel where company_id=$1')
      ]);
      const numRow=row=>row?Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value===null?null:Number(value)])):null;const denom=planned>0?planned:null,recognizedTrips=economic.filter(x=>x.status!=='missing_data').length;res.json({filters:{from:from||null,to:to||null,client_id:req.query.client_id?Number(req.query.client_id):null,truck_id:req.query.truck_id?Number(req.query.truck_id):null,driver_id:req.query.driver_id?Number(req.query.driver_id):null,status:req.query.status||null},period_field:'coalesce(trips.planned_departure,trips.created_at)',operations:{trips_by_status:countByStatus,planned,completed,cancelled,compliance:{completed,planned,percentage:denom===null?null:completed/denom*100,denominator:denom},loads:{registered:sum(trips,'load_count'),delivered:sum(trips,'delivered_count'),weight_kg:sum(trips,'weight_kg'),volume_m3:sum(trips,'volume_m3')}},economics:{recognized_revenue:{amount:sum(defined,'revenue_clp'),trips:defined.length},recognized_costs:{amount:sum(trips,'recognized_costs'),trips:trips.filter(t=>t.approved_costs!==null||t.reconciled_costs!==null).length},delta:{provisional:sum(prov,'delta'),reconciled:sum(recon,'delta'),missing_data:missing.length,provisional_trips:prov.length,reconciled_trips:recon.length,missing_data_trips:missing.length,calculable_trips:recognizedTrips,provisional_ratio:recognizedTrips?prov.length/recognizedTrips*100:null,reconciled_ratio:recognizedTrips?recon.length/recognizedTrips*100:null},delta_per_km:{provisional:prov.filter(x=>x.distance).length?sum(prov.filter(x=>x.distance),'delta')/sum(prov.filter(x=>x.distance),'distance'):null,reconciled:recon.filter(x=>x.distance).length?sum(recon.filter(x=>x.distance),'delta')/sum(recon.filter(x=>x.distance),'distance'):null,distance_kind:'official_planned'}},documents:numRow(docs[0]),maintenance:numRow(maint[0]),alerts:numRow(alerts[0]),checklist:numRow(checks[0]),fleet:numRow(fleet[0]),fuel_operational:numRow(fuel[0])});
    }catch{res.status(500).json({error:'No se pudieron calcular los KPIs'})}
  });

  app.get('/api/economics/trips/:id/revenue-history',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{
      const trip=await pool.query('select id from trips where id=$1 and company_id=$2',[req.params.id,cid]);
      if(!trip.rowCount)return res.sendStatus(404);
      const history=await pool.query(
        `select h.id,h.company_id,h.trip_id,h.previous_revenue_clp,h.new_revenue_clp,
                h.revenue_defined,h.includes_vat,h.zero_justification,h.change_reason,
                h.authorization_request_id,h.created_by,h.created_at,u.name as created_by_name
           from trip_revenue_history h
           left join users u on u.id=h.created_by
          where h.trip_id=$1 and h.company_id=$2
          order by h.created_at desc,h.id desc`,
        [req.params.id,cid]
      );
      res.json(history.rows);
    }catch{
      res.status(500).json({error:'No se pudo consultar el historial de ingresos'});
    }
  });

  app.patch('/api/economics/trips/:id/revenue',requirePermission('economics.manage'),async(req,res)=>{
    const cid=scopedCompanyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});
    const raw=req.body?.revenue_clp;
    if(raw===undefined||raw===null||(typeof raw==='string'&&raw.trim()==='')||typeof raw==='boolean'||Array.isArray(raw)||typeof raw==='object')return res.status(400).json({error:'revenue_clp es obligatorio y debe ser un entero no negativo'});
    const revenue=Number(raw);
    if(!Number.isSafeInteger(revenue)||revenue<0)return res.status(400).json({error:'revenue_clp es obligatorio y debe ser un entero no negativo'});
    const vat=req.body?.revenue_includes_vat;
    if(vat!==undefined&&vat!==null&&typeof vat!=='boolean')return res.status(400).json({error:'revenue_includes_vat debe ser boolean o null'});
    const includesVat=vat??null;
    const reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
    if(revenue===0&&!reason)return res.status(400).json({error:'La justificación es obligatoria para confirmar un ingreso cero'});

    let db=null;
    let transactionOpen=false;
    try{
      db=await pool.connect();
      await db.query('BEGIN');transactionOpen=true;
      const tripResult=await db.query('select id,company_id,revenue_clp,actual_departure,status from trips where id=$1 and company_id=$2 for update',[req.params.id,cid]);
      if(!tripResult.rowCount){await db.query('ROLLBACK');transactionOpen=false;return res.sendStatus(404)}
      const trip=tripResult.rows[0];
      if(trip.actual_departure!==null&&trip.actual_departure!==undefined){
        const requested=await createRevenueAuthorization(db,req,{companyId:cid,trip,revenue,includesVat,reason:reason||'Modificación de ingreso posterior al inicio del viaje'});
        await db.query('COMMIT');transactionOpen=false;
        return res.status(202).json({code:'ECONOMIC_AUTHORIZATION_CREATED',message:requested.existing?'Ya existe una solicitud de autorización pendiente':'Se creó una solicitud de autorización para modificar el ingreso',request:requested.request});
      }
      const profileResult=await db.query('select * from trip_economic_profiles where trip_id=$1 and company_id=$2 for update',[trip.id,cid]);
      const previousProfile=profileResult.rows[0]||null;
      const before=economicView(trip,previousProfile);
      const profile=(await db.query(
        `insert into trip_economic_profiles(trip_id,company_id,revenue_defined,revenue_includes_vat,revenue_confirmed_by,revenue_confirmed_at,economic_status,updated_at)
         values($1,$2,true,$3,$4,now(),'open',now())
         on conflict(trip_id) do update set company_id=excluded.company_id,revenue_defined=true,
           revenue_includes_vat=excluded.revenue_includes_vat,revenue_confirmed_by=excluded.revenue_confirmed_by,
           revenue_confirmed_at=excluded.revenue_confirmed_at,updated_at=now()
         returning *`,
        [trip.id,cid,includesVat,req.user.id]
      )).rows[0];
      await db.query(
        `insert into trip_revenue_history(company_id,trip_id,previous_revenue_clp,new_revenue_clp,revenue_defined,
          includes_vat,zero_justification,change_reason,authorization_request_id,created_by)
         values($1,$2,$3,$4,true,$5,$6,$7,null,$8)`,
        [cid,trip.id,trip.revenue_clp,revenue,includesVat,revenue===0?reason:null,reason||null,req.user.id]
      );
      await db.query('update trips set revenue_clp=$1,updated_at=now() where id=$2 and company_id=$3',[revenue,trip.id,cid]);
      const after=economicView({...trip,revenue_clp:revenue},profile);
      await writeAudit(db,req,{companyId:cid,action:previousProfile?.revenue_defined===true?'update':'define',entity:'trip_revenue',entityId:trip.id,beforeData:before,afterData:{...after,reason:reason||null}});
      await db.query('COMMIT');transactionOpen=false;
      res.json(after);
    }catch{
      if(transactionOpen){try{await db.query('ROLLBACK')}catch{}}
      res.status(500).json({error:'No se pudo modificar el ingreso del viaje'});
    }finally{
      if(db)db.release();
    }
  });
}

module.exports={registerEconomicsRoutes,economicView};
