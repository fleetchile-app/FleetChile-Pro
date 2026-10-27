'use strict';
const fs=require('node:fs');
const {createStorage}=require('./storage'),{packageCompany,limits,cleanupTemps}=require('./portability-package');
const {writeAudit}=require('./audit');
const exportKey=job=>`companies/${job.company_id}/exports/${job.id}.tar.gz`;
function createExportWorker(pool,{storageFactory=createStorage,operations,env=process.env,tempRoot}={}){
 let pending=null,stopped=false,timer=null;
 async function once(){
  const db=await pool.connect();let locked=false,job=null,built=null,store=null,attempted=false,timeout=null,controller=null;
  try{
   locked=(await db.query('select pg_try_advisory_lock(738041,0) locked')).rows[0]?.locked;if(!locked)return;
   const interrupted=(await db.query("update company_export_jobs set status='failed',error_code='EXPORT_INTERRUPTED',finished_at=now() where status='running' returning id,company_id")).rows;
   for(const row of interrupted)await db.query('update company_export_jobs set storage_key=$1 where id=$2',[exportKey(row),row.id]);
   await cleanupTemps(db,{tempRoot});
   const expired=(await db.query("update company_export_jobs set status='expired' where status='ready' and expires_at<=now() returning id,company_id,storage_key")).rows;
   const retries=(await db.query("select id,company_id,storage_key from company_export_jobs where status in ('expired','failed') and storage_key is not null order by created_at limit 100")).rows;
   for(const e of [...new Map([...expired,...retries].map(e=>[e.id,e])).values()]){
    if(e.storage_key!==exportKey(e)){await operations?.record('exports','EXPORT_CLEANUP_SCOPE');continue;}
    try{store||=storageFactory();await store.delete(e.storage_key);await db.query("update company_export_jobs set storage_key=null where id=$1 and status in ('expired','failed')",[e.id])}catch{await operations?.record('exports','EXPORT_CLEANUP_FAILED')}
   }
   await db.query('BEGIN');job=(await db.query("select * from company_export_jobs where status='queued' order by created_at limit 1 for update skip locked")).rows[0];
   if(job)await db.query("update company_export_jobs set status='running',started_at=now() where id=$1",[job.id]);await db.query('COMMIT');
   if(!job){operations?.worker('exports',true);return;}
   try{store||=storageFactory()}catch{throw Object.assign(Error('Storage not configured'),{exportCode:'EXPORT_STORAGE_CONFIG'})}
   controller=new AbortController();timeout=setTimeout(()=>controller.abort(),limits(env).timeoutMs);timeout.unref?.();
   built=await packageCompany(db,job,store,{env,signal:controller.signal,tempRoot});
   attempted=true;const upload=fs.createReadStream(built.target);try{await store.put({key:exportKey(job),body:upload,mimeType:'application/gzip',size:built.size,metadata:{sha256:built.sha256},signal:controller.signal})}finally{upload.destroy()}
   await db.query('BEGIN');const result=await db.query(`update company_export_jobs set status='ready',finished_at=now(),expires_at=now()+interval '24 hours',snapshot_at=$1,storage_key=$2,size=$3,sha256=$4,manifest=$5
    where id=$6 and status='running' and exists(select 1 from companies c where c.id=company_export_jobs.company_id and c.active) returning id`,[built.manifest.snapshot_at,exportKey(job),built.size,built.sha256,JSON.stringify(built.manifest),job.id]);
   if(!result.rows.length)throw Object.assign(Error('Export cancelled'),{exportCode:'EXPORT_COMPANY_UNAVAILABLE'});
   await writeAudit(db,{user:{id:job.requested_by}},{companyId:job.company_id,action:'export_ready',entity:'company_export',entityId:job.id,afterData:{sha256:built.sha256,size:built.size,snapshot_at:built.manifest.snapshot_at}});
   await db.query('COMMIT');operations?.worker('exports',true);
  }catch(e){
   try{await db.query('ROLLBACK')}catch{}
   const errorCode=controller?.signal.aborted?'EXPORT_TIMEOUT':/^EXPORT_[A-Z_]{1,60}$/.test(e.exportCode||'')?e.exportCode:e.name==='AbortError'?'EXPORT_TIMEOUT':'EXPORT_FAILED';
   if(job){let orphan=null;if(attempted&&store)try{await store.delete(exportKey(job))}catch{orphan=exportKey(job)}
    try{await db.query("update company_export_jobs set status='failed',error_code=$1,finished_at=now(),storage_key=$3 where id=$2 and status in ('queued','running')",[errorCode,job.id,orphan])}catch{}
   }
   await operations?.record('exports',errorCode);operations?.worker('exports',false);
  }finally{if(timeout)clearTimeout(timeout);if(built)try{await built.cleanup()}catch{await operations?.record('exports','EXPORT_LOCAL_CLEANUP_FAILED')}if(locked)try{await db.query('select pg_advisory_unlock(738041,0)')}catch{}db.release();}
 }
 const run=()=>{if(stopped)return Promise.resolve();if(pending)return pending;pending=once().catch(()=>{operations?.safeLog('EXPORT_WORKER_FAILED')}).finally(()=>{pending=null});return pending;};
 const start=()=>{timer=setInterval(run,15000);timer.unref?.();void run();return async()=>{stopped=true;clearInterval(timer);if(pending)await pending;};};
 return {run,start};
}
module.exports={createExportWorker,exportKey};
