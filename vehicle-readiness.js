'use strict';
const {companyDate}=require('./personnel-domain');

const ROAD_CODES=['circulation','soap','inspection'];
function day(value,zone='America/Santiago'){
  const d=value instanceof Date?new Date(value):new Date(value||Date.now());
  if(Number.isNaN(d.getTime()))throw Object.assign(new Error('Fecha inválida'),{status:400,code:'INVALID_DATE'});
  return companyDate(d,zone);
}

async function assertVehicleRoadReady(db,{companyId,truckId,now,lock=false}={}){
  if(!companyId||!truckId)throw Object.assign(new Error('Empresa y vehículo son obligatorios'),{status:400,code:'INVALID_CONTEXT'});
  const policy=(await db.query('select time_zone from company_personnel_policies where company_id=$1',[companyId])).rows[0];
  if(lock)await db.query('select id from trucks where id=$1 and company_id=$2 for no key update',[truckId,companyId]);
  const rows=(await db.query(`select t.id,t.company_id,t.status,
    coalesce(jsonb_object_agg(vd.road_requirement_code,jsonb_build_object('expires_at',vd.expires_at,'status',vd.status)) filter (where vd.road_requirement_code is not null),'{}'::jsonb) document_expiries
    from trucks t left join vehicle_documents vd on vd.truck_id=t.id and vd.road_requirement_code in ('circulation','soap','inspection') and vd.road_requirement_superseded=false
    where t.id=$1 and t.company_id=$2 group by t.id`,[truckId,companyId])).rows;
  const row=rows[0];
  if(!row)throw Object.assign(new Error('Vehículo no encontrado'),{status:404,code:'VEHICLE_NOT_FOUND'});
  const today=day(now,policy?.time_zone||'America/Santiago'), expiries=row.document_expiries||{};
  const labels={circulation:'Permiso de circulación',soap:'SOAP',inspection:'Revisión técnica'};
  const missing=ROAD_CODES.filter(code=>!expiries[code]||!expiries[code].expires_at);
  const expired=ROAD_CODES.filter(code=>expiries[code]?.expires_at&&String(expiries[code].expires_at).slice(0,10)<today);
  const invalidStatus=ROAD_CODES.filter(code=>!missing.includes(code)&&!['Vigente','Por vencer'].includes(expiries[code]?.status));
  const reasons=[...missing.map(c=>`${labels[c]}: fecha faltante`),...expired.map(c=>`${labels[c]}: fecha vencida`),...invalidStatus.map(c=>`${labels[c]}: estado documental no válido`)];
  if(reasons.length)throw Object.assign(new Error(`El vehículo no está habilitado para circular: ${reasons.join('; ')}`),{status:409,code:'VEHICLE_NOT_ROAD_READY',details:{missing,expired,invalid_status:invalidStatus,today,missing_labels:missing.map(c=>labels[c]),expired_labels:expired.map(c=>labels[c]),invalid_status_labels:invalidStatus.map(c=>labels[c]),reasons}});
  return {allowed:true,truck_id:row.id,today,documents:expiries};
}

module.exports={assertVehicleRoadReady,ROAD_CODES};
