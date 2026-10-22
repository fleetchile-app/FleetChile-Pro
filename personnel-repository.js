const {writeAudit}=require('./audit');

const error=(status,message,code)=>Object.assign(new Error(message),{status,code});
const sameId=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const cleanDate=value=>value instanceof Date?`${String(value.getFullYear()).padStart(4,'0')}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`:value;
function civilDates(value,key=''){
 if(value instanceof Date)return /_date$|_expiry$/.test(key)?cleanDate(value):value;
 if(Array.isArray(value))return value.map(v=>civilDates(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,civilDates(v,k)]));
 return value;
}
function id(value,label='Identificador'){
 const s=String(value??'');
 if(!/^[1-9]\d*$/.test(s)||BigInt(s)>9223372036854775807n)throw error(400,`${label} no válido`);
 return s;
}
function reason(value){if(typeof value!=='string'||!value.trim()||value.trim().length>2000)throw error(400,'Indica un motivo de hasta 2000 caracteres');return value.trim();}
function todayIn(zone='America/Santiago',now=new Date()){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const get=type=>parts.find(p=>p.type===type).value;return `${get('year')}-${get('month')}-${get('day')}`;
}
async function policy(db,cid){
 const row=(await db.query('select company_id,enforced,time_zone,regularization_before,activated_by,activated_at from company_personnel_policies where company_id=$1',[cid])).rows[0];
 if(!row)throw error(409,'Falta la política de personas de esta empresa; solicita regularización de configuración');
 return row;
}
async function roles(db){return (await db.query("select id,code,name from roles where code in ('company_admin','manager','operations','maintenance','driver','viewer','administrative') order by name,id")).rows;}
async function companyRole(db,value){
 const rid=id(value,'Rol');const r=(await db.query("select id,code,name from roles where id=$1 and code in ('company_admin','manager','operations','maintenance','driver','viewer','administrative')",[rid])).rows[0];
 if(!r)throw error(400,'Rol empresarial no válido');return r;
}
async function person(db,cid,pid,{lock=false}={}){
 if(lock)await db.query(`select um.id from user_memberships um join company_people p on p.membership_id=um.id and p.company_id=um.company_id
  where p.company_id=$1 and p.id=$2 for update of um`,[cid,pid]);
 const p=(await db.query(`select p.*,p.birth_date::text birth_date,um.role_id,um.active membership_active,r.code role_code,r.name role_name,u.active account_active
 from company_people p left join user_memberships um on um.id=p.membership_id and um.company_id=p.company_id and um.user_id=p.user_id
 left join roles r on r.id=um.role_id left join users u on u.id=p.user_id
 where p.company_id=$1 and p.id=$2${lock?' for update of p':''}`,[cid,pid])).rows[0];
 if(!p)throw error(404,'Persona no encontrada');return p;
}
async function history(db,cid,pid,{events=true}={}){
 const contracts=(await db.query('select * from person_contracts where company_id=$1 and person_id=$2 order by start_date desc,id desc',[cid,pid])).rows;
 const conditions=(await db.query('select * from person_conditions where company_id=$1 and person_id=$2 order by start_date desc,id desc',[cid,pid])).rows;
 const licenses=(await db.query('select * from person_driver_licenses where company_id=$1 and person_id=$2 order by created_at desc,id desc',[cid,pid])).rows;
 const rows=events?(await db.query('select * from person_events where company_id=$1 and person_id=$2 order by created_at desc,id desc limit 200',[cid,pid])).rows:[];
 return {contracts,conditions,licenses,events:rows};
}
async function transaction(pool,cid,work){
 let db;try{
  db=await pool.connect();await db.query('BEGIN');
  const company=(await db.query('select id,user_limit,active from companies where id=$1 for update',[cid])).rows[0];
  if(!company||company.active!==true)throw error(404,'Empresa activa no encontrada');
  const result=await work(db,company);await db.query('COMMIT');return result;
 }catch(e){if(db)try{await db.query('ROLLBACK')}catch{}throw e;}finally{if(db)db.release();}
}
async function record(db,req,cid,pid,action,before,after,why=null){
 const actor=req.user;
 await db.query(`insert into person_events(company_id,person_id,actor_user_id,actor_name,action,before_data,after_data,reason)
 values($1,$2,$3,$4,$5,$6,$7,$8)`,[cid,pid,actor.id??actor.user_id,actor.name||'',action,civilDates(before),civilDates(after),why]);
 // Health conditions and personal identifiers stay in the scoped personnel event,
 // never copied into the general operational audit.
 await writeAudit(db,req,{companyId:cid,action,entity:'company_person',entityId:pid,
  beforeData:before?{person_id:pid}:null,afterData:{person_id:pid,action}});
}
async function notification(db,cid,pid,key,kind,message){
 await db.query(`insert into personnel_notifications(company_id,person_id,event_key,kind,message)
 values($1,$2,$3,$4,$5) on conflict(company_id,event_key) do nothing`,[cid,pid,key,kind,message]);
}
async function lists(db,cid,{restricted=false}={}){
 // Includes memberships with no person, inactive memberships and drafts. No
 // global users search or cross-company lateral selection is performed.
 const rows=(await db.query(`select p.id,coalesce(p.user_id,um.user_id) user_id,um.id membership_id,
 coalesce(p.name,${restricted?'d.name':'u.name'}) name,${restricted?"null::text":"u.email"} email,
 ${restricted?"null::text":"p.rut"} rut,${restricted?"null::date":"p.birth_date::text"} birth_date,
 ${restricted?"null::text":"p.job_title"} job_title,d.id driver_id,
 ${restricted?'false':'coalesce(p.contract_exempt,false)'} contract_exempt,
 ${restricted?'null::bigint':'p.exemption_by'} exemption_by,${restricted?'null::timestamptz':'p.exemption_at'} exemption_at,
 um.active membership_active,u.active account_active,um.created_at membership_created_at,u.created_at account_created_at,
 exists(select 1 from company_personnel_policies pp where pp.company_id=$1 and pp.enforced=false
  and um.created_at<=pp.regularization_before and u.created_at<=pp.regularization_before) regularization_eligible,
 r.code role_code,r.name role_name,
 ${restricted?"'[]'::json":"coalesce((select json_agg(c) from person_contracts c where c.company_id=$1 and c.person_id=p.id),'[]'::json)"} contracts,
 ${restricted?"'[]'::json":"coalesce((select json_agg(c) from person_conditions c where c.company_id=$1 and c.person_id=p.id),'[]'::json)"} conditions,
 coalesce((select json_agg(json_build_object('id',l.id,'classes',l.classes,'issued_date',l.issued_date,'printed_expiry',l.printed_expiry,'effective_expiry',l.effective_expiry,'current',l.current))
 from person_driver_licenses l where l.company_id=$1 and l.person_id=p.id),'[]'::json) licenses
 from (select * from user_memberships where company_id=$1) um
 full join (select * from company_people where company_id=$1) p on p.membership_id=um.id
 left join users u on u.id=coalesce(p.user_id,um.user_id)
 left join roles r on r.id=um.role_id
 left join drivers d on d.id=coalesce(p.driver_id,u.driver_id) and d.company_id=$1
 where ${restricted?"r.code='driver'":"true"} order by coalesce(p.id,um.id)`,[cid])).rows;
 return rows;
}
module.exports={error,id,reason,sameId,cleanDate,civilDates,todayIn,policy,roles,companyRole,person,history,transaction,record,notification,lists};
