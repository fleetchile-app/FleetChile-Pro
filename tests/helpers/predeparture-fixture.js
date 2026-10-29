'use strict';
// Synthetic preconditions for integration tests whose subject is equipment or
// availability. Behaviour of acceptance/checklist is tested through APIs in the
// audit and integrated acceptance suites; never connected to application data.
async function recordPredepartureFixture(pool,tripId){
 const trip=(await pool.query('select * from trips where id=$1',[tripId])).rows[0];
 const user=(await pool.query('select id from users where company_id=$1 and driver_id=$2 order by id limit 1',[trip.company_id,trip.driver_id])).rows[0];
 if(!user||!trip.truck_id)throw Error('Falta conductor/vehículo sintético para predespacho');
 await pool.query(`insert into driver_mobile_actions(company_id,trip_id,actor_user_id,driver_id,resource_version,client_key,kind,payload_hash,result)
  values($1,$2,$3,$4,$5,$6,'accept',repeat('0',64),'{}')`,[trip.company_id,trip.id,user.id,trip.driver_id,trip.resource_version,'fixture-'+require('node:crypto').randomUUID()]);
 await pool.query(`insert into vehicle_checklists(trip_id,truck_id,driver_id,status,items,completed_at,created_by,completed_by)
  values($1,$2,$3,'Aprobado',$4,clock_timestamp(),$5,$5)`,[trip.id,trip.truck_id,trip.driver_id,JSON.stringify(require('../../public/checklist-shared').ids.map(id=>({id,result:'ok'}))),user.id]);
}
module.exports={recordPredepartureFixture};
