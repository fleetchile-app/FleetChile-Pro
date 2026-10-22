'use strict';

const {companyDate}=require('./personnel-domain');
const {loadEligibility}=require('./personnel-access');

const DEFAULT_INTERVAL_MS=60*1000;
const ENDED_KIND='condition-ended';

function endedConditionQuery(now){
 return `select pc.id,pc.company_id,pc.person_id,pc.end_date::text as end_date,cp.time_zone
 from person_conditions pc
 join company_personnel_policies cp on cp.company_id=pc.company_id
 where pc.cancelled_at is null
   and pc.created_at is not null
   and pc.end_date < (($1::timestamptz at time zone cp.time_zone)::date)
   and not exists(
    select 1 from personnel_notifications pn
    where pn.company_id=pc.company_id
      and pn.event_key=('condition-ended:'||pc.id||':'||pc.end_date::text)
   )
 order by pc.company_id,pc.id`;
}

async function reconcilePersonnelNotifications(pool,{now=new Date()}={}){
 if(!pool||typeof pool.query!=='function')throw new TypeError('pool.query es obligatorio');
 const conditions=(await pool.query(endedConditionQuery(now),[now])).rows||[];
 let created=0;
 for(const condition of conditions){
  const today=companyDate(now,condition.time_zone||'America/Santiago');
  // Keep the comparison in application code as well: it makes the inclusive
  // end-date rule explicit and protects fake/test pools from timezone drift.
  if(!(String(condition.end_date)<today))continue;
  const eligibility=await loadEligibility(pool,{companyId:condition.company_id,personId:condition.person_id,now});
  const message=eligibility.allowed
   ? 'El período terminó; retorno automático habilitado'
   : 'El período terminó; otros bloqueos siguen';
  const eventKey=`condition-ended:${condition.id}:${String(condition.end_date).slice(0,10)}`;
  const result=await pool.query(`insert into personnel_notifications(company_id,person_id,event_key,kind,message)
 values($1,$2,$3,$4,$5) on conflict(company_id,event_key) do nothing returning id`,
   [condition.company_id,condition.person_id,eventKey,ENDED_KIND,message]);
  if(result.rowCount)created+=result.rowCount;
 }
 return {scanned:conditions.length,created};
}

function startPersonnelMonitor(pool,{logger=console,intervalMs=DEFAULT_INTERVAL_MS}={}){
 let stopped=false,active=false,timer=null,pending=null;
 const log=(method,message,error)=>{
  try{if(typeof logger?.[method]==='function')logger[method](message,error?{error: 'reconciliation_failed'}:undefined)}catch{}
 };
 const reconcile=()=>{
  if(stopped)return Promise.resolve();
  if(active)return pending;
  active=true;
  pending=(async()=>{
   try{await reconcilePersonnelNotifications(pool)}
   catch(error){log('error','Personnel notification reconciliation failed',error)}
  })().finally(()=>{active=false;pending=null});
  return pending;
 };
 timer=setInterval(reconcile,intervalMs);
 if(typeof timer.unref==='function')timer.unref();
 pending=reconcile();
 return async()=>{
  if(stopped)return;
  stopped=true;
  if(timer)clearInterval(timer);
  if(pending)await pending;
 };
}

module.exports={reconcilePersonnelNotifications,startPersonnelMonitor,endedConditionQuery};
