'use strict';
const crypto=require('node:crypto'),{reauthenticateUser,isPlatformOwner,resolveActorContext}=require('./auth'),{writeAudit}=require('./audit'),Engine=require('./company-purge-engine');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const words=['cobre','bosque','cumbre','sendero','marino','nube','valle','estrella','lago','piedra','brisa','roble','luna','sol','campo','puerto','arena','trigo','monte','farol','rio','pampa','cielo','hoja','viento','cerro','norte','sur','flor','sal','nieve','faro'];
const allowed=req=>{const u=req.user,a=resolveActorContext(req);return !!(u?.actor_type==='platform'&&u.platform_membership_id&&a?.scope==='platform'&&(isPlatformOwner(u)||(u.role_code==='platform_superadmin'&&u.permissions?.includes('platform.companies.manage'))));};
const fail=(status,message)=>Object.assign(Error(message),{status});
const id=v=>{if(!/^[1-9]\d*$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw fail(400,'Empresa no válida');return Number(v);};
const session=req=>digest(req.get('authorization')||'');
async function files(db,p,cid){const keys=new Set();for(const t of p.tables.filter(t=>t.cols.includes('storage_key')&&t.pk?.length)){
 const key='jsonb_build_array('+t.pk.map(c=>'t."'+c.replaceAll('"','""')+'"').join(',')+')';
 const rows=(await db.query(`select storage_key from public."${t.name.replaceAll('"','""')}" t where storage_key is not null and exists(select 1 from purge_rows r where r.rel=${t.oid} and r.key=${key})`)).rows;
 for(const r of rows){if(!r.storage_key.startsWith(`companies/${cid}/`)||r.storage_key.includes('..'))throw fail(409,'Un archivo no pertenece al prefijo privado de la empresa; revisa el almacenamiento');keys.add(r.storage_key);}}
 return [...keys];}
function registerCompanyPurge(app,pool,{storage,onError}={}){
 const guard=(req,res,next)=>allowed(req)?next():res.status(403).json({error:'Solo administración global de plataforma; sal del contexto de empresa'});
 const route=(method,path,fn)=>app[method](path,guard,async(req,res)=>{try{res.set('Cache-Control','no-store');await fn(req,res);}catch(e){if(!e.status){if(onError)onError(e);else console.error('COMPANY_PURGE_FAILED',e.code||'OPERATION_FAILED');}res.status(e.status||503).json({error:e.status?e.message:'No se completó la operación. No repitas una eliminación sin consultar su estado.'});}});
 const base='/api/admin/company-purge';
 route('get',base,async(req,res)=>{res.json({companies:(await pool.query('select id,legal_name,rut,active from companies order by legal_name')).rows,jobs:(await pool.query('select id,target_company_id,company_name,status,created_at,completed_at from platform_company_purge_jobs order by created_at desc limit 100')).rows});});
 route('post',base+'/:id/challenge',async(req,res)=>{
  const cid=id(req.params.id),db=await pool.connect();try{await db.query('BEGIN');await db.query('select id from users where id=$1 for update',[req.user.id]);
   if(Number((await db.query("select count(*) n from platform_company_purge_challenges where actor_id=$1 and created_at>now()-interval '1 hour'",[req.user.id])).rows[0].n)>=10)throw fail(429,'Demasiados intentos de eliminación; espera una hora');
   const c=(await db.query('select id,legal_name,rut,updated_at from companies where id=$1',[cid])).rows[0];if(!c)throw fail(404,'Empresa no encontrada');
   await db.query('update platform_company_purge_challenges set consumed_at=now() where actor_id=$1 and consumed_at is null',[req.user.id]);
   const recent=(await db.query('select phrase_hash from platform_company_purge_challenges where actor_id=$1 order by created_at desc limit 10',[req.user.id])).rows.map(r=>r.phrase_hash);
   let phrase;do{phrase=Array.from({length:5},()=>words[crypto.randomInt(words.length)]).join(' ');}while(recent.includes(digest(phrase)));
   const key=crypto.randomUUID();
   await db.query("insert into platform_company_purge_challenges(id,target_company_id,actor_id,session_hash,phrase_hash,company_stamp,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')",[key,cid,req.user.id,session(req),digest(phrase),digest(JSON.stringify(c))]);
   await db.query('COMMIT');res.json({challenge_id:key,phrase,company:c,expires_in_seconds:300});
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
 route('post',base+'/:id/execute',async(req,res)=>{
  const cid=id(req.params.id),b=req.body||{};
  if(typeof b.challenge_id!=='string'||!/^[0-9a-f-]{36}$/.test(b.challenge_id))throw fail(400,'Genera una confirmación nueva');
  // Consume before checking secrets: failed attempts cannot reuse the phrase.
  const c=(await pool.query('update platform_company_purge_challenges set consumed_at=now() where id=$1 and actor_id=$2 and target_company_id=$3 and session_hash=$4 and consumed_at is null and expires_at>now() returning phrase_hash,company_stamp',[b.challenge_id,req.user.id,cid,session(req)])).rows[0];
  if(!c)throw fail(409,'La confirmación venció o ya se utilizó. Genera otra frase');
  if(typeof b.phrase!=='string'||digest(b.phrase)!==c.phrase_hash||!await reauthenticateUser(pool,req.user.id,b.password))throw fail(403,'Contraseña o frase incorrecta. Genera otra confirmación');
  if(typeof b.reason!=='string'||b.reason.trim().length<5||b.reason.length>1000)throw fail(400,'Indica un motivo de 5 a 1000 caracteres');
  const db=await pool.connect(),job=crypto.randomUUID();try{
   await db.query('BEGIN');await db.query("set local lock_timeout='5s'");await db.query("set local statement_timeout='30s'");
   const p=await Engine.plan(db,cid,{lock:true});
   const authority=(await db.query("select 1 from users u join platform_memberships m on m.user_id=u.id and m.active=true join roles r on r.id=m.role_id where u.id=$1 and u.active=true and (exists(select 1 from platform_owners o where o.user_id=u.id and o.active=true) or (r.code='platform_superadmin' and exists(select 1 from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=r.id and p.code='platform.companies.manage')))",[req.user.id])).rows[0];
   if(!authority||!await reauthenticateUser(db,req.user.id,b.password))throw fail(403,'La autoridad o contraseña cambió; eliminación cancelada');
   const company=(await db.query('select id,legal_name,rut,updated_at from companies where id=$1 for update',[cid])).rows[0];if(!company)throw fail(404,'Empresa no encontrada');
   if(digest(JSON.stringify(company))!==c.company_stamp)throw fail(409,'La empresa cambió desde la confirmación. Revisa y genera otra frase');
   const keys=await files(db,p,cid);
   if(keys.length&&!storage)require('./storage').storageConfig();
   await db.query("insert into platform_company_purge_jobs(id,target_company_id,company_name,actor_id,reason,counts,status) values($1,$2,$3,$4,$5,$6,'files_pending')",[job,cid,company.legal_name,req.user.id,b.reason.trim(),JSON.stringify(p.counts)]);
   for(const key of keys)await db.query('insert into platform_company_purge_files(job_id,storage_key) values($1,$2)',[job,key]);
   const identities=await Engine.erase(db,cid,p);
   await writeAudit(db,req,{companyId:null,action:'company_purge',entity:'company',entityId:cid,afterData:{job_id:job,company_name:company.legal_name,reason:b.reason.trim(),counts:p.counts,files:keys.length,...identities}});
   await db.query('COMMIT');res.status(202).json({job_id:job,status:'files_pending',database_deleted:true,files:keys.length,...identities});
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
 route('post',base+'/jobs/:jobId/cleanup',async(req,res)=>{
  if(typeof req.params.jobId!=='string'||!/^[0-9a-f-]{36}$/.test(req.params.jobId))throw fail(400,'Trabajo no válido');
  const db=await pool.connect(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);timer.unref?.();
  try{await db.query('BEGIN');await db.query("set local lock_timeout='5s'");
   const job=(await db.query('select * from platform_company_purge_jobs where id=$1 for update',[req.params.jobId])).rows[0];if(!job)throw fail(404,'Trabajo no encontrado');
   const list=(await db.query('select storage_key from platform_company_purge_files where job_id=$1 and deleted_at is null order by storage_key limit 25',[job.id])).rows;
   if(list.length){const store=storage||require('./storage').createStorage();for(const f of list){if(!f.storage_key.startsWith(`companies/${job.target_company_id}/`)||f.storage_key.includes('..'))throw fail(409,'Archivo fuera de empresa: limpieza bloqueada');
    await store.delete(f.storage_key,{signal:controller.signal});await db.query('update platform_company_purge_files set deleted_at=now() where job_id=$1 and storage_key=$2',[job.id,f.storage_key]);}}
   const pending=Number((await db.query('select count(*) n from platform_company_purge_files where job_id=$1 and deleted_at is null',[job.id])).rows[0].n);
   if(!pending)await db.query("update platform_company_purge_jobs set status='complete',completed_at=coalesce(completed_at,now()) where id=$1",[job.id]);
   if(list.length||job.status!=='complete')await writeAudit(db,req,{companyId:null,action:'company_purge_files',entity:'company_purge_job',entityId:job.id,afterData:{deleted:list.length,pending}});
   await db.query('COMMIT');res.json({job_id:job.id,status:pending?'files_pending':'complete',pending});
  }catch(e){await db.query('ROLLBACK');throw e;}finally{clearTimeout(timer);db.release();}
 });
}
module.exports={registerCompanyPurge,allowed,files};
