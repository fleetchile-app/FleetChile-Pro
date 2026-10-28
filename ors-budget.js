'use strict';
const {createHash}=require('node:crypto');
const positive=(v,fallback)=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:fallback;};
function limits(service,env=process.env){return service==='directions'?{daily:positive(env.ORS_DIRECTIONS_DAILY_LIMIT,2000),minute:positive(env.ORS_DIRECTIONS_MINUTE_LIMIT,40)}:{daily:positive(env.ORS_GEOCODING_DAILY_LIMIT,1000),minute:positive(env.ORS_GEOCODING_MINUTE_LIMIT,100)};}
async function reserve(pool,key,service,env=process.env){
 if(!pool)throw Object.assign(new Error('No se configuró el control de cuotas de OpenRouteService'),{code:'configuration_error'});
 const hash=createHash('sha256').update(key).digest('hex'),budget=limits(service,env),db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('insert into ors_request_budgets(credential_hash,service) values($1,$2) on conflict do nothing',[hash,service]);
  const row=(await db.query(`select *,clock_timestamp() budget_now from ors_request_budgets where credential_hash=$1 and service=$2 for update`,[hash,service])).rows[0];
  const now=new Date(row.budget_now),reset=+now-+new Date(row.window_started_at)>=86400000;
  const events=(row.minute_events||[]).map(x=>new Date(x)).filter(x=>+x>+now-60000),used=reset?0:row.requests_used;
  if(used>=budget.daily||events.length>=budget.minute)throw Object.assign(new Error('Cuota local de OpenRouteService alcanzada. Reintenta más tarde; no se inventó un resultado.'),{code:'quota_exceeded'});
  events.push(now);
  await db.query('update ors_request_budgets set window_started_at=$3,requests_used=$4,minute_events=$5::timestamptz[] where credential_hash=$1 and service=$2',[hash,service,reset?now:row.window_started_at,used+1,events.map(x=>x.toISOString())]);
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');if(['configuration_error','quota_exceeded'].includes(e.code))throw e;throw Object.assign(new Error('No se pudo verificar la cuota de OpenRouteService'),{code:'budget_unavailable'});}finally{db.release();}
}
module.exports={reserve,limits};
