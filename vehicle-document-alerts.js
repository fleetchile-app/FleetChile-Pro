'use strict';
const LABELS={circulation:'Permiso de circulación',soap:'Seguro obligatorio (SOAP)',inspection:'Revisión técnica'};
function roadAlert(row){
 let band;
 if(!row.expires_at)band='missing';
 else if(Number(row.days_remaining)<0)band='expired';
 else if(!['Vigente','Por vencer'].includes(row.status))band='missing';
 else if(Number(row.days_remaining)<=7)band='7';
 else if(Number(row.days_remaining)<=15)band='15';
 else if(Number(row.days_remaining)<=30)band='30';
 else return null;
 const title=band==='missing'?'Documentación vial pendiente':band==='expired'?'Documento vial vencido':`Documento vial: aviso de ${band} días`;
 const detail=band==='missing'?'fecha o estado habilitante pendiente':band==='expired'?`venció el ${row.expires_at}`:`vence el ${row.expires_at} (${row.days_remaining} días)`;
 return {source_id:String(row.truck_id),condition_code:`road_${row.kind}_${band}`,level:['missing','expired'].includes(band)?'critical':'warning',title,text:`${row.patente} · ${LABELS[row.kind]} · ${detail}`};
}
async function reconcileVehicleDocumentAlerts(pool,{companyId}={}){
 const companies=(await pool.query(`select c.id from companies c where c.active=true${companyId?' and c.id=$1':''} order by c.id`,companyId?[companyId]:[])).rows;
 let changed=0,resolved=0;
 for(const company of companies){
  const db=await pool.connect();try{
   await db.query('BEGIN');
   // Serialize this reconciliation across instances without blocking FK reads.
   await db.query('select id from companies where id=$1 for no key update',[company.id]);
   await db.query('select id from trucks where company_id=$1 order by id for share',[company.id]);
   const rows=(await db.query(`select t.id truck_id,t.patente,k.kind,vd.expires_at::text expires_at,vd.status,
    (vd.expires_at-(now() at time zone pp.time_zone)::date)::int days_remaining
    from trucks t join company_personnel_policies pp on pp.company_id=t.company_id
    cross join (values('circulation'),('soap'),('inspection')) k(kind)
    left join vehicle_documents vd on vd.truck_id=t.id and vd.road_requirement_code=k.kind and not vd.road_requirement_superseded
    where t.company_id=$1`,[company.id])).rows;
   const candidates=rows.map(roadAlert).filter(Boolean);
   if(candidates.length){
    const r=await db.query(`insert into alerts(company_id,source_type,source_id,condition_code,level,title,text,resolved,created_at)
     select $1,'truck',a.source_id::bigint,a.condition_code,a.level,a.title,a.text,false,now()
     from jsonb_to_recordset($2::jsonb) a(source_id text,condition_code text,level text,title text,text text)
     on conflict(company_id,source_type,source_id,condition_code)
     where resolved=false and source_type is not null and source_id is not null and condition_code is not null
     do update set level=excluded.level,title=excluded.title,text=excluded.text returning id`,[company.id,JSON.stringify(candidates)]);
    changed+=r.rowCount||0;
   }
   const wanted=candidates.map(r=>r.source_id+':'+r.condition_code);
   const closed=await db.query(`update alerts set resolved=true,resolved_at=now(),resolution_note='Condición documental actualizada'
    where company_id=$1 and source_type='truck' and left(condition_code,5)='road_' and resolved=false
    and not ((source_id::text||':'||condition_code)=any($2::text[])) returning id`,[company.id,wanted]);
   resolved+=closed.rowCount||0;await db.query('COMMIT');
  }catch(e){try{await db.query('ROLLBACK');}catch{}throw e;}finally{db.release();}
 }
 return {changed,resolved};
}
function startVehicleDocumentMonitor(pool,{intervalMs=60000,logger=console}={}){
 let stopped=false,pending=null;
 const run=()=>{if(stopped||pending)return pending;pending=reconcileVehicleDocumentAlerts(pool).catch(()=>logger.error('Vehicle document alert reconciliation failed')).finally(()=>{pending=null;});return pending;};
 const timer=setInterval(run,intervalMs);timer.unref?.();void run();
 return async()=>{stopped=true;clearInterval(timer);if(pending)await pending;};
}
module.exports={roadAlert,reconcileVehicleDocumentAlerts,startVehicleDocumentMonitor};
