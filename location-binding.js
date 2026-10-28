'use strict';
const fail=message=>Object.assign(new Error(message),{status:400,code:'LOCATION_SELECTION_INVALID'});
const id=value=>['string','number'].includes(typeof value)&&Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
// Called inside the record's existing transaction, before its audit and commit.
async function bindLocations(db,table,row,body,companyId,actorId=null){
 if(!['routes','trips','loads','trip_loads'].includes(table))throw fail('Recurso no válido');
 if(!['origin_location_id','destination_location_id','road_route_id'].some(k=>body[k]!=null&&body[k]!==''))return row;
 const origin=id(body.origin_location_id),destination=id(body.destination_location_id);
 if(!origin||!destination)throw fail('Selecciona y confirma origen y destino');
 const found=(await db.query('select id,name,address from operational_locations where company_id=$1 and id=any($2::bigint[]) for share',[companyId,[origin,destination]])).rows;
 const a=found.find(x=>Number(x.id)===origin),b=found.find(x=>Number(x.id)===destination);
 if(!a||!b)throw fail('Las ubicaciones deben pertenecer a la empresa activa');
 let route=null;
 if(body.road_route_id!=null&&body.road_route_id!==''){
  const routeId=id(body.road_route_id);if(!routeId||!['routes','trips'].includes(table))throw fail('Ruta vial no válida');
  route=(await db.query('select * from road_routes where id=$1 and company_id=$2 and origin_location_id=$3 and destination_location_id=$4 for share',[routeId,companyId,origin,destination])).rows[0];
  if(!route)throw fail('El cálculo vial no corresponde a los puntos seleccionados');
  if((route.snapped_points||[]).some(p=>Number(p.distance)>100)&&body.route_access_ack!=='true'&&body.route_access_ack!==true)throw fail('Confirma la revisión del acceso: el punto está separado de la vía calculada');
 }
 const values=[origin,destination,a.name,b.name,row.id];
 let extra='';if(['routes','trips'].includes(table)){values.push(route?.id||null,route?Number(route.distance_meters)/1000:null);extra=',road_route_id=$6,distance_km=$7';}
 const result=(await db.query(`update ${table} set origin_location_id=$1,destination_location_id=$2,origin=$3,destination=$4${extra} where id=$5 returning *`,values)).rows[0];
 if(table==='trips'&&route){
  const snapshot=(await db.query('insert into trip_route_snapshots(company_id,trip_id,road_route_id,origin_location_id,destination_location_id,distance_meters,duration_seconds,geometry,provider,route_calculated_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id',[companyId,row.id,route.id,origin,destination,route.distance_meters,route.duration_seconds,route.geometry,route.provider,route.calculated_at,actorId])).rows[0];
  await db.query('update trips set planned_route_snapshot_id=$1 where id=$2',[snapshot.id,row.id]);result.planned_route_snapshot_id=snapshot.id;
 }
 return result;
}
module.exports={bindLocations};
