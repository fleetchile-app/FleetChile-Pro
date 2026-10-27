'use strict';
const {writeAudit}=require('./audit');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
const id=v=>{if(!/^[1-9]\d*$/.test(String(v))||!Number.isSafeInteger(Number(v)))fail(400,'Identificador no válido');return Number(v)};
const reason=v=>{if(typeof v!=='string'||v.trim().length<5||v.length>1000||/[\x00-\x1f]/.test(v))fail(400,'Indica un motivo de 5 a 1000 caracteres');return v.trim()};
async function transaction(pool,cid,fn){let db;try{db=await pool.connect();await db.query('BEGIN');const c=(await db.query('select id from companies where id=$1 and active=true for no key update',[cid])).rows[0];if(!c)fail(404,'Empresa activa no encontrada');const result=await fn(db);await db.query('COMMIT');return result}catch(e){if(db)try{await db.query('ROLLBACK')}catch{}throw e}finally{db?.release()}}
async function event(db,req,cid,kind,entityId,why,before=null,after=null){await db.query('insert into enterprise_events(company_id,actor_id,actor_name,kind,entity_id,reason,before_data,after_data) values($1,$2,$3,$4,$5,$6,$7,$8)',[cid,req.user.id,req.user.name||'',kind,String(entityId),why,before,after]);await writeAudit(db,req,{companyId:cid,action:kind,entity:'enterprise_administration',entityId,afterData:{reason:why}})}
const wrap=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){const status=e.status||(e.code==='23505'?409:500);res.status(status).json({error:status===500?'No se pudo completar la operación empresarial':e.status?e.message:'Hay un registro duplicado; revisa los datos'})}};
module.exports={fail,id,reason,transaction,event,wrap};
