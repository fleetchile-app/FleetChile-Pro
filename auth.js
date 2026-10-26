const crypto = require('crypto');
const {writeAudit} = require('./audit');
const {registerDriverUserAssignmentRoutes}=require('./driver-user-assignment');
const {registerCompanyProfileRoutes}=require('./company-profile');
const {registerPersonnelRoutes,createBootstrapExemption}=require('./personnel-api');
const {loadEligibility,enforcePersonnelAccess}=require('./personnel-access');

const clean = v => typeof v === 'string' ? v.trim() : v;
const hashPassword = password => new Promise((resolve,reject) => {
  const salt = crypto.randomBytes(16).toString('hex');
  crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err,key) => {
    if (err) return reject(err);
    resolve(`scrypt$${salt}$${key.toString('hex')}`);
  });
});
const verifyPassword = (password, stored) => new Promise(resolve => {
  try {
    const [scheme,salt,hex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return resolve(false);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err,key) => {
      if (err) return resolve(false);
      const a = Buffer.from(hex,'hex'); const b = Buffer.from(key);
      resolve(a.length === b.length && crypto.timingSafeEqual(a,b));
    });
  } catch { resolve(false); }
});
const token = () => crypto.randomBytes(32).toString('hex');
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');

function resolveEffectiveMembership(user){
  const platforms=(user.platform_memberships||[]).filter(x=>x.active!==false);
  if(platforms.length){const p=platforms[0];return {actor_type:'platform',scope:'platform',company_id:null,membership_id:null,platform_membership_id:p.id||null,role:p.role_code||p.code||null,permissions:[...new Set([...(p.permissions||[]),...(user.legacy_permissions||[])])],reason:null};}
  const memberships=(user.memberships||[]).filter(x=>x.active!==false);
  if(memberships.length!==1)return memberships.length>1?{actor_type:'unresolved',scope:null,company_id:null,membership_id:null,platform_membership_id:null,role:null,permissions:[],reason:'company_context_required'}:{actor_type:'legacy',scope:user.company_id?'company':null,company_id:user.company_id||null,membership_id:null,platform_membership_id:null,role:user.role_code||null,permissions:user.legacy_permissions||user.permissions||[],reason:'no_active_membership'};
  const m=memberships[0];return {actor_type:'company',scope:'company',company_id:m.company_id,membership_id:m.id||null,platform_membership_id:null,role:m.role_code||m.code||null,permissions:m.permissions||[],reason:null};
}
function isPlatformOwner(user){
  return !!(user?.actor_type==='platform' && user?.platform_membership_id && user?.ownership_role && user?.ownership_active===true);
}

async function userView(pool,userId){
  const r = await pool.query(`select u.id,u.name,u.email,u.phone,u.company_id,u.driver_id,u.role_id,
    lr.code role_code,lr.name role_name,c.legal_name company_name,
    coalesce((select json_agg(json_build_object('id',um.id,'company_id',um.company_id,'active',um.active,'role_code',mr.code,'role_name',mr.name,'permissions',coalesce((select json_agg(p.code order by p.code) from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=um.role_id and p.scope='company'),'[]'::json))) from user_memberships um left join roles mr on mr.id=um.role_id where um.user_id=u.id and um.active=true),'[]'::json) memberships,
    coalesce((select json_agg(json_build_object('id',pm.id,'active',pm.active,'role_code',pr.code,'role_name',pr.name,'permissions',coalesce((select json_agg(p.code order by p.code) from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=pm.role_id and p.scope='platform'),'[]'::json))) from platform_memberships pm left join roles pr on pr.id=pm.role_id where pm.user_id=u.id and pm.active=true),'[]'::json) platform_memberships,
    coalesce((select json_agg(p.code order by p.code) from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=u.role_id),'[]'::json) legacy_permissions,
    po.owner_type ownership_role,po.slot ownership_slot,po.active ownership_active,u.must_change_password,
    (select jsonb_build_object(
      'company_id',um0.company_id,
      'policy',jsonb_build_object('enforced',coalesce((select pp.enforced from company_personnel_policies pp where pp.company_id=um0.company_id),true),'time_zone',coalesce((select pp.time_zone from company_personnel_policies pp where pp.company_id=um0.company_id),'America/Santiago'),'regularization_before',(select pp.regularization_before from company_personnel_policies pp where pp.company_id=um0.company_id)),
      'regularization_eligible',case when p0.id is null and coalesce((select pp.enforced from company_personnel_policies pp where pp.company_id=um0.company_id),true)=false and (select pp.regularization_before from company_personnel_policies pp where pp.company_id=um0.company_id) is not null and um0.created_at<=(select pp.regularization_before from company_personnel_policies pp where pp.company_id=um0.company_id) and u.created_at<=(select pp.regularization_before from company_personnel_policies pp where pp.company_id=um0.company_id) then true else false end,
      'person',case when p0.id is null then null else jsonb_build_object('id',p0.id,'user_id',p0.user_id,'membership_id',p0.membership_id,'driver_id',p0.driver_id,'name',p0.name,'rut',p0.rut,'birth_date',p0.birth_date,'job_title',p0.job_title,'contract_exempt',coalesce(p0.contract_exempt,false),'exemption_by',p0.exemption_by,'exemption_at',p0.exemption_at) end,
      'membership',jsonb_build_object('active',um0.active,'role_code',r0.code),
      'account_active',u.active,
      'contracts',coalesce((select jsonb_agg(c) from person_contracts c where c.company_id=um0.company_id and c.person_id=p0.id),'[]'::jsonb),
      'conditions',coalesce((select jsonb_agg(c) from person_conditions c where c.company_id=um0.company_id and c.person_id=p0.id),'[]'::jsonb),
      'licenses',coalesce((select jsonb_agg(l) from person_driver_licenses l where l.company_id=um0.company_id and l.person_id=p0.id),'[]'::jsonb)
    ) from (
      select um.id,um.user_id,um.company_id,um.active,um.role_id,um.created_at,false legacy_membership
      from user_memberships um where um.user_id=u.id
      union all
      select null::bigint,u.id,u.company_id,true,u.role_id,u.created_at,true
      where u.company_id is not null and not exists(select 1 from user_memberships umx where umx.user_id=u.id)
    ) um0 left join company_people p0 on p0.company_id=um0.company_id and (p0.user_id=u.id or p0.membership_id=um0.id) left join roles r0 on r0.id=um0.role_id order by um0.active desc,um0.id desc nulls last limit 1) personnel_state
    from users u left join roles lr on lr.id=u.role_id left join companies c on c.id=u.company_id left join platform_owners po on po.user_id=u.id and po.active=true where u.id=$1 and u.active=true`,[userId]);
  const row=r.rows[0];if(!row)return null;
  const effective=resolveEffectiveMembership(row);
  const hasCompanyMembership=(row.memberships||[]).some(m=>m.active!==false)||row.personnel_state!==null&&row.personnel_state!==undefined;
  const personnelState=effective.scope==='company'&&hasCompanyMembership?row.personnel_state:null;
  const result={...row,scope:effective.scope,company_id:effective.company_id,role_code:effective.role||row.role_code,role_name:effective.role?((effective.actor_type==='legacy'?row.role_name:null)||effective.role):row.role_name,permissions:effective.permissions, membership_id:effective.membership_id,platform_membership_id:effective.platform_membership_id,actor_type:effective.actor_type,context_reason:effective.reason,legacy_company_id:row.company_id,legacy_role_code:row.role_code,ownership_role:row.ownership_role||null,ownership_slot:row.ownership_slot||null,ownership_active:row.ownership_active===true};
  Object.defineProperty(result,'personnel_state',{value:personnelState,enumerable:false,configurable:false,writable:false});
  return result;
}

