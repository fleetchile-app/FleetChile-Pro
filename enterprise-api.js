'use strict';
const {resolveActorContext,requirePermission,isPlatformOwner}=require('./auth');
const S=require('./support-access'),E=require('./enterprise-common');
function companyGate(scope,permission='company.users.manage'){return (req,res,next)=>{
 const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id||a.actor_type==='unresolved')return res.status(403).json({error:'Selecciona una empresa autorizada'});
 req.enterpriseCompany=a.company_id;
 if(S.allows(req,scope))return next();
 if(a.actor_type==='platform'&&platformManager(req))return next();
 return requirePermission(permission)(req,res,next);
}}
function platformManager(req){const u=req.user;return u?.actor_type==='platform'&&(isPlatformOwner(u)||['platform.users.manage','platform.companies.manage'].every(p=>u.permissions?.includes(p)))}
function registerEnterpriseRoutes(app,pool){
 const gate=companyGate('profiles'),cid=req=>req.enterpriseCompany;
 app.get('/api/company/access',gate,E.wrap(async(req,res)=>{
  const roles=(await pool.query(`select r.id,r.code,r.name,coalesce(jsonb_agg(jsonb_build_object('code',p.code,'name',p.name)) filter(where p.id is not null),'[]') permissions
   from roles r left join role_permissions rp on rp.role_id=r.id left join permissions p on p.id=rp.permission_id and p.scope='company'
   where r.code in ('manager','operations','maintenance','driver','viewer','administrative') group by r.id order by r.name`)).rows;
  const profiles=(await pool.query('select * from company_access_profiles where company_id=$1 order by name,id',[cid(req)])).rows;
  res.json({roles,profiles});
 }));
 app.post('/api/company/access/profiles',gate,E.wrap(async(req,res)=>{
  const b=req.body||{},why=E.reason(b.reason);
  if(Object.keys(b).some(k=>!['id','expected_version','base_role_id','name','permissions','active','reason'].includes(k)))E.fail(400,'Campos no permitidos');
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||/[\x00-\x1f]/.test(b.name)||!Array.isArray(b.permissions)||b.permissions.some(p=>typeof p!=='string')||new Set(b.permissions).size!==b.permissions.length||typeof b.active!=='boolean'||!Number.isSafeInteger(b.expected_version))E.fail(400,'Perfil no válido');
  const result=await E.transaction(pool,cid(req),async db=>{
   const before=b.id?(await db.query('select * from company_access_profiles where company_id=$1 and id=$2 for update',[cid(req),E.id(b.id)])).rows[0]:null;
   if(b.id&&!before)E.fail(404,'Perfil no encontrado');
   if((before?.version||0)!==b.expected_version)E.fail(409,'El perfil cambió; recarga antes de guardar');
   const rid=E.id(b.base_role_id);if(before&&String(before.base_role_id)!==String(rid))E.fail(400,'No se cambia el rol base de un perfil existente');
   const role=(await db.query("select id from roles where id=$1 and code in ('manager','operations','maintenance','driver','viewer','administrative')",[rid])).rows[0];
   if(!role)E.fail(400,'Rol base no permitido');
   const permitted=(await db.query("select p.code from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=$1 and p.scope='company'",[rid])).rows.map(x=>x.code);
   if(b.permissions.some(p=>!permitted.includes(p)))E.fail(400,'El perfil no puede ampliar los permisos del rol base');
   const after=before?(await db.query('update company_access_profiles set name=$1,permissions=$2,active=$3,version=version+1,updated_at=now(),updated_by=$4 where company_id=$5 and id=$6 returning *',[b.name.trim(),JSON.stringify(b.permissions),b.active,req.user.id,cid(req),before.id])).rows[0]:(await db.query('insert into company_access_profiles(company_id,base_role_id,name,permissions,active,updated_by) values($1,$2,$3,$4,$5,$6) returning *',[cid(req),rid,b.name.trim(),JSON.stringify(b.permissions),b.active,req.user.id])).rows[0];
   await E.event(db,req,cid(req),'access_profile',after.id,why,before,after);return after;
  });res.json(result);
 }));
 app.get('/api/company/access/memberships',gate,E.wrap(async(req,res)=>{
  const q=String(req.query?.q||'').trim();if(q.length>120)E.fail(400,'Búsqueda demasiado larga');
  const page=Number(req.query?.page||1);if(!Number.isSafeInteger(page)||page<1)E.fail(400,'Página no válida');
  const rows=(await pool.query(`select m.id,m.user_id,m.role_id,m.active,m.access_profile_id,m.updated_at::text stamp,u.name,u.email,r.name role_name,r.code role_code,count(*) over()::int total
   from user_memberships m join users u on u.id=m.user_id join roles r on r.id=m.role_id
   where m.company_id=$1 and ($2='' or u.name ilike '%'||$2||'%' or u.email ilike '%'||$2||'%')
   order by lower(u.name),m.id limit 25 offset $3`,[cid(req),q,(page-1)*25])).rows;res.json({rows,page,total:rows[0]?.total||0});
 }));
 app.put('/api/company/access/memberships/:id',gate,E.wrap(async(req,res)=>{
  const b=req.body||{},why=E.reason(b.reason);if(Object.keys(b).some(k=>!['profile_id','expected_stamp','reason'].includes(k))||typeof b.expected_stamp!=='string')E.fail(400,'Datos de asignación no válidos');
  const result=await E.transaction(pool,cid(req),async db=>{
   const before=(await db.query('select m.*,m.updated_at::text stamp from user_memberships m where m.company_id=$1 and m.id=$2 for update',[cid(req),E.id(req.params.id)])).rows[0];
   if(!before)E.fail(404,'Acceso no encontrado');if(String(before.user_id)===String(req.user.id))E.fail(403,'No puedes cambiar tu propio perfil');
   if(before.stamp!==b.expected_stamp)E.fail(409,'La membership cambió; recarga antes de guardar');
   const protectedUser=(await db.query(`select 1 from users u join roles r on r.id=u.role_id where u.id=$1 and (r.code='admin' or exists(select 1 from platform_memberships pm where pm.user_id=u.id) or exists(select 1 from platform_owners po where po.user_id=u.id))`,[before.user_id])).rows.length;
   const base=(await db.query('select code from roles where id=$1',[before.role_id])).rows[0];if(protectedUser||base?.code==='company_admin')E.fail(403,'No se aplica un perfil limitado a administradores o identidades protegidas');
   const profileId=b.profile_id===null?null:E.id(b.profile_id);
   if(profileId&&!((await db.query('select id from company_access_profiles where company_id=$1 and id=$2 and base_role_id=$3 and active for share',[cid(req),profileId,before.role_id])).rows.length))E.fail(400,'Selecciona un perfil activo de esta empresa y del mismo rol base');
   const after=(await db.query('update user_memberships set access_profile_id=$1,updated_at=now() where company_id=$2 and id=$3 returning *',[profileId,cid(req),before.id])).rows[0];
   await E.event(db,req,cid(req),'membership_profile',before.id,why,{profile_id:before.access_profile_id,role_id:before.role_id},{profile_id:profileId,role_id:before.role_id});return after;
  });res.json(result);
 }));
 app.get('/api/company/access/history',gate,E.wrap(async(req,res)=>res.json({rows:(await pool.query("select id,actor_id,actor_name,kind,entity_id,reason,before_data,after_data,created_at from enterprise_events where company_id=$1 and kind in ('access_profile','membership_profile') order by id desc limit 100",[cid(req)])).rows})));

 const own=(req,res,next)=>req.user?.actor_type==='platform'?next():res.status(403).json({error:'Se requiere una identidad de plataforma'});
 const admin=(req,res,next)=>platformManager(req)?next():res.status(403).json({error:'Se requiere gestión de usuarios y empresas de plataforma'});
 app.get('/api/support/management',admin,E.wrap(async(req,res)=>res.json({
  companies:(await pool.query('select id,legal_name from companies where active order by legal_name')).rows,
  users:(await pool.query("select u.id,u.name,u.email from users u join platform_memberships pm on pm.user_id=u.id and pm.active join roles r on r.id=pm.role_id and r.code='platform_support' where u.active and not exists(select 1 from platform_owners po where po.user_id=u.id) order by u.name")).rows,
  grants:(await pool.query('select g.*,c.legal_name,u.name user_name from company_support_grants g join companies c on c.id=g.company_id join users u on u.id=g.user_id order by g.id desc limit 200')).rows
 })));
 app.post('/api/support/grants',admin,E.wrap(async(req,res)=>{
  const b=req.body||{},why=E.reason(b.reason),companyId=E.id(b.company_id),userId=E.id(b.user_id),until=new Date(b.expires_at);
  if(!Number.isFinite(until.getTime())||until.getTime()<=Date.now()||until.getTime()>Date.now()+30*86400000||!Array.isArray(b.scopes)||!b.scopes.length||b.scopes.some(s=>!['people','branding','profiles','imports'].includes(s))||new Set(b.scopes).size!==b.scopes.length)E.fail(400,'Funciones o vigencia no válidas (máximo 30 días)');
  const row=await E.transaction(pool,companyId,async db=>{
   if(!(await db.query("select u.id from users u join platform_memberships m on m.user_id=u.id and m.active join roles r on r.id=m.role_id and r.code='platform_support' where u.id=$1 and u.active and not exists(select 1 from platform_owners po where po.user_id=u.id)",[userId])).rows.length)E.fail(400,'Selecciona una cuenta activa con rol Soporte acotado');
   const g=(await db.query('insert into company_support_grants(company_id,user_id,scopes,expires_at,reason,created_by) values($1,$2,$3,$4,$5,$6) returning *',[companyId,userId,JSON.stringify(b.scopes),until,why,req.user.id])).rows[0];await E.event(db,req,companyId,'support_grant',g.id,why,null,{user_id:userId,scopes:b.scopes,expires_at:until});return g;
  });res.json(row);
 }));
 app.post('/api/support/grants/:id/revoke',admin,E.wrap(async(req,res)=>{
  const why=E.reason(req.body?.reason),gid=E.id(req.params.id),g=(await pool.query('select * from company_support_grants where id=$1',[gid])).rows[0];if(!g)E.fail(404,'Autorización no encontrada');
  const row=await E.transaction(pool,g.company_id,async db=>{const r=(await db.query('update company_support_grants set revoked_at=coalesce(revoked_at,now()),revoked_by=coalesce(revoked_by,$1) where id=$2 returning *',[req.user.id,gid])).rows[0];await E.event(db,req,g.company_id,'support_revoke',gid,why,null,{user_id:g.user_id});return r});res.json(row);
 }));
 app.get('/api/support/companies',own,E.wrap(async(req,res)=>res.json((await pool.query(`select distinct c.id,c.legal_name from companies c join company_support_grants g on g.company_id=c.id where g.user_id=$1 and g.revoked_at is null and g.expires_at>now() and c.active order by c.legal_name`,[req.user.id])).rows)));
 app.get('/api/support/current',own,E.wrap(async(req,res)=>res.json({cases:(await pool.query('select s.id,s.company_id,s.opened_at,s.expires_at,s.closed_at,s.reason,g.scopes,(g.revoked_at is null and g.expires_at>now() and s.closed_at is null and s.expires_at>now()) available from company_support_cases s join company_support_grants g on g.id=s.grant_id where s.user_id=$1 order by s.id desc limit 50',[req.user.id])).rows})));
 app.post('/api/support/cases',own,E.wrap(async(req,res)=>{
  if(!S.restricted(req.user))E.fail(403,'El circuito de casos requiere el rol Soporte acotado');const cid=E.id(req.body?.company_id),why=E.reason(req.body?.reason);
  const result=await E.transaction(pool,cid,async db=>{const g=await S.grant(db,req.user.id,cid);if(!g)E.fail(403,'Empresa no autorizada');await db.query('update company_support_cases set closed_at=now() where company_id=$1 and user_id=$2 and closed_at is null',[cid,req.user.id]);const s=(await db.query("insert into company_support_cases(company_id,grant_id,user_id,reason,expires_at) values($1,$2,$3,$4,least($5,now()+interval '2 hours')) returning *",[cid,g.id,req.user.id,why,g.expires_at])).rows[0];await E.event(db,req,cid,'support_open',s.id,why,null,{grant_id:g.id,scopes:g.scopes});return s});res.json(result);
 }));
 app.post('/api/support/cases/:id/close',own,E.wrap(async(req,res)=>{
  const sid=E.id(req.params.id),why=E.reason(req.body?.reason),s=(await pool.query('select * from company_support_cases where id=$1 and user_id=$2',[sid,req.user.id])).rows[0];if(!s)E.fail(404,'Caso no encontrado');res.json(await E.transaction(pool,s.company_id,async db=>{const row=(await db.query('update company_support_cases set closed_at=coalesce(closed_at,now()) where id=$1 returning *',[sid])).rows[0];await E.event(db,req,s.company_id,'support_close',sid,why);return row}));
 }));
}
module.exports={registerEnterpriseRoutes,companyGate,platformManager};
