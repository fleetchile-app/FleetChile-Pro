const {requirePermission}=require('./auth');
const {reauthenticateUser}=require('./auth');
const {writeAudit}=require('./audit');

const isAdmin=req=>req.user?.role_code==='admin';
const explicitCompanyId=req=>{
  const raw=req.body?.company_id??req.query?.company_id;
  if(raw===undefined||raw===null||raw==='')return null;
  const value=Number(raw);
  return Number.isInteger(value)&&value>0?value:null;
};
const scopedCompanyId=req=>isAdmin(req)?explicitCompanyId(req):req.user?.company_id;
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
const COST_BASES=new Set(['planned','observed','allocated']);
const COST_SUPPORT=new Set(['documented','undocumented']);
const COST_STATUSES=new Set(['draft']);
const clean=v=>typeof v==='string'?v.trim():v;
const validDate=v=>v===undefined||v===null||v===''||(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(v))&&(()=>{const d=new Date(`${v}T00:00:00.000Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v})());
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
      const total=costs.reduce((sum,cost)=>sum+cost.amount,0),delta=defined&&costs.length>0?Number(first.revenue_clp)-total:null;
      const pending=rows.some(row=>row.item_status!=='voided'&&row.cost_group==='direct'&&['draft','pending_approval'].includes(row.version_status));
      const delta_status=!defined||costs.length===0?'missing_data':pending||costs.some(cost=>cost.status==='approved')?'provisional':'reconciled';
      const snapshot=Number(first.snapshot_distance_km),tripDistance=Number(first.trip_distance_km),routeDistance=Number(first.route_distance_km);
      const distance=Number.isFinite(snapshot)&&snapshot>0?snapshot:Number.isFinite(tripDistance)&&tripDistance>0?tripDistance:Number.isFinite(routeDistance)&&routeDistance>0?routeDistance:null;
      const distance_source=distance===null?null:Number.isFinite(snapshot)&&snapshot>0?'trip_route_snapshot':Number.isFinite(tripDistance)&&tripDistance>0?'trips.distance_km':'routes.distance_km';
      res.json({trip_id:first.trip_id,company_id:first.company_id,revenue:{amount:first.revenue_clp===null?null:Number(first.revenue_clp),defined,includes_vat:first.revenue_includes_vat??null},costs,total_recognized_costs:costs.length?total:null,delta,delta_status,distance_km:distance,distance_source,distance_kind:distance===null?null:'official_planned',delta_per_km:delta!==null&&distance!==null?delta/distance:null,excluded_costs});
    }catch{res.status(500).json({error:'No se pudo calcular el Delta Operacional'})}
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