async function userAuditView(db,userId){
  const r=await db.query(`select u.id,u.name,u.email,u.phone,u.active,u.last_login_at,u.company_id,u.role_id,u.created_at,u.updated_at,
    r.code role_code,r.name role_name,c.legal_name company_name
    from users u left join roles r on r.id=u.role_id left join companies c on c.id=u.company_id where u.id=$1`,[userId]);
  return r.rows[0] || null;
}

async function authenticateToken(pool,req){
  const h=req.get('authorization')||'';
  const raw=h.startsWith('Bearer ')?h.slice(7):'';
  if(!raw)return null;
  const r=await pool.query(`select s.user_id from user_sessions s where s.token_hash=$1 and s.expires_at>now()`,[tokenHash(raw)]);
  if(!r.rowCount)return null;
  const user=await userView(pool,r.rows[0].user_id);
  if(user) await pool.query('update user_sessions set last_seen_at=now() where token_hash=$1',[tokenHash(raw)]);
  return user;
}

function registerAuthRoutes(app,pool){
  app.get('/api/auth/status',async(req,res)=>{
    try { const r=await pool.query('select count(*)::int n from users'); res.json({setupRequired:r.rows[0].n===0}); }
    catch { res.status(500).json({error:'No se pudo consultar el estado de autenticación'}); }
  });

  app.post('/api/auth/setup',async(req,res)=>{
    const b=req.body||{};
    if(!clean(b.name)||!clean(b.email)||!clean(b.password)) return res.status(400).json({error:'Nombre, correo y contraseña son obligatorios'});
    if(String(b.password).length<10) return res.status(400).json({error:'La contraseña debe tener al menos 10 caracteres'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const count=await client.query('select count(*)::int n from users');
      if(count.rows[0].n!==0){await client.query('ROLLBACK');return res.status(409).json({error:'La configuración inicial ya fue realizada'});}
      const company=(await client.query('select id from companies where active=true order by id limit 1')).rows[0];
      const role=(await client.query("select id from roles where code='admin'")).rows[0];
      const password_hash=await hashPassword(String(b.password));
      const u=(await client.query('insert into users(company_id,role_id,name,email,password_hash,phone) values($1,$2,$3,$4,$5,$6) returning id',[company?.id||null,role.id,clean(b.name),clean(b.email).toLowerCase(),password_hash,clean(b.phone)||null])).rows[0];
      const user=await userView(client,u.id);
      if(!user) throw new Error('No se pudo obtener el administrador creado');
      await writeAudit(client,req,{companyId:company?.id||null,action:'create',entity:'user',entityId:u.id,afterData:user});
      await client.query('COMMIT');
      res.status(201).json({ok:true,user});
    } catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.code==='23505'?'El correo ya existe':'No se pudo crear el administrador'});} finally {client.release();}
  });

  app.post('/api/auth/login',async(req,res)=>{
    const email=clean(req.body?.email)?.toLowerCase(); const password=String(req.body?.password||'');
    if(!email||!password) return res.status(400).json({error:'Correo y contraseña son obligatorios'});
    try {
      const r=await pool.query('select id,password_hash from users where lower(email)=lower($1) and active=true',[email]);
      if(!r.rowCount || !(await verifyPassword(password,r.rows[0].password_hash))) return res.status(401).json({error:'Credenciales inválidas'});
      const raw=token();
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("insert into user_sessions(user_id,token_hash,expires_at,ip,user_agent) values($1,$2,now()+interval '12 hours',$3,$4)",[r.rows[0].id,tokenHash(raw),req.ip,req.get('user-agent')||null]);
        await client.query('update users set last_login_at=now() where id=$1',[r.rows[0].id]);
        const user=await userView(client,r.rows[0].id);
        if(!user) throw new Error('Usuario no disponible después de autenticar');
        if(user.scope==='company'&&user.company_id){
          const hasCompanyMembership=(user.memberships||[]).some(m=>m.active!==false);
          if(hasCompanyMembership&&!user.personnel_state)throw new Error('Snapshot de personal ausente para membership empresarial');
          if(!user.personnel_state){await client.query('COMMIT');res.json({token:raw,user});return;}
          const snapshot=user.personnel_state;
          if(!snapshot?.policy||!Object.hasOwn(snapshot,'person'))throw new Error('Snapshot de personal ausente o inválido');
          const eligibility=await loadEligibility(client,{companyId:user.company_id,userId:user.id,snapshot,now:new Date(),lock:Boolean(snapshot.policy.enforced||snapshot.person)});
          if(!eligibility.allowed){
            await client.query('ROLLBACK');
            return res.status(403).json({code:'PERSONNEL_ACCESS_BLOCKED',error:'Acceso bloqueado por regularización de personal'});
          }
        }
        await client.query('COMMIT');
        res.json({token:raw,user});
      } catch {
        await client.query('ROLLBACK');
        res.status(500).json({error:'No se pudo iniciar sesión'});
      } finally {client.release();}
    } catch { res.status(500).json({error:'No se pudo iniciar sesión'}); }
  });

  app.post('/api/auth/logout',async(req,res)=>{const h=req.get('authorization')||'';const raw=h.startsWith('Bearer ')?h.slice(7):'';if(raw) await pool.query('delete from user_sessions where token_hash=$1',[tokenHash(raw)]);res.json({ok:true});});

  app.get('/api/auth/me',async(req,res)=>{
    try { const user=await authenticateToken(pool,req); if(!user)return res.status(401).json({error:'No autenticado'}); res.json({user}); }
    catch { res.status(401).json({error:'No se pudo validar la sesión'}); }
  });

  app.post('/api/auth/change-password',async(req,res)=>{const user=await authenticateToken(pool,req).catch(()=>null);if(!user)return res.status(401).json({error:'Autenticación requerida'});const current=String(req.body?.current_password||''),next=String(req.body?.new_password||''),confirm=String(req.body?.confirm_password||'');if(!current||next.length<10||next!==confirm)return res.status(400).json({error:'La contraseña nueva debe tener al menos 10 caracteres y coincidir'});if(!(await reauthenticateUser(pool,user.id,current)))return res.status(403).json({error:'La contraseña actual no es válida'});const client=await pool.connect();try{await client.query('BEGIN');const hash=await hashPassword(next);await client.query('update users set password_hash=$1,must_change_password=false,updated_at=now() where id=$2',[hash,user.id]);await writeAudit(client,req,{companyId:null,action:'password_change',entity:'user',entityId:user.id,afterData:{must_change_password:false}});await client.query('COMMIT');res.json({ok:true})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:'No se pudo cambiar la contraseña'})}finally{client.release()}});

  app.post('/api/auth/company-context',authMiddleware.bind(null,pool),async(req,res)=>{
    if(req.user.actor_type!=='platform'||!req.user.platform_membership_id)return res.status(403).json({error:'Solo un administrador de plataforma puede seleccionar empresa'});
    if(!isPlatformOwner(req.user)&&!(req.user.permissions||[]).some(p=>p==='platform.context.switch'||p==='platform.users.manage'))return res.status(403).json({error:'Permiso de cambio de contexto requerido'});
    const companyId=Number(req.body?.company_id);
    if(!Number.isInteger(companyId)||companyId<1)return res.status(400).json({error:'Empresa no válida'});
    const company=(await pool.query('select id,legal_name from companies where id=$1 and active=true',[companyId])).rows[0];
    if(!company)return res.status(404).json({error:'Empresa no encontrada'});
    await writeAudit(pool,req,{companyId:company.id,action:'context_switch',entity:'company_context',entityId:company.id,afterData:{company_id:company.id}});
    res.json({company});
  });

  const userManagement = (req,res,next)=>{
    const u=req.user;
    const legacy=u?.role_code==='admin'&&!u?.membership_id&&!u?.platform_membership_id;
    const allowed=isPlatformOwner(u)||(u?.scope==='platform'&&u.permissions?.includes('platform.users.manage'))||
      (u?.scope==='company'&&u?.membership_id&&u.permissions?.includes('company.users.manage'))||legacy;
    if(allowed)return next();
    res.status(403).json({error:'Permiso de administración de usuarios requerido'});
  };
  const protectedUserRoutes = [authMiddleware.bind(null,pool), userManagement];
  registerCompanyProfileRoutes(app,pool,{protectedUserRoutes,resolveActorContext});
  registerDriverUserAssignmentRoutes(app,pool,{protectedUserRoutes,resolveActorContext,userView});
  const membershipActor = (req,res,next) => {
    const c=resolveActorContext(req);
    if(!c || c.actor_type==='unresolved') return res.status(403).json({error:c?.reason||'Contexto empresarial requerido'});
    if(isPlatformOwner(req.user)||(c.actor_type==='platform' && c.permissions.includes('platform.users.manage'))) { req.actorContext=c; return next(); }
    if(c.actor_type==='company' && c.permissions.includes('company.users.manage') && c.company_id) { req.actorContext=c; return next(); }
    if(c.actor_type==='legacy' && c.role==='admin') { req.actorContext=c; return next(); }
    return res.status(403).json({error:'Permiso de administración de memberships requerido'});
  };
  const roleForScope = async (db,roleId,scope) => {
    const r=(await db.query('select id,code,name from roles where id=$1',[roleId])).rows[0];
    if(!r) return null;
    const platformRole=new Set(['platform_superadmin']).has(r.code);
    const companyRole=new Set(['company_admin','manager','operations','maintenance','driver','viewer','administrative']).has(r.code);
    return (scope==='platform'?platformRole:companyRole)?r:null;
  };
  const membershipTargetCompany = (context,requested) => {
    if(context.actor_type==='company') return context.company_id;
    if(context.actor_type==='legacy') return requested||context.company_id||null;
    return requested||null;
  };
  const companyUserTarget = async (db,userId,companyId) => (await db.query(`select u.id,
    exists(select 1 from company_people cp where cp.company_id=$2 and (cp.user_id=u.id or cp.membership_id in (select um0.id from user_memberships um0 where um0.user_id=u.id and um0.company_id=$2))) has_personnel_profile,
    exists(select 1 from user_memberships other where other.user_id=u.id and other.active=true and other.company_id<>$2) shared_company,
    exists(select 1 from platform_memberships pm where pm.user_id=u.id and pm.active=true) active_platform
    from users u where u.id=$1 and (
      exists(select 1 from user_memberships own where own.user_id=u.id and own.company_id=$2)
      or (u.company_id=$2 and not exists(select 1 from user_memberships other where other.user_id=u.id and other.active=true and other.company_id<>$2))
    ) for update of u`,[userId,companyId])).rows[0];
  const preventSelfMembershipMutation = table => async (req,res,next) => {
    if(req.body?.role_id===undefined && req.body?.active===undefined && req.body?.company_id===undefined)return next();
    try {
      const r=await pool.query(`select user_id from ${table} where id=$1`,[req.params.id]);
      if(r.rows[0]?.user_id===req.user.id)return res.status(403).json({error:'No puedes modificar tu propia membership'});
      next();
    } catch { res.status(500).json({error:'No se pudo validar la membership'}); }
  };
  app.get('/api/users/:id/memberships',... [authMiddleware.bind(null,pool),membershipActor],async(req,res)=>{
    const c=req.actorContext;const requested=Number(req.query.company_id||0);const cid=membershipTargetCompany(c,Number.isInteger(requested)&&requested>0?requested:null);
    if(c.actor_type==='company' && requested && requested!==c.company_id)return res.status(403).json({error:'Empresa no autorizada'});
    try{const r=await pool.query(`select um.id,um.user_id,um.company_id,um.role_id,um.active,um.created_at,um.updated_at,r.code role_code,r.name role_name from user_memberships um join roles r on r.id=um.role_id where um.user_id=$1 and ($2::bigint is null or um.company_id=$2) and ($3::boolean=true or um.company_id=$4) order by um.id`,[req.params.id,cid,c.scope==='platform'&&!cid,cid]);res.json(r.rows)}catch{res.status(500).json({error:'No se pudieron consultar las memberships'})}
  });
  app.get('/api/companies/:id/memberships',... [authMiddleware.bind(null,pool),membershipActor],async(req,res)=>{
    const c=req.actorContext,cid=Number(req.params.id);if(!Number.isInteger(cid)||cid<1)return res.status(400).json({error:'Empresa no válida'});if(c.actor_type==='company'&&c.company_id!==cid)return res.status(403).json({error:'Empresa no autorizada'});
    try{const r=await pool.query(`select um.id,um.user_id,um.company_id,um.role_id,um.active,u.name,u.email,r.code role_code,r.name role_name from user_memberships um join users u on u.id=um.user_id join roles r on r.id=um.role_id where um.company_id=$1 order by um.id`,[cid]);res.json(r.rows)}catch{res.status(500).json({error:'No se pudieron consultar las memberships'})}
  });
  app.post('/api/users/:id/memberships',... [authMiddleware.bind(null,pool),membershipActor],async(req,res)=>{
    const c=req.actorContext,requested=Number(req.body?.company_id),cid=membershipTargetCompany(c,Number.isInteger(requested)&&requested>0?requested:null);if(!cid)return res.status(400).json({error:'company_id es obligatorio'});if(c.actor_type==='company'&&cid!==c.company_id)return res.status(403).json({error:'Empresa no autorizada'});
    const client=await pool.connect();try{await client.query('BEGIN');
      if(c.actor_type==='company'){
        const target=await companyUserTarget(client,req.params.id,cid);
        if(!target)throw Object.assign(new Error(),{status:404,message:'Usuario no administrable en tu empresa'});
        if(target.active_platform)throw Object.assign(new Error(),{status:403,message:'No puedes vincular una identidad de plataforma'});
      }
      const company=(await client.query('select id from companies where id=$1 and active=true',[cid])).rows[0];if(!company)throw Object.assign(new Error(),{status:404,message:'Empresa no encontrada'});const role=await roleForScope(client,req.body?.role_id,'company');if(!role)throw Object.assign(new Error(),{status:400,message:'Rol de empresa no válido'});const r=await client.query('insert into user_memberships(user_id,company_id,role_id,active) values($1,$2,$3,$4) returning *',[req.params.id,cid,role.id,req.body?.active!==false]);await writeAudit(client,req,{companyId:cid,action:'create',entity:'user_membership',entityId:r.rows[0].id,afterData:r.rows[0]});await client.query('COMMIT');res.status(201).json(r.rows[0]);}catch(e){await client.query('ROLLBACK');res.status(e.status||400).json({error:e.message||'No se pudo crear la membership'});}finally{client.release();}
  });
  app.patch('/api/user-memberships/:id',... [authMiddleware.bind(null,pool),membershipActor,preventSelfMembershipMutation('user_memberships')],async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const before=(await client.query(`select um.*,exists(select 1 from company_people cp where cp.company_id=um.company_id and (cp.membership_id=um.id or cp.user_id=um.user_id)) has_personnel_profile from user_memberships um where um.id=$1 for update`,[req.params.id])).rows[0];if(!before){await client.query('ROLLBACK');return res.sendStatus(404)}if(req.actorContext.actor_type==='company'&&before.company_id!==req.actorContext.company_id){await client.query('ROLLBACK');return res.sendStatus(403)}if(before.has_personnel_profile===true&&(req.body?.role_id!==undefined||req.body?.active!==undefined)){await client.query('ROLLBACK');return res.status(409).json({code:'PERSONNEL_ROUTE_REQUIRED',error:'Los cambios de rol y acceso de personal registrado deben hacerse desde Personas y accesos'});}const role=req.body?.role_id===undefined?{id:before.role_id}:await roleForScope(client,req.body.role_id,'company');if(!role)throw new Error('Rol de empresa no válido');const active=req.body?.active===undefined?before.active:!!req.body.active;const r=await client.query('update user_memberships set role_id=$1,active=$2,updated_at=now() where id=$3 returning *',[role.id,active,req.params.id]);await writeAudit(client,req,{companyId:before.company_id,action:before.role_id!==role.id?'role_change':active!==before.active?(active?'activate':'deactivate'):'update',entity:'user_membership',entityId:req.params.id,beforeData:before,afterData:r.rows[0]});await client.query('COMMIT');res.json(r.rows[0]);}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'No se pudo actualizar la membership'});}finally{client.release();}
  });
  app.post('/api/users/:id/platform-membership',... [authMiddleware.bind(null,pool),membershipActor],async(req,res)=>{
    if(req.actorContext.actor_type!=='platform')return res.status(403).json({error:'Solo plataforma puede administrar memberships de plataforma'});const client=await pool.connect();try{await client.query('BEGIN');const role=await roleForScope(client,req.body?.role_id,'platform');if(!role)throw new Error('Rol de plataforma no válido');const r=await client.query('insert into platform_memberships(user_id,role_id,active) values($1,$2,$3) returning *',[req.params.id,role.id,req.body?.active!==false]);await writeAudit(client,req,{companyId:null,action:'create',entity:'platform_membership',entityId:r.rows[0].id,afterData:r.rows[0]});await client.query('COMMIT');res.status(201).json(r.rows[0]);}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'No se pudo crear la membership de plataforma'});}finally{client.release();}
  });
  app.get('/api/users/:id/platform-membership',... [authMiddleware.bind(null,pool),membershipActor],async(req,res)=>{
    if(req.actorContext.actor_type!=='platform')return res.status(403).json({error:'Solo plataforma puede consultar memberships de plataforma'});
    try{const r=await pool.query('select pm.id,pm.user_id,pm.role_id,pm.active,pm.created_at,pm.updated_at,r.code role_code,r.name role_name from platform_memberships pm join roles r on r.id=pm.role_id where pm.user_id=$1',[req.params.id]);res.json(r.rows[0]||null)}catch{res.status(500).json({error:'No se pudo consultar la membership de plataforma'})}
  });
  app.get('/api/platform-memberships',... [authMiddleware.bind(null,pool),membershipActor],async(req,res)=>{
    if(req.actorContext.actor_type!=='platform')return res.status(403).json({error:'Solo plataforma puede consultar memberships de plataforma'});
    try{const r=await pool.query('select pm.id,pm.user_id,pm.role_id,pm.active,pm.created_at,pm.updated_at,u.name,u.email,r.code role_code,r.name role_name from platform_memberships pm join users u on u.id=pm.user_id join roles r on r.id=pm.role_id order by pm.id');res.json(r.rows)}catch{res.status(500).json({error:'No se pudieron consultar las memberships de plataforma'})}
  });
  app.patch('/api/platform-memberships/:id',... [authMiddleware.bind(null,pool),membershipActor,preventSelfMembershipMutation('platform_memberships')],async(req,res)=>{
    if(req.actorContext.actor_type!=='platform')return res.status(403).json({error:'Solo plataforma puede administrar memberships de plataforma'});const client=await pool.connect();try{await client.query('BEGIN');const before=(await client.query('select * from platform_memberships where id=$1 for update',[req.params.id])).rows[0];if(!before){await client.query('ROLLBACK');return res.sendStatus(404)}const role=req.body?.role_id===undefined?{id:before.role_id}:await roleForScope(client,req.body.role_id,'platform');if(!role)throw new Error('Rol de plataforma no válido');const active=req.body?.active===undefined?before.active:!!req.body.active;const r=await client.query('update platform_memberships set role_id=$1,active=$2,updated_at=now() where id=$3 returning *',[role.id,active,req.params.id]);await writeAudit(client,req,{companyId:null,action:before.role_id!==role.id?'role_change':active!==before.active?(active?'activate':'deactivate'):'update',entity:'platform_membership',entityId:req.params.id,beforeData:before,afterData:r.rows[0]});await client.query('COMMIT');res.json(r.rows[0]);}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'No se pudo actualizar la membership de plataforma'});}finally{client.release();}
  });
  app.get('/api/roles',...protectedUserRoutes,async(req,res)=>{try{res.json((await pool.query('select id,code,name,description from roles order by id')).rows)}catch{res.status(500).json({error:'No se pudieron consultar los roles'})}});
  app.get('/api/company-roles',...protectedUserRoutes,async(req,res)=>{try{res.json((await pool.query("select id,code,name,description from roles where code in ('company_admin','manager','operations','maintenance','driver','viewer') order by id")).rows)}catch{res.status(500).json({error:'No se pudieron consultar los roles de empresa'})}});
  app.get('/api/platform-roles',...protectedUserRoutes,async(req,res)=>{if(req.user.actor_type!=='platform')return res.status(403).json({error:'Solo plataforma puede consultar roles de plataforma'});try{res.json((await pool.query("select id,code,name,description from roles where code='platform_superadmin' order by id")).rows)}catch{res.status(500).json({error:'No se pudieron consultar los roles de plataforma'})}});
  app.get('/api/users',...protectedUserRoutes,async(req,res)=>{
    try{
      const context=resolveActorContext(req);
      if(!context||context.actor_type==='unresolved'||(context.scope==='company'&&!context.company_id))return res.status(403).json({error:'Contexto empresarial requerido'});
      const global=context.scope==='platform';
      const cid=global?null:context.company_id;
      const companyActor=context.actor_type==='company';
      const identityColumns=companyActor?`coalesce(um.company_id,u.company_id) company_id,u.driver_id,coalesce(um.role_id,u.role_id) role_id,
        case when um.id is null then r.code else um.role_code end role_code,
        case when um.id is null then r.name else um.role_name end role_name,
        case when um.id is null then c.legal_name else um.company_name end company_name`:
        'u.company_id,u.driver_id,u.role_id,r.code role_code,r.name role_name,c.legal_name company_name';
      res.json((await pool.query(`select u.id,u.name,u.email,u.phone,u.active,u.last_login_at,${identityColumns},
        ${companyActor?'um.id modern_membership_id,':''}um.role_code modern_role_code,um.role_name modern_role_name,um.company_id modern_company_id,um.company_name modern_company_name,um.active modern_membership_active,
        pm.role_code platform_role_code,pm.role_name platform_role_name,pm.active platform_membership_active
        from users u left join roles r on r.id=u.role_id left join companies c on c.id=u.company_id
        left join lateral (select um.id,um.company_id,um.role_id,um.active,rr.code role_code,rr.name role_name,cc.legal_name company_name
          from user_memberships um join roles rr on rr.id=um.role_id left join companies cc on cc.id=um.company_id
          where um.user_id=u.id and ${companyActor?'um.company_id=$2':'um.active=true'} order by um.id desc limit 1) um on true
        left join lateral (select pm.active,rr.code role_code,rr.name role_name from platform_memberships pm join roles rr on rr.id=pm.role_id
          where pm.user_id=u.id and pm.active=true order by pm.id desc limit 1) pm on true
        where ($1=true or u.company_id=$2 or um.company_id=$2)
        ${companyActor?`and pm.active is null and (um.company_id=$2 or (u.company_id=$2 and not exists(
          select 1 from user_memberships other where other.user_id=u.id and other.active=true and other.company_id<>$2)))`:''}
        order by u.id desc`,[global,cid])).rows);
    }catch{res.status(500).json({error:'No se pudieron consultar los usuarios'})}
  });
  app.post('/api/users',...protectedUserRoutes,async(req,res)=>{
    const b=req.body||{}; if(!clean(b.name)||!clean(b.email)||!clean(b.password)||!b.role_id)return res.status(400).json({error:'Nombre, correo, contraseña y rol son obligatorios'});
    if(String(b.password).length<10)return res.status(400).json({error:'La contraseña debe tener al menos 10 caracteres'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const context=resolveActorContext(req);
      if(!context||context.actor_type==='unresolved')return res.status(403).json({error:'Contexto empresarial requerido'});
      const legacy=context.actor_type==='legacy'&&context.role==='admin';
      const companyId=context.actor_type==='legacy'?(b.company_id||context.company_id||null):context.scope==='platform'?(b.company_id||null):context.company_id;
      if(legacy&&companyId){await client.query('ROLLBACK');return res.status(409).json({code:'PERSONNEL_ROUTE_REQUIRED',error:'Las nuevas cuentas empresariales deben crearse desde Personas y accesos'});}
      const role=(await client.query('select id,code from roles where id=$1',[b.role_id])).rows[0];
      if(!role) throw new Error('Rol no encontrado');
      const platformRole=role.code==='platform_superadmin'||role.code.startsWith('platform_');
      if(context.actor_type==='company'&&platformRole){await client.query('ROLLBACK');return res.status(403).json({error:'No puedes asignar un rol de plataforma'});}
      if(platformRole&&(!context.scope||context.scope!=='platform'||companyId)){await client.query('ROLLBACK');return res.status(403).json({error:'Un rol de plataforma requiere creación global'});}
      if(role.code==='admin'&&context.scope!=='platform'&&!legacy){
        await client.query('ROLLBACK');
        return res.status(403).json({error:'No puedes asignar el rol administrador'});
      }
      const ph=await hashPassword(String(b.password));
      const r=await client.query('insert into users(company_id,role_id,name,email,password_hash,phone) values($1,$2,$3,$4,$5,$6) returning id',[companyId,b.role_id,clean(b.name),clean(b.email).toLowerCase(),ph,clean(b.phone)||null]);
      if(platformRole && context.actor_type==='platform' && !companyId){
        await client.query('insert into platform_memberships(user_id,role_id,active) values($1,$2,true)',[r.rows[0].id,role.id]);
      } else if(!platformRole && companyId && context.actor_type!=='legacy') {
        const companyRole=await roleForScope(client,role.id,'company');
        if(!companyRole) throw new Error('El rol no es compatible con una membership de empresa');
        const membership=(await client.query('insert into user_memberships(user_id,company_id,role_id,active) values($1,$2,$3,true) returning id',[r.rows[0].id,companyId,role.id])).rows[0];
        if(b.bootstrap_exempt===true){
          if(context.scope!=='platform'||role.code!=='company_admin'||!String(b.bootstrap_exemption_reason||'').trim())throw new Error('La exención bootstrap requiere plataforma, company_admin y motivo');
          await createBootstrapExemption(client,{membershipId:membership.id,actor:req.user,reason:b.bootstrap_exemption_reason});
        }
      }
      const user=await userView(client,r.rows[0].id);
      if(!user) throw new Error('No se pudo obtener el usuario creado');
      await writeAudit(client,req,{companyId,action:'create',entity:'user',entityId:r.rows[0].id,afterData:user});
      await client.query('COMMIT');
      res.status(201).json(user);
    } catch(e){
      await client.query('ROLLBACK');
      res.status(400).json({error:e.code==='23505'?'El correo ya existe':'No se pudo crear el usuario'});
    } finally {client.release();}
  });
  app.patch('/api/users/:id',...protectedUserRoutes,async(req,res)=>{
    const b=req.body||{};
    if(req.user.actor_type==='platform'&&(req.user.active_company_context||Object.hasOwn(b,'reason')||Object.hasOwn(b,'email'))){
      const context=resolveActorContext(req);
      if(!req.user.platform_membership_id||context?.scope!=='company'||!context.company_id||String(context.company_id)!==String(req.user.active_company_context)||
        (!isPlatformOwner(req.user)&&!req.user.permissions?.includes('platform.users.manage')))return res.status(403).json({error:'Selecciona una empresa autorizada para editar su cuenta'});
      const allowed=new Set(['name','email','phone','password','reason']);
      if(Object.keys(b).some(key=>!allowed.has(key)))return res.status(403).json({error:'Esta ruta solo edita identidad y credenciales. Cambia rol y acceso empresarial desde Personas; el gobierno de plataforma usa sus rutas propias'});
      if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.trim().length>2000)return res.status(400).json({error:'Indica un motivo de hasta 2000 caracteres'});
      if(!['name','email','phone','password'].some(key=>Object.hasOwn(b,key)))return res.status(400).json({error:'No hay cambios'});
      if(b.name!==undefined&&(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>160))return res.status(400).json({error:'Nombre no válido'});
      if(b.email!==undefined&&(typeof b.email!=='string'||b.email.trim().length>254||!/^\S+@\S+\.\S+$/.test(b.email.trim())))return res.status(400).json({error:'Correo no válido'});
      if(b.phone!==undefined&&b.phone!==null&&(typeof b.phone!=='string'||b.phone.trim().length>80))return res.status(400).json({error:'Teléfono no válido'});
      if(b.password!==undefined&&(typeof b.password!=='string'||b.password.length<10||b.password.length>1024))return res.status(400).json({error:'La contraseña debe tener entre 10 y 1024 caracteres'});
      if(!/^[1-9]\d*$/.test(String(req.params.id))||BigInt(req.params.id)>9223372036854775807n)return res.status(400).json({error:'Usuario no válido'});
      const cid=context.company_id;let db;
      try{
        db=await pool.connect();await db.query('BEGIN');
        const company=(await db.query('select id from companies where id=$1 and active=true for no key update',[cid])).rows[0];
        if(!company){await db.query('ROLLBACK');return res.sendStatus(404)}
        await db.query('select id from user_memberships where company_id=$1 and user_id=$2 for update',[cid,req.params.id]);
        await db.query('select id from company_people where company_id=$1 and user_id=$2 for update',[cid,req.params.id]);
        const before=(await db.query(`select u.id,u.name,u.email,u.phone,r.code role_code,
          exists(select 1 from user_memberships other where other.user_id=u.id and other.company_id<>$2 and other.active=true) shared_company,
          exists(select 1 from platform_memberships pm where pm.user_id=u.id) platform_identity,
          exists(select 1 from platform_owners po where po.user_id=u.id) ownership_identity
          from users u left join roles r on r.id=u.role_id where u.id=$1 and (
            exists(select 1 from user_memberships own where own.user_id=u.id and own.company_id=$2)
            or (u.company_id=$2 and not exists(select 1 from user_memberships any_membership where any_membership.user_id=u.id))
          ) for update of u`,[req.params.id,cid])).rows[0];
        if(!before){await db.query('ROLLBACK');return res.sendStatus(404)}
        if(before.platform_identity||before.ownership_identity||before.role_code==='admin'){
          await db.query('ROLLBACK');return res.status(403).json({error:'La identidad privilegiada se administra desde el gobierno de plataforma'});
        }
        if(before.shared_company){await db.query('ROLLBACK');return res.status(403).json({error:'La cuenta comparte acceso activo con otra empresa; su identidad global requiere revisión separada'});}
        if(b.email!==undefined&&(await db.query('select id from users where lower(email)=lower($1) and id<>$2',[b.email.trim().toLowerCase(),req.params.id])).rowCount){
          await db.query('ROLLBACK');return res.status(409).json({error:'El correo ya está en uso'});
        }
        const fields=[],values=[];
        for(const key of ['name','email','phone'])if(Object.hasOwn(b,key)){
          values.push(key==='email'?b[key].trim().toLowerCase():key==='phone'?(b[key]?.trim()||null):b[key].trim());fields.push(`${key}=$${values.length}`);
        }
        const passwordChanged=Object.hasOwn(b,'password');
        if(passwordChanged){values.push(await hashPassword(b.password));fields.push(`password_hash=$${values.length}`,'must_change_password=true');}
        values.push(req.params.id,cid);
        const after=(await db.query(`update users set ${fields.join(',')},updated_at=now() where id=$${values.length-1} and (
          company_id=$${values.length} or exists(select 1 from user_memberships own where own.user_id=users.id and own.company_id=$${values.length})
        ) returning id,name,email,phone`,values)).rows[0];
        if(!after)throw new Error('Cuenta empresarial no actualizada');
        if(passwordChanged)await db.query('delete from user_sessions where user_id=$1',[req.params.id]);
        const safeBefore={id:before.id,name:before.name,email:before.email,phone:before.phone};
        await writeAudit(db,req,{companyId:cid,action:'platform_company_user_update',entity:'user',entityId:before.id,
          beforeData:safeBefore,afterData:{...after,password_changed:passwordChanged,reason:b.reason.trim(),actor_type:'platform',actor_name:req.user.name,context_company_id:cid}});
        await db.query('COMMIT');return res.json({...after,company_id:cid,password_changed:passwordChanged});
      }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}return res.status(e.code==='23505'?409:400).json({error:e.code==='23505'?'El correo ya está en uso':'No se pudo actualizar la cuenta empresarial'});}
      finally{if(db)db.release()}
    }
    if(req.user.actor_type==='company'&&(b.active!==undefined||b.role_id!==undefined))return res.status(403).json({error:'El rol y la activación empresarial se modifican mediante PATCH /api/user-memberships/:id; no puedes cambiar la identidad global'});
    if(b.password&&String(b.password).length<10)return res.status(400).json({error:'La contraseña debe tener al menos 10 caracteres'});
    if(b.name===undefined&&b.phone===undefined&&b.role_id===undefined&&b.active===undefined&&!b.password)return res.status(400).json({error:'No hay cambios'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const context=resolveActorContext(req);
      if(!context||context.actor_type==='unresolved')return res.status(403).json({error:'Contexto empresarial requerido'});
      const isAdmin=context.actor_type==='legacy'&&context.role==='admin';
      const platform=context.scope==='platform';
      const global=platform;
      const targetCompany=context.scope==='company'?context.company_id:null;
      const companyActor=context.actor_type==='company';
      const locked=companyActor?await companyUserTarget(client,req.params.id,targetCompany):(await client.query('select id from users where id=$1 and ($2=true or company_id=$3) for update',[req.params.id,isAdmin||global,targetCompany])).rows[0];
      if(!locked){await client.query('ROLLBACK');return res.sendStatus(404);}
      if(b.role_id!==undefined&&platform){
        const prof=(await client.query('select 1 from company_people where user_id=$1 limit 1 for update',[req.params.id])).rows[0];
        if(prof){await client.query('ROLLBACK');return res.status(409).json({code:'PERSONNEL_ROUTE_REQUIRED',error:'El rol de personal registrado debe cambiarse desde Personas y accesos'});}
      }
      if(companyActor&&(locked.shared_company||locked.active_platform)){await client.query('ROLLBACK');return res.status(403).json({error:'No puedes editar la identidad global de una cuenta compartida con otra empresa o con plataforma'});}
      const before=await userAuditView(client,locked.id);
      if(!before) throw new Error('No se pudo obtener el usuario antes de actualizar');
      if(b.role_id!==undefined){
        const role=(await client.query('select id,code from roles where id=$1',[b.role_id])).rows[0];
        if(!role) throw new Error('Rol no encontrado');
        if(!isAdmin&&!platform&&role.code==='admin'){
          await client.query('ROLLBACK');
          return res.status(403).json({error:'No puedes asignar el rol administrador'});
        }
      }
      const fields=[];const vals=[];const add=(sql,v)=>{fields.push(sql);vals.push(v)};
      if(b.name!==undefined)add('name=$'+(vals.length+1),clean(b.name));
      if(b.phone!==undefined)add('phone=$'+(vals.length+1),clean(b.phone)||null);
      if(b.role_id!==undefined)add('role_id=$'+(vals.length+1),b.role_id);
      if(b.active!==undefined)add('active=$'+(vals.length+1),!!b.active);
      if(b.password)add('password_hash=$'+(vals.length+1),await hashPassword(String(b.password)));
      vals.push(req.params.id);
      const r=companyActor?await client.query(`update users set ${fields.join(',')},updated_at=now() where id=$${vals.length} returning id`,vals):await client.query(`update users set ${fields.join(',')},updated_at=now() where id=$${vals.length} and ($${vals.length+1}=true or company_id=$${vals.length+2}) returning id`,[...vals,isAdmin||global,targetCompany]);
      if(!r.rowCount) throw new Error('No se pudo actualizar el usuario autorizado');
      const after=await userAuditView(client,r.rows[0].id);
      if(!after) throw new Error('No se pudo obtener el usuario actualizado');
      const responseUser=await userView(client,r.rows[0].id);
      await writeAudit(client,req,{companyId:companyActor?targetCompany:after.company_id,action:'update',entity:'user',entityId:r.rows[0].id,beforeData:before,afterData:after});
      await client.query('COMMIT');
      res.json(responseUser);
    } catch{
      await client.query('ROLLBACK');
      res.status(400).json({error:'No se pudo actualizar el usuario'});
    } finally {client.release();}
  });
  const personnelApp={};
  for(const method of ['get','post','patch','put','delete'])personnelApp[method]=(path,...handlers)=>app[method](path,authMiddleware.bind(null,pool),...handlers);
  registerPersonnelRoutes(personnelApp,pool,{resolveActorContext,requirePermission,isPlatformOwner,hashPassword,reauthenticateUser});
}
async function reauthenticateUser(pool,userId,password){
  if(!userId||typeof password!=='string'||!password)return false;
  const r=await pool.query('select password_hash from users where id=$1 and active=true',[userId]);
  return !!r.rowCount&&await verifyPassword(password,r.rows[0].password_hash);
}

