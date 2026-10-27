'use strict';
const crypto=require('node:crypto'),D=require('./commercial-domain'),E=require('./equipment-domain');
const {requirePlatformPermission,requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=b=>crypto.createHash('sha256').update(JSON.stringify(canonical(b))).digest('hex');
const current=async(db,cid)=>(await db.query('select * from commercial_current($1)',[cid])).rows[0]||null;
const latest=async(db,cid)=>(await db.query('select * from commercial_contracts where company_id=$1 order by period_until desc,id desc limit 1',[cid])).rows[0]||null;
function company(req){const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id||a.actor_type==='platform')throw D.fail('Se requiere administración de la propia empresa',403);return a.company_id;}
async function snapshot(db,cid){
 const company=(await db.query('select id,legal_name,commercial_enforced,commercial_version from companies where id=$1',[cid])).rows[0];if(!company)throw D.fail('Empresa no encontrada',404);
 const [active,last,periods,equipment,requests,quotes]=await Promise.all([current(db,cid),latest(db,cid),db.query('select * from commercial_contracts where company_id=$1 order by id desc limit 100',[cid]),db.query('select t.id,t.patente,t.tipo,commercial_category(t.tipo) category,coalesce(s.active,false) enabled,coalesce(s.version,0) seat_version from trucks t left join commercial_equipment_seats s on s.truck_id=t.id and s.company_id=t.company_id where t.company_id=$1 order by t.patente,t.id',[cid]),db.query('select * from commercial_requests where company_id=$1 order by id desc limit 100',[cid]),db.query("select q.*,coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'actor_user_id',e.actor_user_id,'created_at',e.created_at,'reason',e.reason)) from commercial_quote_events e where e.quote_id=q.id),'[]') events from commercial_quotes q where q.company_id=$1 order by q.id desc limit 100",[cid])]);
 return {company,state:company.commercial_enforced?active?'active':last?D.state(last):'unconfigured':'regularization',active,last,periods:periods.rows,equipment:equipment.rows,requests:requests.rows,quotes:quotes.rows,categories:D.CATEGORIES,modules:D.MODULES};
}
function registerCommercialRoutes(app,pool){
 const platform=requirePlatformPermission('platform.companies.manage'),admin=requirePermission('company.users.manage');
 const respond=(res,e)=>res.status(e.status||(['P7501','P7502','P7503','23505','55P03','40P01'].includes(e.code)?409:500)).json({error:e.status||e.code?.startsWith('P75')?e.message:['55P03','40P01'].includes(e.code)?'Hay una edición simultánea. Actualiza y reintenta; no se aplicaron cambios parciales':e.code==='23505'?'Identificador, pago o decisión ya registrados':'No se pudo completar la gestión comercial',code:e.code?.startsWith('P75')?'COMMERCIAL_BLOCKED':e.code||'COMMERCIAL_ERROR'});
 async function tx(cid,req,work){const db=await pool.connect();try{await db.query('BEGIN');await db.query('select commercial_lock($1)',[cid]);const c=(await db.query('select id,commercial_enforced,commercial_version from companies where id=$1 for no key update',[cid])).rows[0];if(!c)throw D.fail('Empresa no encontrada',404);const result=await work(db,c);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 const route=(method,path,guard,cid,work)=>app[method](path,guard,async(req,res)=>{try{res.json(await work(req,E.id(cid(req),'Empresa')));}catch(e){respond(res,e);}});
 const own=req=>company(req),target=req=>req.params.companyId;
 route('get','/api/company/commercial',admin,own,(req,cid)=>snapshot(pool,cid));
 route('get','/api/platform/commercial/companies/:companyId',platform,target,(req,cid)=>snapshot(pool,cid));
 app.get('/api/platform/commercial/plans',platform,async(req,res)=>{try{res.json((await pool.query('select * from commercial_plans order by code,revision desc')).rows);}catch(e){respond(res,e);}});
 app.post('/api/platform/commercial/plans',platform,async(req,res)=>{
  let db;try{const p=D.plan(req.body||{});db=await pool.connect();await db.query('BEGIN');await db.query('select pg_advisory_xact_lock(738038,0)');
   const revision=Number((await db.query('select coalesce(max(revision),0)+1 revision from commercial_plans where code=$1',[p.code])).rows[0].revision);
   const row=(await db.query('insert into commercial_plans(code,name,revision,max_equipment,allowed_modules,included_modules,actor_user_id) values($1,$2,$3,$4,$5,$6,$7) returning *',[p.code,p.name,revision,p.max_equipment,JSON.stringify(p.allowed_modules),JSON.stringify(p.included_modules),req.user.id])).rows[0];
   await writeAudit(db,req,{companyId:null,action:'create',entity:'commercial_plan',entityId:row.id,afterData:row});await db.query('COMMIT');res.status(201).json(row);
  }catch(e){if(db)await db.query('ROLLBACK');respond(res,e);}finally{db?.release();}
 });
 route('post','/api/company/commercial/requests',admin,own,(req,cid)=>tx(cid,req,async db=>{
  const b=req.body||{},key=E.text(b.client_key,'Identificador',80),reason=E.text(b.reason,'Motivo',2000),desired={quantities:D.quantities(b.quantities),modules:D.modules(b.modules)},digest=hash(b);
  const old=(await db.query('select * from commercial_requests where company_id=$1 and client_key=$2',[cid,key])).rows[0];if(old){if(old.payload_hash!==digest)throw D.fail('El identificador corresponde a otra solicitud',409);return old;}
  const row=(await db.query('insert into commercial_requests(company_id,client_key,desired,payload_hash,reason,actor_user_id) values($1,$2,$3,$4,$5,$6) returning *',[cid,key,desired,digest,reason,req.user.id])).rows[0];
  await writeAudit(db,req,{companyId:cid,action:'create',entity:'commercial_request',entityId:row.id,afterData:row});return row;
 }));
 route('post','/api/platform/commercial/companies/:companyId/quotes',platform,target,(req,cid)=>tx(cid,req,async(db,c)=>{
  const b=req.body||{},key=E.text(b.client_key,'Identificador',80),digest=hash(b);
  const old=(await db.query('select * from commercial_quotes where company_id=$1 and client_key=$2',[cid,key])).rows[0];if(old){if(old.payload_hash!==digest)throw D.fail('El identificador corresponde a otra propuesta',409);return old;}
  if(b.version!==c.commercial_version)throw D.fail('Cambió el contrato: actualiza antes de cotizar',409,'COMMERCIAL_STALE');
  const p=(await db.query('select * from commercial_plans where id=$1',[E.id(b.plan_id,'Plan')])).rows[0];if(!p)throw D.fail('Plan no encontrado',404);
  const reference=b.kind==='expansion'?(await db.query('select * from commercial_contracts where company_id=$1 and id=$2',[cid,E.id(b.target_contract_id,'Período a ampliar')])).rows[0]:await latest(db,cid);
  if(b.kind==='expansion'){
   const lastRevision=(await db.query('select id from commercial_contracts where company_id=$1 and period_from=$2 and period_until=$3 order by id desc limit 1',[cid,reference?.period_from||null,reference?.period_until||null])).rows[0];
   if(!reference||String(lastRevision?.id)!==String(reference.id))throw D.fail('Selecciona la última revisión del período pagado',409);
  }
  const q=D.quote(b,p,reference);
  if(b.kind==='initial'&&c.commercial_version>0)throw D.fail('La empresa requiere renovación, no otra activación inicial',409);
  const row=(await db.query('insert into commercial_quotes(company_id,request_id,client_key,payload_hash,base_version,kind,configuration,period_from,period_until,valid_until,amount_clp,reason,actor_user_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[cid,b.request_id?E.id(b.request_id):null,key,digest,c.commercial_version,q.kind,q.configuration,q.period_from,q.period_until,q.valid_until,q.amount_clp,q.reason,req.user.id])).rows[0];
  await writeAudit(db,req,{companyId:cid,action:'create',entity:'commercial_quote',entityId:row.id,afterData:row});return row;
 }));
 async function decision(req,cid,kind){return tx(cid,req,async(db,c)=>{
  const b=req.body||{},q=(await db.query('select * from commercial_quotes where id=$1 and company_id=$2',[E.id(req.params.id),cid])).rows[0];if(!q)throw D.fail('Propuesta no encontrada',404);
  const prior=(await db.query("select * from commercial_quote_events where quote_id=$1 and kind in ('accepted','rejected')",[q.id])).rows[0];if(prior){if(prior.kind!==kind)throw D.fail('La propuesta ya tiene otra decisión',409);return prior;}
  if(Date.parse(q.valid_until)<=Date.now())throw D.fail('La propuesta venció: solicita una nueva',409);
  if(q.base_version!==c.commercial_version)throw D.fail('El contrato cambió: solicita una propuesta actualizada',409,'COMMERCIAL_STALE');
  const event=(await db.query('insert into commercial_quote_events(company_id,quote_id,kind,actor_user_id,reason) values($1,$2,$3,$4,$5) returning *',[cid,q.id,kind,req.user.id,E.text(b.reason,'Confirmación o motivo',2000)])).rows[0];
  await writeAudit(db,req,{companyId:cid,action:kind,entity:'commercial_quote',entityId:q.id,afterData:event});return event;
 });}
 for(const [action,kind] of [['accept','accepted'],['reject','rejected']]){
  route('post','/api/company/commercial/quotes/:id/'+action,admin,own,(req,cid)=>decision(req,cid,kind));
  route('post','/api/platform/commercial/companies/:companyId/quotes/:id/'+action,platform,target,(req,cid)=>decision(req,cid,kind));
 }
 route('post','/api/platform/commercial/companies/:companyId/quotes/:id/payment',platform,target,(req,cid)=>tx(cid,req,async(db,c)=>{
  const b=req.body||{},reference=E.text(b.payment_reference,'Referencia de pago',160),amount=D.integer(b.amount_clp,'Importe confirmado'),reason=E.text(b.reason,'Confirmación del pago',2000);
  const q=(await db.query('select * from commercial_quotes where company_id=$1 and id=$2',[cid,E.id(req.params.id)])).rows[0];if(!q)throw D.fail('Propuesta no encontrada',404);
  const prior=(await db.query("select * from commercial_quote_events where quote_id=$1 and kind='paid'",[q.id])).rows[0];
  if(prior){if(prior.payment_reference!==reference||Number(prior.amount_clp)!==amount)throw D.fail('El pago ya está confirmado con otros datos',409);return (await db.query('select * from commercial_contracts where quote_id=$1',[q.id])).rows[0];}
  if(b.payment_confirmed!==true)throw D.fail('Debes confirmar expresamente que el pago fue recibido');
  if(q.base_version!==c.commercial_version||Date.parse(q.valid_until)<=Date.now()||Date.parse(q.period_until)<=Date.now())throw D.fail('La propuesta venció o cambió el contrato: genera una propuesta actualizada',409,'COMMERCIAL_STALE');
  if(amount!==Number(q.amount_clp))throw D.fail('El importe recibido debe coincidir con la propuesta aceptada');
  if(!(await db.query("select id from commercial_quote_events where quote_id=$1 and kind='accepted'",[q.id])).rows[0])throw D.fail('La propuesta debe estar aceptada antes de confirmar el pago',409);
  const usage=(await db.query('select category,count(*)::int used from commercial_equipment_seats where company_id=$1 and active group by category',[cid])).rows;
  if(usage.some(u=>u.used>q.configuration.quantities[u.category]))throw D.fail('La capacidad propuesta es menor a los equipos habilitados: regulariza antes de confirmar',409);
  await db.query("insert into commercial_quote_events(company_id,quote_id,kind,actor_user_id,reason,payment_reference,amount_clp) values($1,$2,'paid',$3,$4,$5,$6)",[cid,q.id,req.user.id,reason,reference,amount]);
  const contract=(await db.query('insert into commercial_contracts(company_id,quote_id,version,configuration,period_from,period_until) values($1,$2,$3,$4,$5,$6) returning *',[cid,q.id,c.commercial_version+1,q.configuration,q.period_from,q.period_until])).rows[0];
  await db.query('update companies set commercial_enforced=true,commercial_version=commercial_version+1 where id=$1',[cid]);
  const initialUnits=b.equipment_ids??[];
  if(!Array.isArray(initialUnits)||initialUnits.length>1000||new Set(initialUnits).size!==initialUnits.length)throw D.fail('Selecciona equipos sin duplicados');
  for(const value of initialUnits){
   const id=E.id(value,'Equipo'),unit=(await db.query('select id,tipo from trucks where company_id=$1 and id=$2',[cid,id])).rows[0];if(!unit||!E.role(unit.tipo))throw D.fail('Selecciona equipos de esta empresa con categoría válida');
   const old=(await db.query('select * from commercial_equipment_seats where company_id=$1 and truck_id=$2',[cid,id])).rows[0];
   const seat=(await db.query('insert into commercial_equipment_seats(company_id,truck_id,category,active,version) values($1,$2,$3,true,1) on conflict(company_id,truck_id) do update set active=true,category=excluded.category,version=commercial_equipment_seats.version+1 returning *',[cid,id,E.role(unit.tipo)])).rows[0];
   await db.query('insert into commercial_seat_events(company_id,truck_id,before_data,after_data,reason,actor_user_id) values($1,$2,$3,$4,$5,$6)',[cid,id,old||null,seat,'Habilitación con pago confirmado: '+reason,req.user.id]);
   await writeAudit(db,req,{companyId:cid,action:'enable',entity:'commercial_equipment',entityId:id,beforeData:old,afterData:seat});
  }
  if(!c.commercial_enforced){
   const working=(await db.query("select truck_id id from trips where company_id=$1 and status in ('En carga','En tránsito','Detenido','Llegó a destino','Descargando') union select trailer_id from trips where company_id=$1 and status in ('En carga','En tránsito','Detenido','Llegó a destino','Descargando') union select truck_id from maintenance where company_id=$1 and status='En proceso'",[cid])).rows.filter(r=>r.id);
   const enabled=(await db.query('select truck_id from commercial_equipment_seats where company_id=$1 and active',[cid])).rows;
   if(working.some(u=>!enabled.some(s=>String(s.truck_id)===String(u.id))))throw D.fail('La activación debe incluir los equipos de trabajos en ejecución para no interrumpirlos',409);
  }
  await writeAudit(db,req,{companyId:cid,action:'payment_confirmed',entity:'commercial_contract',entityId:contract.id,afterData:{contract,reference,amount_clp:amount,reason}});return contract;
 }));
 route('post','/api/platform/commercial/companies/:companyId/equipment',platform,target,(req,cid)=>tx(cid,req,async(db,c)=>{
  const b=req.body||{},reason=E.text(b.reason,'Motivo',2000),truckId=E.id(b.truck_id,'Equipo');
  if(b.version!==c.commercial_version)throw D.fail('Cambió el contrato: actualiza antes de habilitar equipos',409);
  if(typeof b.active!=='boolean')throw D.fail('Indica habilitar o deshabilitar');
  const unit=(await db.query('select id,tipo from trucks where id=$1 and company_id=$2',[truckId,cid])).rows[0];if(!unit)throw D.fail('Equipo no encontrado',404);
  const category=E.role(unit.tipo);if(!category)throw D.fail('Normaliza el tipo del equipo antes de habilitarlo');
  async function save(id,active,expected){
   const old=(await db.query('select * from commercial_equipment_seats where company_id=$1 and truck_id=$2',[cid,id])).rows[0];
   if(expected!==(old?.version||0))throw D.fail('La habilitación cambió: actualiza la ficha',409,'COMMERCIAL_STALE');
   const row=(await db.query('insert into commercial_equipment_seats(company_id,truck_id,category,active,version) values($1,$2,$3,$4,1) on conflict(company_id,truck_id) do update set active=excluded.active,category=excluded.category,version=commercial_equipment_seats.version+1 returning *',[cid,id,category,active])).rows[0];
   await db.query('insert into commercial_seat_events(company_id,truck_id,before_data,after_data,reason,actor_user_id) values($1,$2,$3,$4,$5,$6)',[cid,id,old||null,row,reason,req.user.id]);
   await writeAudit(db,req,{companyId:cid,action:active?'enable':'disable',entity:'commercial_equipment',entityId:id,beforeData:old,afterData:{...row,reason}});return row;
  }
  if(b.replace_truck_id){const id=E.id(b.replace_truck_id,'Equipo a sustituir');if(id===truckId||!b.active)throw D.fail('Sustitución no válida');const previous=(await db.query('select * from commercial_equipment_seats where company_id=$1 and truck_id=$2 and active',[cid,id])).rows[0];if(!previous||previous.category!==category)throw D.fail('La sustitución conserva la categoría comercial');await save(id,false,b.replace_seat_version);}
  return save(truckId,b.active,b.seat_version);
 }));
}
module.exports={registerCommercialRoutes,snapshot,current,latest,hash};
