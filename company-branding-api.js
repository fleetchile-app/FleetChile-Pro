'use strict';
const {resolveActorContext,requirePermission,requirePlatformPermission}=require('./auth');
const {writeAudit}=require('./audit');
const B=require('./company-branding');
function company(req){const a=resolveActorContext(req);if(a?.scope!=='company'||!a.company_id||a.actor_type==='unresolved')throw Object.assign(new Error('Selecciona una empresa autorizada'),{status:403});return a.company_id;}
function error(res,e){const status=[400,403,404,409].includes(e.status)?e.status:500;return res.status(status).json({error:status===500?'No se pudo gestionar la identidad empresarial':e.message});}
function registerCompanyBrandingRoutes(app,pool){
 app.get('/api/company/branding',async(req,res)=>{try{const b=await B.loadBranding(pool,company(req));res.json(B.publicBranding(b))}catch(e){error(res,e)}});
 const edit=(req,res,next)=>{try{company(req);if(require('./support-access').allows(req,'branding'))return next();const actor=resolveActorContext(req);return (actor.actor_type==='platform'?requirePlatformPermission('platform.companies.manage'):requirePermission('company.users.manage'))(req,res,next)}catch(e){error(res,e)}};
 app.put('/api/company/branding',edit,async(req,res)=>{
  let db;
  try{
   const cid=company(req),values=B.validateSettings(req.body),logo=Object.hasOwn(values,'logo')?await B.normalizeLogo(values.logo):null;
   db=await pool.connect();await db.query('BEGIN');
   const found=await db.query('select id from companies where id=$1 for no key update',[cid]);
   if(!found.rows.length)throw Object.assign(new Error('Empresa no encontrada'),{status:404});
   const before=await B.loadBranding(db,cid);
   if(before.version!==req.body.expected_version)throw Object.assign(new Error('Otra persona modificó la configuración. Recarga antes de guardar.'),{status:409});
   const image=logo||{logo:before.logo,logo_width:before.logo_width,logo_height:before.logo_height};
   await db.query(`insert into company_branding_revisions(company_id,version,display_name,palette,contact_name,contact_email,contact_phone,logo,logo_width,logo_height,created_by,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[cid,before.version+1,values.display_name,values.palette,values.contact_name,values.contact_email,values.contact_phone,image.logo,image.logo_width,image.logo_height,req.user.id,values.reason]);
   const after=await B.loadBranding(db,cid);
   await writeAudit(db,req,{companyId:cid,action:'update',entity:'company_branding',entityId:cid,beforeData:B.identitySnapshot(before),afterData:{...B.identitySnapshot(after),reason:values.reason}});
   await db.query('COMMIT');res.json(B.publicBranding(after));
  }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}error(res,e)}finally{db?.release()}
 });
 app.get('/api/company/branding/history',edit,async(req,res)=>{try{res.json({rows:(await pool.query('select version,display_name,palette,created_at,created_by,reason from company_branding_revisions where company_id=$1 order by version desc limit 100',[company(req)])).rows})}catch(e){error(res,e)}});
}
module.exports={registerCompanyBrandingRoutes};