async function authMiddleware(pool,req,res,next){
  const user=await authenticateToken(pool,req).catch(()=>null);
  if(!user)return res.status(401).json({error:'Autenticación requerida'});
  const requestedContext=req.get('x-company-context');
  if(requestedContext&&user.actor_type!=='platform')return res.status(403).json({error:'El contexto de empresa solo está disponible para actores de plataforma'});
  if(requestedContext&&user.actor_type==='platform'&&user.platform_membership_id){
    const companyId=Number(requestedContext);
    if(!Number.isInteger(companyId)||companyId<1)return res.status(403).json({error:'Contexto empresarial no válido'});
    const company=await pool.query('select id from companies where id=$1 and active=true',[companyId]);
    if(!company.rowCount)return res.status(403).json({error:'Empresa no encontrada'});
    user.active_company_context=companyId;
  }
  req.user=user;
  if(user.scope==='company'&&user.company_id){
    const hasCompanyMembership=(user.memberships||[]).some(m=>m.active!==false);
    if(hasCompanyMembership&&!user.personnel_state)return res.status(500).json({error:'No se pudo validar el estado laboral'});
    if(!user.personnel_state){next();return;}
    if(!user.personnel_state.policy||!Object.hasOwn(user.personnel_state,'person'))return res.status(500).json({error:'No se pudo validar el estado laboral'});
    const personnel=await enforcePersonnelAccess(pool,req);
    req.personnelAccess=personnel;
    if(!personnel.allowed)return res.status(403).json({code:'PERSONNEL_ACCESS_BLOCKED',error:'Acceso bloqueado por regularización de personal'});
  }
  next();
}

