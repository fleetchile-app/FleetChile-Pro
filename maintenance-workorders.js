'use strict';
const {requirePermission,resolveActorContext}=require('./auth');
const {writeAudit}=require('./audit');
const D=require('./maintenance-domain');
const BASE='/api/fleet/work-orders';
const operational=o=>['received','in_progress'].includes(o.operation_stage);
function hasExistingPermission(req,code){
 let allowed=false;
 requirePermission(code)(req,{status(){return this;},json(){return this;}},()=>{allowed=true;});
 return allowed;
}
function fleetMutation(req){if(!hasExistingPermission(req,'fleet.manage'))throw D.fail('Se requiere fleet.manage para ingresar, medir o liberar el vehículo',403);}

function company(req){
 const a=resolveActorContext(req);
 if(!a||a.scope!=='company'||!a.company_id)throw D.fail('Selecciona una empresa para gestionar mantenciones',403);
 return a.company_id;
}
async function responsible(db,cid,userId){
 if(!userId)return null;
 const row=(await db.query(`select u.id from users u join user_memberships m on m.user_id=u.id
  where u.id=$1 and m.company_id=$2 and u.active=true and m.active=true limit 1`,[userId,cid])).rows[0];
 if(!row)throw D.fail('El responsable no es un usuario activo de la empresa');return row.id;
}
async function snapshot(db,cid,orderId){
 const order=(await db.query(`select m.*,t.patente,t.hour_meter_hours,t.km current_odometer_km,
  u.name responsible_name,d.name delivered_by_name,
  case when m.received_at is null then null else extract(epoch from(coalesce(m.released_at,now())-m.received_at))/3600 end downtime_hours,
  (m.operation_stage='scheduled' and ((coalesce(m.next_due_date,m.due)<current_date)
   or t.km>=m.next_due_odometer_km or t.hour_meter_hours>=m.next_due_hours)) overdue
  from maintenance m join trucks t on t.id=m.truck_id and t.company_id=m.company_id
  left join users u on u.id=m.responsible_user_id left join drivers d on d.id=m.delivered_by_driver_id
  where m.id=$1 and m.company_id=$2`,[orderId,cid])).rows[0];
 if(!order)throw D.fail('Orden no encontrada',404);
 const args=[cid,orderId];
 const lines=(await db.query('select * from maintenance_work_items where company_id=$1 and maintenance_id=$2 order by id',args)).rows;
 const findings=(await db.query('select * from maintenance_findings where company_id=$1 and maintenance_id=$2 order by id',args)).rows;
 const readings=(await db.query('select * from maintenance_meter_readings where company_id=$1 and maintenance_id=$2 order by reading_at,id',args)).rows;
 const events=(await db.query('select id,event_type,actor_user_id,actor_name,occurred_at,details from maintenance_work_order_events where company_id=$1 and maintenance_id=$2 order by id desc limit 100',args)).rows;
 const pending_checklist_alerts=(await db.query(`select a.id,a.title,a.text from alerts a join vehicle_checklists c on c.id=a.source_id
  join trips tr on tr.id=c.trip_id and tr.company_id=a.company_id where a.company_id=$1 and c.truck_id=$2
  and a.source_type='checklist' and a.condition_code='checklist_rejected' and not a.resolved order by a.id`,[cid,order.truck_id])).rows;
 return {...order,lines,findings,readings,events,pending_checklist_alerts,costs:D.costs(lines)};
}
async function log(db,req,order,event,before,details){
 await db.query(`insert into maintenance_work_order_events(company_id,maintenance_id,event_type,actor_user_id,actor_name,details)
  values($1,$2,$3,$4,$5,$6)`,[order.company_id,order.id,event,req.user.id,req.user.name||'Usuario autenticado',{before,...details}]);
 await writeAudit(db,req,{companyId:order.company_id,action:event,entity:'maintenance_work_order',entityId:order.id,beforeData:before,afterData:details});
}
async function meters(db,req,order,truck,b,readingAt,reason){
 fleetMutation(req);
 const km=D.number(b.odometer_km,'Odómetro (km)',{required:true,integer:true});
 const hours=D.number(b.hour_meter_hours,'Horómetro (horas)');
 if(km>2147483647)throw D.fail('Odómetro fuera del rango admitido por la flota');
 const last=(await db.query('select max(reading_at) last_reading_at from maintenance_meter_readings where company_id=$1 and maintenance_id=$2',[order.company_id,order.id])).rows[0];
 if(last?.last_reading_at&&new Date(readingAt)<new Date(last.last_reading_at))throw D.fail('La fecha de lectura o salida no puede ser anterior a la última lectura registrada');
 if(km<Number(truck.km||0)||km<Number(order.odometer_km||0))throw D.fail('El odómetro no puede disminuir respecto a la flota o al ingreso');
 if(hours!==null&&(hours<Number(truck.hour_meter_hours||0)||hours<Number(order.received_hours||0)))throw D.fail('El horómetro no puede disminuir');
 await db.query(`insert into maintenance_meter_readings(company_id,maintenance_id,truck_id,reading_at,odometer_km,hour_meter_hours,reason,actor_user_id)
  values($1,$2,$3,$4,$5,$6,$7,$8)`,[order.company_id,order.id,truck.id,readingAt,km,hours,reason,req.user.id]);
 await db.query('update trucks set km=$1,hour_meter_hours=coalesce($2,hour_meter_hours) where id=$3 and company_id=$4',[km,hours,truck.id,order.company_id]);
 return {km,hours};
}
async function receive(db,req,order,truck,b,now){
 fleetMutation(req);
 if(order.operation_stage!=='scheduled')throw D.fail('Sólo se recibe una orden programada',409);
 const at=D.instant(b.received_at,'Fecha y hora de ingreso',now);
 const execution=(await db.query(`select id,trip_number from trips where company_id=$1 and (truck_id=$2 or trailer_id=$2)
  and status in ('En carga','En tránsito','Detenido','Llegó a destino','Descargando') limit 1`,[order.company_id,truck.id])).rows[0];
 if(execution)throw D.fail('El vehículo tiene un viaje en ejecución. Resuelve su situación antes de ingresarlo al taller.',409);
 if((await db.query("select id from maintenance where company_id=$1 and truck_id=$2 and id<>$3 and status='En proceso' limit 1",[order.company_id,truck.id,order.id])).rows.length)throw D.fail('El vehículo ya tiene una mantención en proceso',409);
 const driverId=D.id(b.delivered_by_driver_id,'Conductor que entrega',false);
 if(driverId&&!(await db.query('select id from drivers where id=$1 and company_id=$2',[driverId,order.company_id])).rows.length)throw D.fail('El conductor no pertenece a la empresa');
 const reading=await meters(db,req,order,truck,b,at,'Ingreso a taller');
 const after=(await db.query(`update maintenance set operation_stage='received',status='En proceso',received_at=$1,
  odometer_km=$2,received_hours=$3,delivered_by_driver_id=$4,previous_truck_status=$5,updated_at=now()
  where id=$6 and company_id=$7 returning *`,[at,reading.km,reading.hours,driverId,truck.status,order.id,order.company_id])).rows[0];
 await db.query("update trucks set status='Mantención' where id=$1 and company_id=$2",[truck.id,order.company_id]);
 return after;
}
function registerMaintenanceWorkOrderRoutes(app,pool,{now=()=>new Date()}={}){
 const route=(method,path,work)=>app[method](BASE+path,requirePermission('maintenance.manage'),async(req,res)=>{
  try{const cid=company(req);await work(req,res,cid);}catch(e){res.status(e.status||500).json({code:e.code||'MAINTENANCE_ERROR',error:e.status?e.message:'No se pudo procesar la mantención'});}
 });
 // All mutations lock truck -> order. No trip/person locks are taken in this module.
 const mutate=async(req,res,cid,event,work)=>{
  const orderId=D.id(req.params.id),db=await pool.connect();
  try{
   await db.query('BEGIN');
   const ref=(await db.query('select truck_id from maintenance where id=$1 and company_id=$2 and operation_stage is not null',[orderId,cid])).rows[0];
   if(!ref)throw D.fail('Orden no encontrada',404);
   const truck=(await db.query('select * from trucks where id=$1 and company_id=$2 for no key update',[ref.truck_id,cid])).rows[0];
   if(!truck)throw D.fail('Vehículo no encontrado',404);
   const before=(await db.query('select * from maintenance where id=$1 and company_id=$2 for update',[orderId,cid])).rows[0];
   D.version(before,req.body?.work_order_version);
   if(['closed','cancelled'].includes(before.operation_stage))throw D.fail('La orden está cerrada y conserva su historial',409);
   const details=await work(db,before,truck,req.body||{});
   const after=(await db.query('update maintenance set work_order_version=work_order_version+1,updated_at=now() where id=$1 and company_id=$2 returning *',[orderId,cid])).rows[0];
   await log(db,req,after,event,before,{order:after,...details});
   const result=await snapshot(db,cid,orderId);
   await db.query('COMMIT');res.json(result);
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 };
 route('get','/options',async(req,res,cid)=>{
  const trucks=(await pool.query('select id,patente,km,hour_meter_hours,status from trucks where company_id=$1 order by patente',[cid])).rows;
  const drivers=(await pool.query('select id,name from drivers where company_id=$1 order by name',[cid])).rows;
  const users=(await pool.query(`select distinct u.id,u.name from users u join user_memberships m on m.user_id=u.id
   where m.company_id=$1 and m.active=true and u.active=true order by u.name`,[cid])).rows;
  res.json({trucks,drivers,users,can_operate_fleet:hasExistingPermission(req,'fleet.manage')});
 });
 route('get','',async(req,res,cid)=>{
  const values=[cid],where=['m.company_id=$1'];
  if(req.query.truck_id){values.push(D.id(req.query.truck_id));where.push(`m.truck_id=$${values.length}`);}
  if(req.query.stage){if(!['scheduled','received','in_progress','released','closed','cancelled','legacy'].includes(req.query.stage))throw D.fail('Etapa no válida');
   if(req.query.stage==='legacy')where.push('m.operation_stage is null');else{values.push(req.query.stage);where.push(`m.operation_stage=$${values.length}`);}}
  const page=D.id(req.query.page||1,'Página'),size=25;
  const count=(await pool.query(`select count(*)::int total from maintenance m where ${where.join(' and ')}`,values)).rows[0].total;
  const rows=(await pool.query(`select m.*,t.patente,
   case when m.received_at is null then null else extract(epoch from(coalesce(m.released_at,now())-m.received_at))/3600 end downtime_hours,
   (m.operation_stage='scheduled' and (coalesce(m.next_due_date,m.due)<current_date or t.km>=m.next_due_odometer_km or t.hour_meter_hours>=m.next_due_hours)) overdue
   from maintenance m left join trucks t on t.id=m.truck_id and t.company_id=m.company_id where ${where.join(' and ')}
   order by m.created_at desc,m.id desc limit 25 offset $${values.length+1}`,[...values,(page-1)*size])).rows;
  res.json({rows,total:count,page,page_size:size});
 });
 route('get','/:id',async(req,res,cid)=>res.json(await snapshot(pool,cid,D.id(req.params.id))));
 route('post','',async(req,res,cid)=>{
  const b=req.body||{},truckId=D.id(b.truck_id,'Vehículo'),reason=D.text(b.reason,'Motivo del ingreso',{required:true,max:1000});
  if(!['schedule','receive'].includes(b.mode))throw D.fail('Selecciona programar o ingresar al taller');
  if(!['Preventiva','Correctiva'].includes(b.maintenance_type))throw D.fail('Tipo de mantención no válido');
  const due=b.mode==='schedule'&&b.scheduled_for?D.date(b.scheduled_for):null,routine=D.routine(b.routine);
  const dueKm=b.mode==='schedule'?D.number(b.scheduled_odometer_km,'Kilometraje programado',{integer:true}):null;
  const dueHours=b.mode==='schedule'?D.number(b.scheduled_hours,'Horómetro programado'):null;
  if(b.mode==='schedule'&&!due&&dueKm===null&&dueHours===null)throw D.fail('Programa una fecha, un kilometraje o una lectura de horómetro');
  if(routine&&b.maintenance_type!=='Preventiva')throw D.fail('Las rutinas recurrentes requieren mantención preventiva');
  for(const key of ['cost_clp','parts_cost_clp','labor_cost_clp','diagnosis','work_summary'])if(Object.hasOwn(b,key))throw D.fail('El ingreso no registra trabajos ni costos finales');
  const db=await pool.connect();try{
   await db.query('BEGIN');
   const truck=(await db.query('select * from trucks where id=$1 and company_id=$2 for no key update',[truckId,cid])).rows[0];if(!truck)throw D.fail('Vehículo no encontrado',404);
   const userId=await responsible(db,cid,D.id(b.responsible_user_id,'Responsable',false));
   let order=(await db.query(`insert into maintenance(company_id,truck_id,truck,item,maintenance_type,status,operation_stage,due,next_due_date,cost_clp,workshop,responsible_user_id,routine,next_due_odometer_km,next_due_hours)
    values($1,$2,$3,$4,$5,'Pendiente','scheduled',$6,$6,null,$7,$8,$9,$10,$11) returning *`,[cid,truckId,truck.patente,reason,b.maintenance_type,due,D.text(b.workshop,'Taller',{max:200}),userId,routine,dueKm,dueHours])).rows[0];
   if(b.mode==='receive')order=await receive(db,req,order,truck,b,now());
   await log(db,req,order,b.mode==='receive'?'intake':'schedule',null,{order});
   const result=await snapshot(db,cid,order.id);await db.query('COMMIT');res.status(201).json(result);
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
 route('post','/:id/receive',(req,res,cid)=>mutate(req,res,cid,'intake',async(db,o,t,b)=>({received:await receive(db,req,o,t,b,now())})));
 route('patch','/:id',(req,res,cid)=>mutate(req,res,cid,'diagnosis',async(db,o,t,b)=>{
  if(o.operation_stage==='released')throw D.fail('La liberación técnica no puede reescribirse; sólo completa costos',409);
  const allowed=new Set(['work_order_version','reason','diagnosis','work_summary','workshop','responsible_user_id','scheduled_for','scheduled_odometer_km','scheduled_hours','routine']);
  if(Object.keys(b).some(k=>!allowed.has(k)))throw D.fail('Campo de ficha no permitido');
  if(o.operation_stage==='scheduled'&&(b.diagnosis||b.work_summary))throw D.fail('Primero registra el ingreso real al taller',409);
  if(['scheduled_for','scheduled_odometer_km','scheduled_hours'].some(k=>b[k]!==undefined)&&o.operation_stage!=='scheduled')throw D.fail('La programación no cambia después del ingreso',409);
  const userId=b.responsible_user_id===undefined?o.responsible_user_id:await responsible(db,cid,D.id(b.responsible_user_id,'Responsable',false));
  const r=b.routine===undefined?o.routine:D.routine(b.routine);if(r&&o.maintenance_type!=='Preventiva')throw D.fail('Rutina sólo para mantención preventiva');
  const read=(key,field=key)=>b[key]===undefined?o[field]:D.text(b[key],key,{required:key==='reason'});
  const due=b.scheduled_for===undefined?o.due:b.scheduled_for?D.date(b.scheduled_for):null;
  const dueKm=b.scheduled_odometer_km===undefined?o.next_due_odometer_km:D.number(b.scheduled_odometer_km,'Kilometraje programado',{integer:true});
  const dueHours=b.scheduled_hours===undefined?o.next_due_hours:D.number(b.scheduled_hours,'Horómetro programado');
  if(o.operation_stage==='scheduled'&&!due&&dueKm===null&&dueHours===null)throw D.fail('La programación requiere fecha, km u horas');
  await db.query(`update maintenance set item=$1,diagnosis=$2,work_summary=$3,workshop=$4,responsible_user_id=$5,routine=$6,
   due=$7,next_due_date=$7,operation_stage=$8,status=$9,next_due_odometer_km=$10,next_due_hours=$11 where id=$12 and company_id=$13`,
   [read('reason','item'),read('diagnosis'),read('work_summary'),read('workshop'),userId,r,due,
    operational(o)&&b.diagnosis?'in_progress':o.operation_stage,operational(o)?'En proceso':o.status,dueKm,dueHours,o.id,cid]);
  return {};
 }));
 const saveItem=async(db,o,b,current)=>{
  const fields=new Set(['work_order_version','kind','description','quantity','estimated_unit_cost_clp','actual_unit_cost_clp','status','note']);
  if(Object.keys(b).some(k=>!fields.has(k)))throw D.fail('Campo de trabajo no permitido');
  if(o.operation_stage==='released'&&(!current||Object.keys(b).some(k=>!['work_order_version','actual_unit_cost_clp','note'].includes(k))))throw D.fail('Después de liberar sólo se completan precios reales y notas',409);
  const line=D.item({...current,...b});
  if(o.operation_stage==='scheduled'&&(line.status==='done'||line.actual_unit_cost_clp!==null))throw D.fail('Una programación sólo admite trabajos y precios estimados');
  if(line.status==='cancelled'&&!line.note)throw D.fail('Indica el motivo de cancelación del trabajo');
  const vals=[line.kind,line.description,line.quantity,line.estimated_unit_cost_clp,line.actual_unit_cost_clp,line.status,line.note];
  const result=await db.query(`update maintenance_work_items set kind=$1,description=$2,quantity=$3,estimated_unit_cost_clp=$4,actual_unit_cost_clp=$5,status=$6,note=$7,updated_at=now()
   where id=$8 and company_id=$9 and maintenance_id=$10 returning *`,[...vals,current.id,o.company_id,o.id]);
  return {line:result.rows[0]};
 };
 // Created_by is passed explicitly; never accept actors from request bodies.
 route('post','/:id/items',(req,res,cid)=>mutate(req,res,cid,'item_add',async(db,o,t,b)=>{
  if(o.operation_stage==='released')throw D.fail('No se agregan trabajos tras la liberación',409);
  const l=D.item(b);if(o.operation_stage==='scheduled'&&(l.status==='done'||l.actual_unit_cost_clp!==null))throw D.fail('Primero registra el ingreso para trabajos reales');
  if(l.status==='cancelled'&&!l.note)throw D.fail('Indica el motivo de cancelación');
  const row=(await db.query(`insert into maintenance_work_items(company_id,maintenance_id,kind,description,quantity,estimated_unit_cost_clp,actual_unit_cost_clp,status,note,created_by)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[cid,o.id,l.kind,l.description,l.quantity,l.estimated_unit_cost_clp,l.actual_unit_cost_clp,l.status,l.note,req.user.id])).rows[0];return {line:row};
 }));
 route('patch','/:id/items/:itemId',(req,res,cid)=>mutate(req,res,cid,'item_update',async(db,o,t,b)=>{
  const current=(await db.query('select * from maintenance_work_items where id=$1 and company_id=$2 and maintenance_id=$3',[D.id(req.params.itemId),cid,o.id])).rows[0];
  if(!current)throw D.fail('Trabajo no encontrado',404);return saveItem(db,o,b,current);
 }));
 route('post','/:id/findings',(req,res,cid)=>mutate(req,res,cid,'finding_add',async(db,o,t,b)=>{
  if(!operational(o))throw D.fail('Los hallazgos se registran mientras el vehículo está en taller',409);
  const description=D.text(b.description,'Hallazgo',{required:true});if(!['minor','major','critical'].includes(b.severity))throw D.fail('Severidad no válida');
  const userId=await responsible(db,cid,D.id(b.responsible_user_id,'Responsable',false)),alertId=D.id(b.source_alert_id,'Alerta',false);
  if(alertId){
   if((await db.query('select id from maintenance_findings where company_id=$1 and source_alert_id=$2',[cid,alertId])).rows.length)throw D.fail('El checklist ya está vinculado a un hallazgo; utiliza su ficha de reparación',409);
   const a=(await db.query(`select a.id from alerts a join vehicle_checklists c on c.id=a.source_id join trips tr on tr.id=c.trip_id and tr.company_id=a.company_id
   where a.id=$1 and a.company_id=$2 and c.truck_id=$3 and a.source_type='checklist' and a.condition_code='checklist_rejected' and a.resolved=false`,[alertId,cid,t.id])).rows[0];if(!a)throw D.fail('La alerta no es un checklist pendiente de este vehículo');}
  const row=(await db.query(`insert into maintenance_findings(company_id,maintenance_id,description,severity,responsible_user_id,source_alert_id)
   values($1,$2,$3,$4,$5,$6) returning *`,[cid,o.id,description,alertId?'critical':b.severity,userId,alertId])).rows[0];return {finding:row};
 }));
 route('patch','/:id/findings/:findingId',(req,res,cid)=>mutate(req,res,cid,'finding_update',async(db,o,t,b)=>{
  if(!operational(o))throw D.fail('La ficha técnica ya no admite cambios de hallazgos',409);
  const finding=(await db.query('select * from maintenance_findings where id=$1 and company_id=$2 and maintenance_id=$3',[D.id(req.params.findingId),cid,o.id])).rows[0];if(!finding)throw D.fail('Hallazgo no encontrado',404);
  const transitions={open:['fixed'],fixed:['verified','open'],verified:['open']};if(!transitions[finding.state].includes(b.state))throw D.fail('Transición de hallazgo no válida',409);
  const remedy=D.text(b.remedy,'Acción correctiva',{required:true});
  const userId=b.responsible_user_id===undefined?finding.responsible_user_id:await responsible(db,cid,D.id(b.responsible_user_id,'Responsable',false));
  const row=(await db.query(`update maintenance_findings set state=$1,remedy=$2,responsible_user_id=$3,
   fixed_by=case when $1='fixed' then $4 else fixed_by end,verified_by=case when $1='verified' then $4 else null end,
   verified_at=case when $1='verified' then now() else null end where id=$5 and company_id=$6 returning *`,[b.state,remedy,userId,req.user.id,finding.id,cid])).rows[0];return {finding:row};
 }));
 route('post','/:id/meters',(req,res,cid)=>mutate(req,res,cid,'meter_reading',async(db,o,t,b)=>{
  if(!operational(o))throw D.fail('Lecturas sólo durante la estadía en taller',409);
  const at=D.instant(b.reading_at,'Fecha de lectura',now());if(new Date(at)<new Date(o.received_at))throw D.fail('La lectura no puede ser anterior al ingreso');
  return {reading:await meters(db,req,o,t,b,at,D.text(b.reason,'Motivo de lectura',{required:true}))};
 }));
 route('post','/:id/release',(req,res,cid)=>mutate(req,res,cid,'technical_release',async(db,o,t,b)=>{
  fleetMutation(req);
  if(!operational(o))throw D.fail('Sólo se libera un vehículo ingresado',409);
  if(!o.diagnosis||!o.work_summary)throw D.fail('Completa diagnóstico y resumen de trabajos antes de liberar',409);
  const at=D.instant(b.released_at,'Fecha y hora de liberación',now()),note=D.text(b.release_note,'Conclusión técnica',{required:true});
  if(new Date(at)<new Date(o.received_at))throw D.fail('La liberación no puede ser anterior al ingreso');
  const findings=(await db.query('select * from maintenance_findings where company_id=$1 and maintenance_id=$2',[cid,o.id])).rows;
  if(findings.some(f=>f.state!=='verified'))throw D.fail('Repara y verifica todos los hallazgos antes de liberar',409);
  const items=(await db.query('select * from maintenance_work_items where company_id=$1 and maintenance_id=$2',[cid,o.id])).rows;
  if(items.some(l=>l.status==='pending'))throw D.fail('Completa o cancela con motivo los trabajos pendientes',409);
  const pending=(await db.query(`select a.id from alerts a join vehicle_checklists c on c.id=a.source_id join trips tr on tr.id=c.trip_id and tr.company_id=a.company_id
   where a.company_id=$1 and c.truck_id=$2 and a.source_type='checklist' and a.condition_code='checklist_rejected' and not a.resolved`,[cid,t.id])).rows;
  if(pending.some(a=>!findings.some(f=>String(f.source_alert_id)===String(a.id))))throw D.fail('Vincula los checklist rechazados pendientes a hallazgos y verifica su reparación',409);
  const reading=await meters(db,req,o,t,b,at,'Liberación técnica'),r=D.routine(o.routine);
  if(r?.hours&&reading.hours===null)throw D.fail('La rutina por horas requiere horómetro al liberar');
  for(const a of pending){await db.query(`update alerts set resolved=true,resolved_at=now(),resolved_by=$1,resolution_note=$2 where id=$3 and company_id=$4`,[req.user.id,'Reparación verificada y liberación técnica OT #'+o.id+': '+note,a.id,cid]);await writeAudit(db,req,{companyId:cid,action:'resolve',entity:'alert',entityId:a.id,afterData:{maintenance_id:o.id,resolution_note:note}});}
  await db.query(`update maintenance set operation_stage='released',status='Completada',released_at=$1,performed_at=$1::timestamptz::date,
   released_odometer_km=$2,released_hours=$3,release_note=$4 where id=$5 and company_id=$6`,[at,reading.km,reading.hours,note,o.id,cid]);
  const others=(await db.query("select id from maintenance where company_id=$1 and truck_id=$2 and id<>$3 and status='En proceso' limit 1",[cid,t.id,o.id])).rows;
  if(!others.length&&t.status==='Mantención')await db.query('update trucks set status=$1 where id=$2 and company_id=$3',[
   ['Mantención','En ruta'].includes(o.previous_truck_status)?'Disponible':o.previous_truck_status||'Disponible',t.id,cid]);
  let next=null;
  if(r){
   const policy=(await db.query('select time_zone from company_personnel_policies where company_id=$1',[cid])).rows[0];
   next=(await db.query(`insert into maintenance(company_id,truck_id,truck,item,maintenance_type,status,operation_stage,due,next_due_date,next_due_odometer_km,next_due_hours,cost_clp,routine,previous_work_order_id,workshop,responsible_user_id)
    values($1,$2,$3,$4,'Preventiva','Pendiente','scheduled',case when $5::integer is null then null else ($6::timestamptz at time zone $7)::date+$5::integer end,
     case when $5::integer is null then null else ($6::timestamptz at time zone $7)::date+$5::integer end,$8,$9,null,$10,$11,$12,$13) returning *`,
    [cid,t.id,t.patente,r.name,r.days,at,policy?.time_zone||'America/Santiago',r.km?reading.km+r.km:null,r.hours?reading.hours+r.hours:null,r,o.id,o.workshop,o.responsible_user_id])).rows[0];
   await log(db,req,next,'routine_scheduled',null,{order:next,previous_work_order_id:o.id});
  }
  return {release_note:note,next_work_order_id:next?.id||null};
 }));
 route('post','/:id/close',(req,res,cid)=>mutate(req,res,cid,'financial_close',async(db,o,t,b)=>{
  if(o.operation_stage!=='released')throw D.fail('Primero registra la liberación técnica',409);
  const lines=(await db.query('select * from maintenance_work_items where company_id=$1 and maintenance_id=$2',[cid,o.id])).rows.filter(l=>l.status!=='cancelled');
  const zero=D.text(b.zero_cost_reason,'Motivo sin costo'),totals=D.costs(lines);
  if(lines.some(l=>l.status!=='done')||totals.unknown_actual)throw D.fail('Completa todos los trabajos y sus precios reales antes del cierre',409);
  if((!lines.length||totals.actual===0)&&!zero)throw D.fail('Confirma con un motivo que la mantención no tuvo costo');
  const parts=lines.filter(l=>l.kind==='part').reduce((n,l)=>n+Math.round(Number(l.quantity)*Number(l.actual_unit_cost_clp)),0);
  const total=totals.actual||0;if(!Number.isSafeInteger(total)||total>1e12)throw D.fail('Costo total fuera de rango');
  await db.query(`update maintenance set operation_stage='closed',financially_closed_at=now(),cost_clp=$1,parts_cost_clp=$2,labor_cost_clp=$3,zero_cost_reason=$4
   where id=$5 and company_id=$6`,[total,parts,total-parts,zero,o.id,cid]);return {final_cost_clp:total};
 }));
 route('post','/:id/cancel',(req,res,cid)=>mutate(req,res,cid,'cancel',async(db,o,t,b)=>{
  if(o.operation_stage!=='scheduled')throw D.fail('Un ingreso real no se cancela para liberar el vehículo: requiere liberación técnica',409);
  const reason=D.text(b.reason,'Motivo de cancelación',{required:true});
  await db.query("update maintenance set operation_stage='cancelled',status='Cancelada',notes=$1 where id=$2 and company_id=$3",[reason,o.id,cid]);return {reason};
 }));
}
module.exports={registerMaintenanceWorkOrderRoutes,snapshot,company};
