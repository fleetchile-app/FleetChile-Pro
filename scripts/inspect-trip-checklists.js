'use strict';
// Read-only diagnostic, no server startup, seed, migrations, updates or backfill.
const {Pool}=require('pg'),{databaseSsl}=require('../deployment-config'),C=require('../public/checklist-shared');
async function inspect(pool,number){
 if(typeof number!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(number))throw Error('Indica un número de viaje válido');
 const db=await pool.connect();try{
  await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='5000ms'");
  const trip=(await db.query('select id,trip_number,company_id,truck_id,driver_id,status from trips where trip_number=$1',[number])).rows[0];if(!trip)throw Error('Viaje no encontrado');
  const rows=(await db.query('select vc.* from vehicle_checklists vc where vc.trip_id=$1 order by vc.id desc',[trip.id])).rows;
  const audits=(await db.query(`select a.entity_id,a.action,a.created_at,a.user_id,u.name actor_name,a.after_data->>'status' status_after,
   case when jsonb_typeof(a.after_data->'items')='array' then jsonb_array_length(a.after_data->'items') else null end recorded_answers from audit_logs a left join users u on u.id=a.user_id
   where a.company_id=$1 and a.entity='vehicle_checklist' and a.entity_id in(select id::text from vehicle_checklists where trip_id=$2) order by a.id desc limit 30`,[trip.company_id,trip.id])).rows;
  await db.query('COMMIT');return {trip,checklists:rows.map(r=>({id:r.id,status:r.status,quality:C.quality(r),items:r.items,created_at:r.created_at,completed_at:r.completed_at,created_by_name:r.created_by_name||null,completed_by_name:r.completed_by_name||null,supersedes_id:r.supersedes_id||null})),audits};
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e;}finally{db.release();}
}
if(require.main===module)(async()=>{let pool;try{if(!process.env.DATABASE_URL)throw Error('Ejecuta el diagnóstico en el entorno autorizado con DATABASE_URL configurada');pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:databaseSsl(),max:1,connectionTimeoutMillis:5000});console.log(JSON.stringify(await inspect(pool,process.argv[2]),null,2));}catch{console.error('No se pudo consultar el viaje. Verifica número, acceso y conexión en el entorno autorizado; no se modificó ningún registro.');process.exitCode=1;}finally{await pool?.end();}})();
module.exports={inspect};