function requirePermission(code){return (req,res,next)=>{if(!req.user)return res.status(401).json({error:'Autenticación requerida'});const legacy=req.user.role_code==='admin'&&!req.user.membership_id&&!req.user.platform_membership_id;if(isPlatformOwner(req.user)||legacy||(req.user.permissions||[]).includes(code))return next();res.status(403).json({error:`Permiso requerido: ${code}`});};}
function resolveActorContext(req){const user=req.user;if(!user)return null;const effective=user.actor_type?{actor_type:user.actor_type,scope:user.scope||null,company_id:user.company_id||null,membership_id:user.membership_id||null,platform_membership_id:user.platform_membership_id||null,role:user.role_code||null,permissions:user.permissions||[],reason:user.context_reason||null}:user.scope==='platform'&&user.platform_membership_id?{actor_type:'platform',scope:'platform',company_id:null,membership_id:null,platform_membership_id:user.platform_membership_id,role:user.role_code||null,permissions:user.permissions||[],reason:null}:resolveEffectiveMembership(user);if(effective.actor_type==='platform'&&user.active_company_context)return {user_id:user.id,...effective,scope:'company',company_id:user.active_company_context,context_company_id:user.active_company_context,legacy_company_id:null,legacy_role_code:user.legacy_role_code??null};return {user_id:user.id,...effective,legacy_company_id:user.legacy_company_id??(user.actor_type==='legacy'?user.company_id||null:null),legacy_role_code:user.legacy_role_code??(user.actor_type==='legacy'?user.role_code||null:null)};}
function requireScopedPermission(code,scope){return (req,res,next)=>{const context=resolveActorContext(req);if(!context)return res.status(401).json({error:'Autenticación requerida'});if(context.actor_type==='unresolved')return res.status(403).json({error:context.reason||'Contexto empresarial requerido'});const owner=isPlatformOwner(req.user);if(scope==='company'&&!context.company_id)return res.status(403).json({error:'Empresa autorizada no resuelta'});if(!owner&&(context.scope!==scope||!context.permissions.includes(code)))return res.status(403).json({error:`Permiso requerido: ${code}`});if(owner&&scope==='company'&&context.actor_type!=='platform')return res.status(403).json({error:`Permiso requerido: ${code}`});req.actorContext=context;next();};}
function requirePlatformPermission(code){return (req,res,next)=>{const u=req.user;const legacy=u?.role_code==='admin'&&!u?.membership_id&&!u?.platform_membership_id;if(isPlatformOwner(u)||(u?.scope==='platform'&&u.permissions?.includes(code))||legacy)return next();return res.status(403).json({error:`Permiso requerido: ${code}`});};}

module.exports={registerAuthRoutes,authMiddleware,requirePermission,requireScopedPermission,requirePlatformPermission,resolveActorContext,resolveEffectiveMembership,userView,reauthenticateUser,isPlatformOwner};
