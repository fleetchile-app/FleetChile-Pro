'use strict';
const crypto=require('node:crypto');
const {platformManager}=require('./enterprise-api');
const E=require('./enterprise-common');
const retention={business:'Sin borrado automático. Su conservación requiere una política expresamente aprobada.',gps:'Conservación GPS aplazada al cierre específico; no se elimina historial.',audit:'Auditoría y documentos emitidos conservados; no se purgan.',exports:'Copias de exportación privadas y temporales: 24 horas de descarga.',imports:'Borradores vencidos se limpian al cargar otro lote de su empresa; lotes confirmados conservan trazabilidad.'};
const DAYS=86400000;
function settings(env=process.env){const n=Number(env.MONITOR_TECHNICAL_DAYS||30);if(![15,30,90].includes(n))throw Error('MONITOR_TECHNICAL_DAYS debe ser 15, 30 o 90');return {technicalDays:n};}
function createOperations(pool,{logger=console,env=process.env}={}){
 const config=settings(env),workers=new Map();let lastDatabase=null,pending=new Set();
 const safeLog=(code,level='error')=>{try{logger[level]?.(JSON.stringify({service:'fleetchile',code,time:new Date().toISOString()}))}catch{}};
 async function incident(source,code,severity='error'){
  if(!/^[a-z_]{1,40}$/.test(source)||!/^[A-Z0-9_]{1,80}$/.test(code))return;
  try{await pool.query(`insert into service_incidents(source,code,severity) values($1,$2,$3)
   on conflict(source,code) where resolved_at is null do update set occurrences=service_incidents.occurrences+1,last_at=now(),acknowledged_at=null,acknowledged_by=null`,[source,code,severity]);}catch{safeLog('INCIDENT_STORAGE_UNAVAILABLE')}
 }
 const record=(source,code,severity)=>{const work=incident(source,code,severity).finally(()=>pending.delete(work));pending.add(work);return work};
 const recover=(source,code)=>{const work=(async()=>{try{await pool.query('update service_incidents set resolved_at=now() where source=$1 and code=$2 and resolved_at is null',[source,code])}catch{safeLog('INCIDENT_STORAGE_UNAVAILABLE')}})().finally(()=>pending.delete(work));pending.add(work);return work;};
 function worker(name,ok){workers.set(name,{ok,checked_at:new Date().toISOString()});if(!ok)void record(name,'BACKGROUND_TASK_FAILED');else void recover(name,'BACKGROUND_TASK_FAILED');}
 const monitorLogger=name=>({log(){},warn(){safeLog('BACKGROUND_TASK_FAILED','warn')},error(){safeLog('BACKGROUND_TASK_FAILED')}});
 async function check(){
  try{await pool.query('select 1');lastDatabase={ok:true,checked_at:new Date().toISOString()};await recover('database','DATABASE_UNAVAILABLE')}
  catch{lastDatabase={ok:false,checked_at:new Date().toISOString()};safeLog('DATABASE_UNAVAILABLE');await record('database','DATABASE_UNAVAILABLE')}
  try{await pool.query("delete from service_incidents where resolved_at is not null and last_at < now()-($1::int*interval '1 day')",[config.technicalDays])}catch{safeLog('TECHNICAL_RETENTION_FAILED')}
 }
 function start(){let running=null,stopped=false;const tick=()=>{if(stopped||running)return;running=check().finally(()=>{running=null});};const timer=setInterval(tick,60000);timer.unref?.();tick();return async()=>{stopped=true;clearInterval(timer);if(running)await running;await Promise.allSettled([...pending]);};}
 const middleware=(req,res,next)=>{
  req.requestId=crypto.randomUUID();res.setHeader('X-Request-Id',req.requestId);
  res.once('finish',()=>{if(res.statusCode>=500)void record('http','HTTP_5XX')});next();
 };
 const errorHandler=(error,req,res,next)=>{
  if(res.headersSent){safeLog('HTTP_STREAM_FAILED');return res.destroy();}
  const status=error?.type==='entity.too.large'?413:error?.type==='entity.parse.failed'?400:500;
  if(status===500)safeLog('UNHANDLED_HTTP_ERROR');res.status(status).json({error:status===413?'Solicitud demasiado grande':status===400?'JSON no válido':'No se pudo completar la solicitud',request_id:req.requestId});
 };
 const status=()=>({database:lastDatabase,workers:Object.fromEntries(workers),uptime_seconds:Math.floor(process.uptime()),memory_mb:Math.round(process.memoryUsage().rss/1048576),revision:/^[0-9a-f]{7,40}$/i.test(env.RENDER_GIT_COMMIT||env.APP_REVISION||'')?(env.RENDER_GIT_COMMIT||env.APP_REVISION):null,storage_configured:['S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'].every(k=>Boolean(env[k])),database_tls_verification:env.DATABASE_SSL==='true'&&env.DATABASE_SSL_VERIFY==='true',retention:{...retention,technical_closed_incidents_days:config.technicalDays}});
 return {record,recover,worker,monitorLogger,start,middleware,errorHandler,status,check,safeLog};
}
function registerOperationsStatus(app,pool,operations){
 const admin=(req,res,next)=>platformManager(req)?next():res.status(403).json({error:'Se requiere administración de plataforma'});
 app.get('/api/admin/service-status',admin,E.wrap(async(req,res)=>res.json({...operations.status(),incidents:(await pool.query('select id,source,code,severity,occurrences,first_at,last_at,resolved_at,acknowledged_at,acknowledged_by from service_incidents order by last_at desc limit 100')).rows})));
 app.post('/api/admin/service-incidents/:id/acknowledge',admin,E.wrap(async(req,res)=>{
  const id=E.id(req.params.id),why=E.reason(req.body?.reason),db=await pool.connect();try{await db.query('BEGIN');const r=(await db.query('update service_incidents set acknowledged_at=now(),acknowledged_by=$1 where id=$2 returning id',[req.user.id,id])).rows[0];if(!r)E.fail(404,'Incidente no encontrado');await require('./audit').writeAudit(db,req,{companyId:null,action:'acknowledge',entity:'service_incident',entityId:id,afterData:{reason:why}});await db.query('COMMIT');res.json({ok:true})}catch(e){try{await db.query('ROLLBACK')}catch{}throw e}finally{db.release()}
 }));
}
module.exports={createOperations,registerOperationsStatus,settings,retention};
