'use strict';
const {fail}=require('./enterprise-common');
function restricted(user){return user?.actor_type==='platform'&&user.role_code==='platform_support'&&!(user.ownership_role&&user.ownership_active===true)}
async function grant(db,uid,cid){return (await db.query(`select g.* from company_support_grants g join companies c on c.id=g.company_id and c.active
 where g.user_id=$1 and g.company_id=$2 and g.revoked_at is null and g.expires_at>now() order by g.id desc limit 1`,[uid,cid])).rows[0]}
function allows(req,scope){return restricted(req.user)&&String(req.supportAccess?.company_id)===String(req.user.active_company_context)&&req.supportAccess?.scopes?.includes(scope)}
async function authorizeSupport(db,req){
 if(!restricted(req.user))return;
 const path=(req.originalUrl||req.path||'').split('?')[0].replace(/\/$/,'').toLowerCase(),method=req.method?.toUpperCase(),uid=req.user.id;
 if(['/api/auth/logout','/api/auth/change-password','/api/auth/me'].includes(path))return;
 if(path==='/api/auth/company-context'){if(!await grant(db,uid,req.body?.company_id))fail(403,'Empresa no autorizada para soporte');return;}
 if(['/api/support/companies','/api/support/cases','/api/support/current'].includes(path)||/^\/api\/support\/cases\/[1-9]\d*\/close$/.test(path))return;
 const cid=req.user.active_company_context;if(!cid)fail(403,'Selecciona una empresa autorizada y abre un caso de soporte');
 const row=(await db.query(`select s.id,s.company_id,g.scopes from company_support_cases s join company_support_grants g on g.id=s.grant_id and g.company_id=s.company_id and g.user_id=s.user_id
 where s.user_id=$1 and s.company_id=$2 and s.closed_at is null and s.expires_at>now() and g.revoked_at is null and g.expires_at>now() order by s.id desc limit 1`,[uid,cid])).rows[0];
 if(!row)fail(403,'No hay un caso de soporte vigente para esta empresa');
 const scope=path.startsWith('/api/company/people')?'people':path.startsWith('/api/company/branding')?'branding':path.startsWith('/api/company/access')?'profiles':path.startsWith('/api/company/imports')?'imports':null;
 if(!scope||!row.scopes.includes(scope))fail(403,'Función fuera del alcance del soporte autorizado');
 req.supportAccess=row;
 await db.query('insert into audit_logs(company_id,user_id,action,entity,entity_id,after_data,ip) values($1,$2,$3,$4,$5,$6,$7)',[cid,uid,'support_attempt','support_case',String(row.id),{method,path},req.ip||null]);
}
module.exports={restricted,grant,allows,authorizeSupport};
