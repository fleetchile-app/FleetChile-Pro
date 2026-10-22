const repo=require('./personnel-repository');
const domain=require('./personnel-domain');
const {error,id,reason,sameId,cleanDate}=repo;
const BASE='/api/company/people';
const ACCOUNT_PERMISSION='company.users.manage';
const checked=(validator,input,options)=>{const out=validator(input,options);if(out.error)throw error(400,out.error);return out.value;};
const jsonArray=value=>Array.isArray(value)?value:[];
const dates=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,/_date$|_expiry$/.test(k)?cleanDate(v):v])));
function missingProfileAccess(row,policy){
 const instant=value=>value instanceof Date?value.getTime():typeof value==='string'&&value.trim()?Date.parse(value):NaN;
 const cutoff=instant(policy.regularization_before),membership=instant(row.membership_created_at),account=instant(row.account_created_at);
 // The SQL boolean retains PostgreSQL timestamp precision; the explicit checks
 // also fail closed on absent/inconsistent timestamps in snapshots or adapters.
 const regularizing=policy.enforced===false&&row.regularization_eligible===true&&Boolean(row.user_id&&row.membership_id)&&
  Number.isFinite(cutoff)&&Number.isFinite(membership)&&Number.isFinite(account)&&membership<=cutoff&&account<=cutoff;
 const reasons=[];
 if(row.account_active!==true)reasons.push('ACCOUNT_DISABLED');
 if(row.membership_active!==true)reasons.push('MEMBERSHIP_DISABLED');
 if(!regularizing)reasons.push('PERSON_NOT_REGULARIZED');
 return {allowed:reasons.length===0,code:reasons.length?'PERSONNEL_ACCESS_BLOCKED':null,reasons,enforced:!regularizing,regularization_required:true};
}
function denyExemption(body){for(const key of ['contract_exempt','exemption_reason','exemption_by','exemption_at','company_id','user_id','driver_id'])if(Object.hasOwn(body,key))throw error(400,`El campo ${key} no se modifica por esta ruta`);}
async function contract(db,cid,pid,input,actorId){
 const v=checked(domain.validateContract,input);
 const overlap=(await db.query(`select id from person_contracts where company_id=$1 and person_id=$2 and voided_at is null
 and start_date<=coalesce($4::date,'infinity'::date) and coalesce(end_date,'infinity'::date)>=$3::date limit 1`,[cid,pid,v.start_date,v.end_date])).rows[0];
 if(overlap)throw error(409,'El contrato se solapa con otro contrato registrado');
 return (await db.query(`insert into person_contracts(company_id,person_id,type,start_date,end_date,event_name,created_by)
 values($1,$2,$3,$4,$5,$6,$7) returning *`,[cid,pid,v.type,v.start_date,v.end_date,v.event_name,actorId])).rows[0];
}
async function license(db,cid,p,input,actorId,today){
 const v=checked(domain.validateLicense,input,{today});
 if(p.role_code!=='driver'||!p.driver_id)throw error(409,'Regulariza primero la asociación de la persona conductora');
 const driver=(await db.query('select id from drivers where company_id=$1 and id=$2 for update',[cid,p.driver_id])).rows[0];
 if(!driver)throw error(409,'El conductor no pertenece a esta empresa');
 const previous=(await db.query('select * from person_driver_licenses where company_id=$1 and person_id=$2 and current=true',[cid,p.id])).rows[0]||null;
 await db.query('update person_driver_licenses set current=false where company_id=$1 and person_id=$2 and current=true',[cid,p.id]);
 const row=(await db.query(`insert into person_driver_licenses(company_id,person_id,classes,issued_date,printed_expiry,effective_expiry,current,created_by)
 values($1,$2,$3,$4,$5,$6,true,$7) returning *`,[cid,p.id,v.classes,v.issued_date,v.printed_expiry,v.effective_expiry,actorId])).rows[0];
 await db.query('update drivers set license=$1,expiry=$2 where company_id=$3 and id=$4',[v.classes.join(', '),v.effective_expiry,cid,p.driver_id]);
 if(previous)await repo.notification(db,cid,p.id,`license_renewed:${row.id}`,'license_renewed','Se registró una renovación de licencia de conducir.');
 return {before:previous,after:row};
}
function eligibility(p,h,today){return domain.evaluateEligibility({person:{...p,birth_date:cleanDate(p.birth_date)},contracts:dates(h.contracts),conditions:dates(h.conditions),licenses:dates(h.licenses),role_code:p.role_code,account_active:p.account_active!==false,membership_active:p.membership_active!==false,today});}
async function readiness(db,cid){
 const policy=await repo.policy(db,cid),today=repo.todayIn(policy.time_zone),rows=await repo.lists(db,cid),issues=[];
 for(const row of rows){
  if(!row.user_id||row.membership_active===false||row.account_active===false)continue;
  const person=row.id?row:null;
  const access=domain.evaluateEligibility({person:person?{...person,birth_date:cleanDate(person.birth_date)}:null,contracts:dates(jsonArray(row.contracts)),conditions:[],licenses:dates(jsonArray(row.licenses)),role_code:row.role_code,today});
  if(!access.allowed)issues.push({person_id:row.id||null,user_id:row.user_id,membership_id:row.membership_id,name:row.name,reasons:access.reasons});
 }
 // Global legacy accounts with no membership must not silently escape activation.
 const legacy=(await db.query(`select u.id,u.name from users u where u.company_id=$1 and u.active=true
 and not exists(select 1 from user_memberships um where um.user_id=u.id and um.company_id=$1)`,[cid])).rows;
 for(const u of legacy)issues.push({person_id:null,user_id:u.id,membership_id:null,name:u.name,reasons:['MEMBERSHIP_MISSING']});
 return {ready:issues.length===0,missing:issues.length,issues,policy,today};
}
async function createBootstrapExemption(db,{membershipId,actor,reason:why}){
 if(actor?.actor_type!=='platform'||!actor.permissions?.includes('platform.users.manage'))throw error(403,'Se requiere administración de usuarios de plataforma');
 why=reason(why);const actorId=actor.id??actor.user_id;
 if(!actorId)throw error(403,'Actor no identificado');
 const m=(await db.query(`select um.id,um.company_id,um.user_id,u.name from user_memberships um
 join roles r on r.id=um.role_id join users u on u.id=um.user_id
 where um.id=$1 and r.code='company_admin' for update of um`,[id(membershipId,'Membership')])).rows[0];
 if(!m)throw error(404,'Membership de administrador empresarial no encontrada');
 const previous=(await db.query('select * from company_people where company_id=$1 and membership_id=$2 for update',[m.company_id,m.id])).rows[0]||null;
 const p=previous?(await db.query(`update company_people set contract_exempt=true,exemption_reason=$1,exemption_by=$2,exemption_at=now(),updated_by=$2,updated_at=now()
 where company_id=$3 and id=$4 returning *`,[why,actorId,m.company_id,previous.id])).rows[0]:(await db.query(`insert into company_people(company_id,user_id,membership_id,name,contract_exempt,exemption_reason,exemption_by,exemption_at,created_by,updated_by)
 values($1,$2,$3,$4,true,$5,$6,now(),$6,$6) returning *`,[m.company_id,m.user_id,m.id,m.name,why,actorId])).rows[0];
 await repo.record(db,{user:{...actor,id:actorId}},m.company_id,p.id,'platform_exemption',previous,p,why);return p;
}

