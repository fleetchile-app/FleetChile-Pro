'use strict';
// Explicit allow-list. New tables do not silently enter a tenant's export.
const companyTables=[
 'trucks','drivers','routes','loads','maintenance','fuel','alerts','clients','trips','operational_locations','road_routes','trip_route_snapshots',
 'trip_economic_profiles','trip_revenue_history','trip_cost_items','trip_cost_versions','economic_authorization_requests',
 'company_personnel_policies','company_people','person_contracts','person_conditions','person_driver_licenses','person_events','personnel_notifications',
 'client_profile_events','client_consent_documents','client_privacy_status','driver_profile_events',
 'maintenance_work_items','maintenance_findings','maintenance_meter_readings','maintenance_work_order_events',
 'fleet_compositions','fleet_composition_revisions','trip_resource_revisions','trip_itinerary_revisions','trip_itinerary_events',
 'trip_finance_control','economic_sources','economic_source_allocations','trip_budget_revisions','economic_source_reversals','trip_distribution_revisions','trip_finance_events',
 'driver_mobile_actions','commercial_requests','commercial_quotes','commercial_quote_events','commercial_contracts','commercial_equipment_seats','commercial_seat_events',
 'company_branding_revisions','company_issued_documents','company_access_profiles','enterprise_events','company_support_grants','company_support_cases','user_memberships'
];
const parentScopes={
 client_locations:'exists(select 1 from clients c where c.id=t.client_id and c.company_id=$1)',
 vehicle_documents:'exists(select 1 from trucks v where v.id=t.truck_id and v.company_id=$1)',
 driver_documents:'exists(select 1 from drivers d where d.id=t.driver_id and d.company_id=$1)',
 vehicle_checklists:'exists(select 1 from trucks v where v.id=t.truck_id and v.company_id=$1)',
 telemetry:'exists(select 1 from trucks v where v.id=t.truck_id and v.company_id=$1)',
 trip_events:'exists(select 1 from trips p where p.id=t.trip_id and p.company_id=$1)',
 trip_status_history:'exists(select 1 from trips p where p.id=t.trip_id and p.company_id=$1)',
 trip_loads:'exists(select 1 from trips p where p.id=t.trip_id and p.company_id=$1)',
 trip_delivery_proofs:'exists(select 1 from trips p where p.id=t.trip_id and p.company_id=$1)',
 delivery_proof_files:'exists(select 1 from trip_delivery_proofs f join trips p on p.id=f.trip_id where f.id=t.proof_id and p.company_id=$1)',
 personnel_notification_reads:'exists(select 1 from personnel_notifications n where n.id=t.notification_id and n.company_id=$1)'
};
const CSV=new Set(['companies','clients','trucks','drivers','trips','trip_loads','maintenance','fuel','company_people','person_contracts']);
const excludedColumns=new Set(['password','password_hash','token','token_hash','secret','storage_key','logo','pdf']);
const identifier=s=>{if(!/^[a-z_][a-z0-9_]*$/.test(s))throw Error('Identificador de catálogo no válido');return '"'+s+'"'};
function scrub(value,companyId){
 if(Array.isArray(value))return value.map(v=>scrub(v,companyId));
 if(value&&typeof value==='object'){
  if(value.company_id!=null&&String(value.company_id)!==String(companyId))return {excluded_reference:'foreign_company'};
  return Object.fromEntries(Object.entries(value).filter(([k])=>!/(password|token|secret|credential|authorization|session|storage_key|memberships|database_url|access_key)/i.test(k)).map(([k,v])=>[k,scrub(v,companyId)]));
 }
 if(typeof value==='string')return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@').replace(/(https?:\/\/[^\s?]+)\?[^\s]*(?:signature|token|credential|key)[^\s]*/gi,'$1?[redacted]');
 return value;
}
function csvCell(value){let s=value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);if(typeof value!=='number'&&(/^[=+\-@\t\r\n]/.test(s)||/^\s+[=+\-@]/.test(s)))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
async function catalog(db){
 const all=['companies',...companyTables,...Object.keys(parentScopes)],entries=[];
 for(const table of all){
  const columns=(await db.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",[table])).rows;
  if(!columns.length)throw Object.assign(Error('Esquema no disponible'),{exportCode:'EXPORT_SCHEMA_MISMATCH'});
  const hasCompany=columns.some(c=>c.column_name==='company_id');
  const where=table==='companies'?'t.id=$1':hasCompany?'t.company_id=$1':parentScopes[table];
  if(!where)throw Object.assign(Error('Ámbito de tabla no definido'),{exportCode:'EXPORT_SCHEMA_MISMATCH'});
  const fields=columns.filter(c=>!excludedColumns.has(c.column_name)&&c.data_type!=='bytea').map(c=>`${identifier('t')}.${identifier(c.column_name)}${/date|timestamp/.test(c.data_type)?'::text':''} as ${identifier(c.column_name)}`);
  if(table==='company_branding_revisions')fields.push("case when t.logo is not null then 'files/branding/'||t.version||'.jpg' else null end logo_file");
  if(table==='company_issued_documents')fields.push("'files/issued/'||t.id||'.pdf' pdf_file");
  if(table==='delivery_proof_files')fields.push("'files/pod/'||t.id||'.bin' attachment_file");
  if(table==='client_consent_documents')fields.push("'files/consents/'||t.id||'.pdf' attachment_file");
  entries.push({name:table,sql:`select ${fields.join(',')} from ${identifier(table)} t where ${where}`,csv:CSV.has(table),columns:fields.map(f=>f.match(/(?:as )?"?([a-z_]+)"?$/)?.[1]||'value')});
 }
 entries.push({name:'accounts',sql:`select u.id,u.name,u.email,u.phone,u.active from users u where exists(select 1 from user_memberships m where m.user_id=u.id and m.company_id=$1) or (u.company_id=$1 and not exists(select 1 from user_memberships m where m.user_id=u.id))`});
 entries.push({name:'audit_metadata',sql:'select id,company_id,user_id,action,entity,entity_id,created_at::text created_at from audit_logs where company_id=$1'});
 entries.push({name:'import_metadata',sql:'select id,company_id,actor_id,kind,source_hash,created_at::text created_at,committed_at::text committed_at,result from company_import_batches where company_id=$1'});
 entries.push({name:'roles',sql:`select r.id,r.code,r.name,r.description from roles r where exists(select 1 from user_memberships m where m.company_id=$1 and m.role_id=r.id) or exists(select 1 from company_access_profiles a where a.company_id=$1 and a.base_role_id=r.id)`});
 entries.push({name:'role_permissions',sql:`select r.id role_id,p.code,p.name from roles r join role_permissions rp on rp.role_id=r.id join permissions p on p.id=rp.permission_id and p.scope='company' where exists(select 1 from user_memberships m where m.company_id=$1 and m.role_id=r.id) or exists(select 1 from company_access_profiles a where a.company_id=$1 and a.base_role_id=r.id)`});
 return entries;
}
module.exports={catalog,scrub,csvCell,companyTables,parentScopes};