function registerPersonnelRoutes(app,pool,{resolveActorContext,requirePermission,isPlatformOwner,hashPassword,reauthenticateUser}){
 const gate=(...permissions)=>(req,res,next)=>{
  if(!req.user)return res.status(401).json({error:'Autenticación requerida'});
  const c=resolveActorContext(req);
  if(!c||c.scope!=='company'||!c.company_id||c.actor_type==='unresolved')return res.status(403).json({error:'Contexto empresarial requerido'});
  // Explicit permission list; employment data never inherits a role-name bypass.
  if(!permissions.some(p=>(c.permissions||[]).includes(p)))return res.status(403).json({error:'Permiso empresarial requerido'});
  req.personnelContext=c;return next();
 };
 const flags=req=>{const perms=req.personnelContext.permissions||[];return {can_manage:perms.includes('company.people.manage'),can_accounts:perms.includes(ACCOUNT_PERMISSION),can_licenses:perms.includes('company.licenses.manage')};};
 const full=req=>(req.personnelContext.permissions||[]).some(p=>['company.people.read','company.people.manage'].includes(p));
 const wrap=fn=>async(req,res)=>{
  const send=res.json.bind(res);res.json=value=>send(repo.civilDates(value));
  try{await fn(req,res);}catch(e){const status=e.status||(e.code==='23505'?409:500);res.status(status).json({error:e.status?e.message:e.code==='23505'?'Ya existe ese RUT, correo o vínculo; revisa los datos':'No se pudo completar la operación de personas',...(e.status&&e.code?{code:e.code}:{})});}
 };
 const cid=req=>req.personnelContext.company_id;
 const actor=req=>req.user.id;
 const provisionAccount=async(db,company,req,name)=>{
  const b=req.body||{},role=await repo.companyRole(db,b.role_id);
  if(typeof b.email!=='string'||b.email.length>254||!/^\S+@\S+\.\S+$/.test(b.email.trim())||typeof b.password!=='string'||b.password.length<10||b.password.length>1024)throw error(400,'Correo y contraseña de al menos 10 caracteres requeridos');
  const email=b.email.trim().toLowerCase();
  if((await db.query('select id from users where lower(email)=lower($1)',[email])).rows[0])throw error(409,'El correo ya tiene una cuenta; no se puede asociar automáticamente');
  const n=(await db.query(`select count(*)::int n from (select user_id from user_memberships where company_id=$1 union select id from users where company_id=$1) accounts`,[cid(req)])).rows[0].n;
  if(Number(n)>=Number(company.user_limit))throw error(409,'La empresa alcanzó su límite de usuarios');
  const uid=(await db.query(`insert into users(company_id,role_id,name,email,password_hash,phone,active)
     values($1,$2,$3,$4,$5,$6,true) returning id`,[cid(req),role.id,name,email,await hashPassword(b.password),typeof b.phone==='string'?b.phone.trim().slice(0,80):null])).rows[0].id;
  const mid=(await db.query('insert into user_memberships(user_id,company_id,role_id,active) values($1,$2,$3,true) returning id',[uid,cid(req),role.id])).rows[0].id;
  return {uid,mid,role};
 };
 const provisionDriver=async(db,req,uid,person)=>{
  let did=person.driver_id||null;
  if(did){
   const driver=(await db.query("select id from drivers where company_id=$1 and id=$2 and status='Activo' for update",[cid(req),did])).rows[0];
   if(!driver)throw error(409,'El conductor no pertenece a esta empresa');
   if((await db.query('select id from users where driver_id=$1 and id<>$2',[did,uid])).rows[0])throw error(409,'El conductor ya tiene una cuenta asociada');
  }else did=(await db.query('insert into drivers(company_id,name,rut,status) values($1,$2,$3,\'Activo\') returning id',[cid(req),person.name,person.rut])).rows[0].id;
  await db.query('update users set driver_id=$1 where id=$2 and company_id=$3',[did,uid,cid(req)]);return did;
 };
 const mutate=(permission,fn)=>[gate(permission),wrap(async(req,res)=>{denyExemption(req.body||{});const pid=id(req.params.id,'Persona');const result=await repo.transaction(pool,cid(req),async db=>{
  const p=await repo.person(db,cid(req),pid,{lock:true});return fn(db,p,req);
 });res.json(result);})];
 const readPermissions=['company.people.read','company.people.manage','company.licenses.manage'];

 app.get(BASE,...[gate(...readPermissions),wrap(async(req,res)=>{
  const restricted=!full(req),q=req.query||{},f=flags(req);
  if(restricted&&['condition','access','contract'].some(k=>q[k]))throw error(403,'La vista de licencias no permite filtros laborales');
  const page=Number(q.page??1),page_size=Number(q.page_size??25);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(page_size)||page_size<1||page_size>100)throw error(400,'Paginación no válida');
  const sorts=new Set(['name','rut','job_title','role_code','condition','contract','access','license','id']);
  const sort=q.sort||'name',direction=q.direction||'asc';
  if(!sorts.has(sort)||!['asc','desc'].includes(direction))throw error(400,'Orden no válido');
  if(restricted&&!['name','role_code','license','id'].includes(sort))throw error(403,'Orden no disponible en la vista de licencias');
  if(q.q&&(typeof q.q!=='string'||q.q.length>160))throw error(400,'Búsqueda no válida');
  const driverId=q.driver_id?id(q.driver_id,'Conductor'):null;
  const policy=await repo.policy(pool,cid(req)),today=repo.todayIn(policy.time_zone),rows=await repo.lists(pool,cid(req),{restricted});
  let out=rows.map(row=>{
   const contracts=dates(jsonArray(row.contracts)),conditions=dates(jsonArray(row.conditions)),licenses=dates(jsonArray(row.licenses));
   const current=licenses.find(l=>l.current!==false),condition=conditions.find(c=>!c.cancelled_at&&c.start_date<=today&&c.end_date>=today),contract=contracts.find(c=>!c.voided_at&&c.start_date<=today&&(!c.end_date||c.end_date>=today));
   const label=!current?'missing':current.effective_expiry<today?'expired':'valid';
   if(restricted)return {id:row.id,user_id:row.user_id,membership_id:row.membership_id,name:row.name,driver_id:row.driver_id,role_code:row.role_code,role_name:row.role_name,license_label:label,licenses};
   const access=row.id?eligibility({...row,birth_date:cleanDate(row.birth_date)},{contracts,conditions,licenses},today):missingProfileAccess(row,policy);
   return {id:row.id,user_id:row.user_id,membership_id:row.membership_id,name:row.name,email:row.email,rut:row.rut,job_title:row.job_title,driver_id:row.driver_id,role_code:row.role_code,role_name:row.role_name,condition_label:condition?.type||null,contract_label:row.contract_exempt?'exempt':contract?.type||'missing',access,license_label:label};
  });
  const needle=(q.q||'').toLocaleLowerCase();
  out=out.filter(row=>(!needle||[row.name,...(restricted?[]:[row.email,row.rut,row.job_title])].some(v=>String(v||'').toLocaleLowerCase().includes(needle)))&&(!q.role||row.role_code===q.role)&&(!driverId||sameId(row.driver_id,driverId))&&(!q.condition||row.condition_label===q.condition)&&(!q.contract||row.contract_label===q.contract)&&(!q.access||(q.access==='allowed'?row.access?.allowed:q.access==='blocked'?!row.access?.allowed:false)));
  out.sort((a,b)=>{const key={condition:'condition_label',contract:'contract_label',license:'license_label'}[sort]||sort;const av=sort==='access'?String(a.access?.allowed):String(a[key]??''),bv=sort==='access'?String(b.access?.allowed):String(b[key]??'');return (av.localeCompare(bv,'es')||String(a.id||a.membership_id).localeCompare(String(b.id||b.membership_id)))*(direction==='asc'?1:-1);});
  const total=out.length;let unread=0;
  if(!restricted)unread=(await pool.query(`select count(*)::int n from personnel_notifications n where n.company_id=$1
   and not exists(select 1 from personnel_notification_reads r where r.notification_id=n.id and r.user_id=$2)`,[cid(req),actor(req)])).rows[0]?.n||0;
  res.json({rows:out.slice((page-1)*page_size,page*page_size),total,page,page_size,roles:restricted?[]:await repo.roles(pool),policy:restricted?null:policy,...f,notifications_unread:unread});
 })]);
 app.get(BASE+'/notifications',gate('company.people.read','company.people.manage'),wrap(async(req,res)=>{
  const rows=(await pool.query(`select n.id,n.person_id,n.kind,n.message,n.created_at,r.read_at from personnel_notifications n
   left join personnel_notification_reads r on r.notification_id=n.id and r.user_id=$2 where n.company_id=$1 order by n.id desc limit 200`,[cid(req),actor(req)])).rows;res.json({rows});
 }));
 app.post(BASE+'/notifications/:notificationId/read',gate('company.people.read','company.people.manage'),wrap(async(req,res)=>{
  const row=(await pool.query(`insert into personnel_notification_reads(notification_id,user_id)
   select id,$2 from personnel_notifications where company_id=$1 and id=$3
   on conflict(notification_id,user_id) do update set read_at=excluded.read_at returning notification_id,read_at`,[cid(req),actor(req),id(req.params.notificationId)])).rows[0];
  if(!row)throw error(404,'Notificación no encontrada');res.json(row);
 }));
 app.get(BASE+'/policy/readiness',gate('company.people.read','company.people.manage',ACCOUNT_PERMISSION),wrap(async(req,res)=>res.json(await readiness(pool,cid(req)))));
 app.get(BASE+'/policy',gate('company.people.read','company.people.manage',ACCOUNT_PERMISSION),wrap(async(req,res)=>res.json({policy:await repo.policy(pool,cid(req)),...flags(req)})));
 app.get(BASE+'/roles',gate('company.people.read','company.people.manage',ACCOUNT_PERMISSION),wrap(async(req,res)=>res.json({roles:await repo.roles(pool),...flags(req)})));
 app.post(BASE+'/policy/activate',gate(ACCOUNT_PERMISSION),wrap(async(req,res)=>{
  if(!await reauthenticateUser(pool,actor(req),req.body?.password))throw error(401,'Reautenticación inválida');
  const result=await repo.transaction(pool,cid(req),async db=>{
   const check=await readiness(db,cid(req));if(!check.ready)throw error(409,'Hay personas o memberships pendientes de regularización');
   const policy=(await db.query(`insert into company_personnel_policies(company_id,enforced,activated_by,activated_at)
    values($1,true,$2,now()) on conflict(company_id) do update set enforced=true,activated_by=excluded.activated_by,activated_at=now() returning *`,[cid(req),actor(req)])).rows[0];
   const {writeAudit}=require('./audit');await writeAudit(db,req,{companyId:cid(req),action:'activate',entity:'personnel_policy',entityId:cid(req),beforeData:check.policy,afterData:policy});return policy;
  });res.json({policy:result});
 }));
 app.get(BASE+'/:id',gate(...readPermissions),wrap(async(req,res)=>{
  const pid=id(req.params.id),p=await repo.person(pool,cid(req),pid),f=flags(req);
  if(!full(req)){
   if(p.role_code!=='driver')throw error(404,'Conductor no encontrado');
   const licenses=(await pool.query('select id,classes,issued_date,printed_expiry,effective_expiry,current from person_driver_licenses where company_id=$1 and person_id=$2 order by id desc',[cid(req),pid])).rows;
   return res.json({person:{id:p.id,name:p.name,driver_id:p.driver_id,role_code:p.role_code},licenses,can_manage:false,can_licenses:f.can_licenses});
  }
  const h=await repo.history(pool,cid(req),pid),pol=await repo.policy(pool,cid(req));res.json({person:p,...h,access:eligibility({...p,birth_date:cleanDate(p.birth_date)},h,repo.todayIn(pol.time_zone)),roles:await repo.roles(pool),...f});
 }));

 app.post(BASE,gate('company.people.manage'),wrap(async(req,res)=>{
  const b=req.body||{};denyExemption(b);
  if(b.create_account!==undefined&&typeof b.create_account!=='boolean')throw error(400,'create_account debe ser booleano');
  const f=flags(req);if(b.create_account&&!f.can_accounts)throw error(403,'Crear cuentas requiere administración de usuarios de empresa');
  if(b.license&&!f.can_licenses)throw error(403,'Se requiere gestión de licencias');
  if(b.create_account&&b.membership_id)throw error(400,'Selecciona crear cuenta o regularizar una membership');
  if(!b.create_account&&['password','email','phone','role_id'].some(k=>Object.hasOwn(b,k)))throw error(400,'Los datos de cuenta se envían solo al crear una cuenta nueva');
  const result=await repo.transaction(pool,cid(req),async(db,company)=>{
   const pol=await repo.policy(db,cid(req)),today=repo.todayIn(pol.time_zone),v=checked(domain.validatePerson,b,{draft:!b.create_account,today});
   let uid=null,mid=null,did=null,role=null;
   if(b.create_account){
    ({uid,mid,role}=await provisionAccount(db,company,req,v.name));
   }else if(b.membership_id){
    const m=(await db.query(`select um.id,um.user_id,um.role_id,r.code,r.name role_name,u.driver_id from user_memberships um
     join roles r on r.id=um.role_id join users u on u.id=um.user_id where um.company_id=$1 and um.id=$2 for update of um`,[cid(req),id(b.membership_id)])).rows[0];
    if(!m)throw error(404,'Membership no encontrada en tu empresa');uid=m.user_id;mid=m.id;did=m.driver_id;role={id:m.role_id,code:m.code};
    if(did&&!(await db.query('select id from drivers where company_id=$1 and id=$2',[cid(req),did])).rows[0])throw error(409,'Asociación de conductor incompatible con esta empresa');
   }
   if(role?.code==='driver'&&!did){
    if(!b.create_account)throw error(409,'Asocia el conductor a la cuenta antes de regularizar su persona');
    did=await provisionDriver(db,req,uid,v);
   }
   const p=(await db.query(`insert into company_people(company_id,user_id,membership_id,driver_id,name,rut,birth_date,job_title,created_by,updated_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning *`,[cid(req),uid,mid,did,v.name,v.rut,v.birth_date,v.job_title,actor(req)])).rows[0];
   p.role_code=role?.code;const contracts=[],licenses=[];
   if(b.contract)contracts.push(await contract(db,cid(req),p.id,b.contract,actor(req)));
   if(b.license)licenses.push((await license(db,cid(req),p,b.license,actor(req),today)).after);
   if(b.create_account){const access=eligibility(p,{contracts,conditions:[],licenses},today);if(!access.allowed)throw error(400,'La cuenta activa requiere persona completa, contrato vigente y licencia de conductor vigente');}
   await repo.record(db,req,cid(req),p.id,'create',null,{person:p,contracts,licenses});return p;
  });res.status(201).json({person:result});
 }));
 app.post(BASE+'/:id/account',gate(ACCOUNT_PERMISSION),wrap(async(req,res)=>{
  const b=req.body||{};denyExemption(b);
  if(!flags(req).can_manage)throw error(403,'Habilitar una ficha requiere también gestión de personas');
  if(b.license&&!flags(req).can_licenses)throw error(403,'Se requiere gestión de licencias');
  if(Object.hasOwn(b,'membership_id'))throw error(400,'Esta ruta crea una cuenta nueva; no vincula cuentas existentes');
  const pid=id(req.params.id,'Persona');
  const result=await repo.transaction(pool,cid(req),async(db,company)=>{
   const before=await repo.person(db,cid(req),pid,{lock:true});
   if(before.user_id||before.membership_id)throw error(409,'Esta ficha ya tiene una cuenta empresarial');
   const pol=await repo.policy(db,cid(req)),today=repo.todayIn(pol.time_zone);
   const input={...before,birth_date:cleanDate(before.birth_date)};
   for(const key of ['name','rut','birth_date','job_title'])if(Object.hasOwn(b,key))input[key]=b[key];
   const value=checked(domain.validatePerson,input,{today});
   const {uid,mid,role}=await provisionAccount(db,company,req,value.name);
   const did=role.code==='driver'?await provisionDriver(db,req,uid,{...value,driver_id:before.driver_id}):before.driver_id;
   const after=(await db.query(`update company_people set user_id=$1,membership_id=$2,driver_id=$3,name=$4,rut=$5,birth_date=$6,job_title=$7,updated_by=$8,updated_at=now()
    where company_id=$9 and id=$10 and user_id is null and membership_id is null returning *`,[uid,mid,did,value.name,value.rut,value.birth_date,value.job_title,actor(req),cid(req),pid])).rows[0];
   if(!after)throw error(409,'La ficha ya fue habilitada por otra solicitud');
   after.role_code=role.code;after.account_active=true;after.membership_active=true;
   if(b.contract)await contract(db,cid(req),pid,b.contract,actor(req));
   if(b.license)await license(db,cid(req),after,b.license,actor(req),today);
   const h=await repo.history(db,cid(req),pid,{events:false}),access=eligibility(after,h,today);
   if(!access.allowed)throw error(409,'La cuenta activa requiere persona completa, contrato vigente, ausencia de condiciones bloqueantes y licencia de conductor vigente');
   await repo.record(db,req,cid(req),pid,'account_create',before,{person:after,access},typeof b.reason==='string'?reason(b.reason):null);
   return {person:after,access};
  });res.status(201).json(result);
 }));
 app.patch(BASE+'/:id',...mutate('company.people.manage',async(db,p,req)=>{
  const why=reason(req.body.reason),pol=await repo.policy(db,cid(req)),v=checked(domain.validatePerson,req.body,{partial:true,draft:!p.user_id,today:repo.todayIn(pol.time_zone)});
  if(!Object.keys(v).length)throw error(400,'No hay cambios personales');
  const fields=[],values=[];for(const key of ['name','rut','birth_date','job_title'])if(Object.hasOwn(v,key)){values.push(v[key]);fields.push(`${key}=$${values.length}`);}
  values.push(actor(req),cid(req),p.id);
  const after=(await db.query(`update company_people set ${fields.join(',')},updated_by=$${values.length-2},updated_at=now() where company_id=$${values.length-1} and id=$${values.length} returning *`,values)).rows[0];
  await repo.record(db,req,cid(req),p.id,'update',p,after,why);return {person:after};
 }));
 app.post(BASE+'/:id/contracts',...mutate('company.people.manage',async(db,p,req)=>{
  const row=await contract(db,cid(req),p.id,req.body,actor(req));await repo.record(db,req,cid(req),p.id,'contract_create',null,row);return {contract:row};
 }));
 for(const action of ['void','replace'])app.post(BASE+'/:id/contracts/:contractId/'+action,...mutate('company.people.manage',async(db,p,req)=>{
  const why=reason(req.body.reason),contractId=id(req.params.contractId);
  const before=(await db.query('select * from person_contracts where company_id=$1 and person_id=$2 and id=$3 for update',[cid(req),p.id,contractId])).rows[0];
  if(!before)throw error(404,'Contrato no encontrado');if(before.voided_at)throw error(409,'El contrato ya está anulado');
  const after=(await db.query('update person_contracts set voided_at=now(),voided_by=$1 where company_id=$2 and person_id=$3 and id=$4 returning *',[actor(req),cid(req),p.id,contractId])).rows[0];
  const replacement=action==='replace'?await contract(db,cid(req),p.id,req.body.contract,actor(req)):null;
  if(sameId(p.user_id,actor(req))){
   const h=await repo.history(db,cid(req),p.id,{events:false}),pol=await repo.policy(db,cid(req));
   if(!eligibility(p,h,repo.todayIn(pol.time_zone)).allowed)throw error(403,'No puedes dejar tu propio acceso sin contrato habilitante');
  }
  await repo.record(db,req,cid(req),p.id,'contract_'+action,before,{voided:after,replacement},why);return {contract:replacement||after};
 }));
 app.post(BASE+'/:id/conditions',...mutate('company.people.manage',async(db,p,req)=>{
  if(sameId(p.user_id,actor(req)))throw error(403,'No puedes bloquear tu propio acceso empresarial');
  const v=checked(domain.validateCondition,req.body);
  const row=(await db.query(`insert into person_conditions(company_id,person_id,type,start_date,end_date,created_by)
   values($1,$2,$3,$4,$5,$6) returning *`,[cid(req),p.id,v.type,v.start_date,v.end_date,actor(req)])).rows[0];
  await repo.record(db,req,cid(req),p.id,'condition_create',null,row);return {condition:row};
 }));
 for(const action of ['cancel','extend'])app.post(BASE+'/:id/conditions/:conditionId/'+action,...mutate('company.people.manage',async(db,p,req)=>{
  const why=reason(req.body.reason),conditionId=id(req.params.conditionId);
  const before=(await db.query('select * from person_conditions where company_id=$1 and person_id=$2 and id=$3 for update',[cid(req),p.id,conditionId])).rows[0];
  if(!before)throw error(404,'Condición no encontrada');if(before.cancelled_at)throw error(409,'La condición ya está cancelada');
  let after;
  if(action==='extend'){
   if(sameId(p.user_id,actor(req)))throw error(403,'No puedes prolongar un bloqueo de tu propio acceso');
   const v=checked(domain.validateCondition,{...before,start_date:cleanDate(before.start_date),end_date:req.body.end_date});
   if(v.end_date<=cleanDate(before.end_date))throw error(400,'La nueva fecha debe prolongar la condición');
   after=(await db.query('update person_conditions set end_date=$1 where company_id=$2 and person_id=$3 and id=$4 returning *',[v.end_date,cid(req),p.id,conditionId])).rows[0];
  }else after=(await db.query('update person_conditions set cancelled_at=now(),cancelled_by=$1 where company_id=$2 and person_id=$3 and id=$4 returning *',[actor(req),cid(req),p.id,conditionId])).rows[0];
  await repo.record(db,req,cid(req),p.id,'condition_'+action,before,after,why);return {condition:after};
 }));
 app.post(BASE+'/:id/licenses',...mutate('company.licenses.manage',async(db,p,req)=>{
  const pol=await repo.policy(db,cid(req)),result=await license(db,cid(req),p,req.body,actor(req),repo.todayIn(pol.time_zone));
  await repo.record(db,req,cid(req),p.id,'license_renew',result.before,result.after);return {license:result.after};
 }));
 app.patch(BASE+'/:id/access',...mutate(ACCOUNT_PERMISSION,async(db,p,req)=>{
  const why=reason(req.body.reason);if(typeof req.body.active!=='boolean')throw error(400,'active debe ser booleano');
  if(!p.membership_id)throw error(409,'La persona no tiene cuenta empresarial');
  if(sameId(p.user_id,actor(req)))throw error(403,'No puedes modificar tu propia membership');
  const before=(await db.query('select id,active from user_memberships where company_id=$1 and id=$2 and user_id=$3 for update',[cid(req),p.membership_id,p.user_id])).rows[0];
  if(!before)throw error(404,'Membership no encontrada');
  const after=(await db.query('update user_memberships set active=$1,updated_at=now() where company_id=$2 and id=$3 and user_id=$4 returning id,active',[req.body.active,cid(req),p.membership_id,p.user_id])).rows[0];
  await repo.record(db,req,cid(req),p.id,'membership_access',before,after,why);return {membership:after};
 }));
 app.put(BASE+'/:id/role',...mutate(ACCOUNT_PERMISSION,async(db,p,req)=>{
  const why=reason(req.body.reason);if(!p.membership_id)throw error(409,'La persona no tiene membership');
  if(sameId(p.user_id,actor(req)))throw error(403,'No puedes modificar tu propio rol');
  const role=await repo.companyRole(db,req.body.role_id);
  const h=await repo.history(db,cid(req),p.id,{events:false}),pol=await repo.policy(db,cid(req));
  if(role.code==='driver'&&(!p.driver_id||!eligibility({...p,role_code:'driver',account_active:true,membership_active:true}, {...h,conditions:[]},repo.todayIn(pol.time_zone)).allowed))throw error(409,'Regulariza persona, contrato, asociación y licencia antes de asignar rol conductor');
  const after=(await db.query('update user_memberships set role_id=$1,updated_at=now() where company_id=$2 and id=$3 and user_id=$4 returning id,role_id',[role.id,cid(req),p.membership_id,p.user_id])).rows[0];
  if(!after)throw error(404,'Membership no encontrada');
  if(role.code!=='company_admin'&&p.contract_exempt){
   const revoked=(await db.query(`update company_people set contract_exempt=false,exemption_reason=$1,exemption_by=$2,exemption_at=now(),updated_by=$2,updated_at=now()
    where company_id=$3 and id=$4 returning *`,['Exención revocada por cambio de rol: '+why,actor(req),cid(req),p.id])).rows[0];
   await repo.record(db,req,cid(req),p.id,'exemption_role_revoke',p,revoked,why);
  }
  await repo.record(db,req,cid(req),p.id,'membership_role',{role_id:p.role_id},after,why);return {membership:after};
 }));
 app.post('/api/platform/personnel/:membershipId/exemption',wrap(async(req,res)=>{
  if(!req.user)return res.status(401).json({error:'Autenticación requerida'});
  const c=resolveActorContext(req);if(c?.actor_type!=='platform'||!c.permissions?.includes('platform.users.manage'))throw error(403,'Se requiere administración de usuarios de plataforma');
  const b=req.body||{};if(typeof b.exempt!=='boolean')throw error(400,'exempt debe ser booleano');const why=reason(b.reason),mid=id(req.params.membershipId);
  // Discover company only through the authorized target membership, never body.
  const m=(await pool.query("select um.company_id from user_memberships um join roles r on r.id=um.role_id where um.id=$1 and r.code='company_admin'",[mid])).rows[0];if(!m)throw error(404,'Administrador empresarial no encontrado');
  const p=await repo.transaction(pool,m.company_id,async db=>{
   if(b.exempt)return createBootstrapExemption(db,{membershipId:mid,actor:{...req.user,...c,id:actor(req)},reason:why});
   const membership=(await db.query("select um.id from user_memberships um join roles r on r.id=um.role_id where um.company_id=$1 and um.id=$2 and r.code='company_admin' for update of um",[m.company_id,mid])).rows[0];if(!membership)throw error(404,'Administrador empresarial no encontrado');
   const before=(await db.query('select * from company_people where company_id=$1 and membership_id=$2 for update',[m.company_id,mid])).rows[0];if(!before)throw error(404,'Persona no encontrada');
   const after=(await db.query('update company_people set contract_exempt=false,exemption_reason=$1,exemption_by=$2,exemption_at=now(),updated_by=$2,updated_at=now() where company_id=$3 and id=$4 returning *',[why,actor(req),m.company_id,before.id])).rows[0];
   await repo.record(db,req,m.company_id,before.id,'platform_exemption_revoke',before,after,why);return after;
  });res.json({person:p});
 }));
}
module.exports={registerPersonnelRoutes,createBootstrapExemption};
